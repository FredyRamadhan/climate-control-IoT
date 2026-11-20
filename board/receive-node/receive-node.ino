#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <IRremoteESP8266.h>
#include <IRrecv.h>
#include <IRutils.h>
#include <ArduinoJson.h>
#include <time.h>
#include <string.h>
#include "secrets.h"

// ==========================================
// Hardware Pin Mapping (NodeMCU v2 / D1 mini)
// ==========================================
// This node has no relay output. It only decodes IR, drives the blower PWM,
// lights a local AC-power status LED, and publishes state over MQTT.
#define PIN_IR_RECV   14  // D5 (GPIO14) - VS1838B IR receiver OUT
#define PIN_LED       13  // D7 (GPIO13) - AC power status LED
#define PIN_FAN       5   // D1 (GPIO5)  - 2N2222 NPN transistor Base (PWM speed control)

// Fan PWM Duty Cycle values (0..1023 on ESP8266)
#define FAN_PWM_OFF   0
#define FAN_PWM_LOW   341   // ~33% duty cycle (low speed)
#define FAN_PWM_MED   682   // ~67% duty cycle (medium speed)
#define FAN_PWM_HIGH  1023  // 100% duty cycle (high speed)

// ==========================================
// Constants & Configuration
// ==========================================
#define MQTT_TOPIC_STATE     "receive/state"
#define MQTT_TOPIC_STATUS    "receive/status"

#define WIFI_RETRY_MS        10000UL
#define MQTT_RETRY_MS        10000UL
#define STATE_MIN_PUBLISH_MS 1000UL   // De-duplicate repeated identical frames
#define FW_VERSION "2.2.0-rx"
#define TCP_TIMEOUT_MS 500UL
#define IR_QUIET_MS 150UL
// Enable only after a bench test proves low/medium cannot start unaided.
#ifndef FAN_START_BOOST_MS
#define FAN_START_BOOST_MS 0UL
#endif

// ==========================================
// IR Protocol (must match transmit-node)
// ==========================================
//   byte 3 : 0xA1 (protocol header)
//   byte 2 : relay bit (bit 7), 5-bit checksum (bits 6..2), fan (bits 1..0)
//   byte 1 : target temperature in °C (16..30)
//   byte 0 : ~byte 1 (NEC command integrity byte)
#define AC_IR_HEADER          0xA1
#define AC_IR_RELAY_BIT       0x80
#define AC_IR_FAN_MASK        0x03
#define AC_IR_CRC_SHIFT       2
#define AC_IR_CRC_MASK        0x1F
#define AC_IR_MIN_TEMP        16
#define AC_IR_MAX_TEMP        30

enum FanSpeed : uint8_t {
  FAN_OFF = 0,
  FAN_LOW = 1,
  FAN_MEDIUM = 2,
  FAN_HIGH = 3
};

const char* fanSpeedToString(FanSpeed speed) {
  switch (speed) {
    case FAN_LOW:    return "low";
    case FAN_MEDIUM: return "medium";
    case FAN_HIGH:   return "high";
    case FAN_OFF:
    default:         return "off";
  }
}

// ==========================================
// Global Instances & State
// ==========================================
WiFiClient espClient;
PubSubClient mqttClient(espClient);
IRrecv irReceiver(PIN_IR_RECV);
decode_results results;

bool acPowerState = false;
uint8_t targetTempC = 24;
FanSpeed fanSpeed = FAN_OFF;
uint16_t fanPwm = FAN_PWM_OFF;
bool stateValid = false;
FanSpeed receivedFanSpeed = FAN_OFF;
bool motorOverride = false;
bool boostActive = false;
unsigned long boostStartedMs = 0;
bool statePending = false;
const char* pendingSource = "boot";
unsigned long lastPublishAttemptMs = 0;
unsigned long lastIrActivityMs = 0;

void queueState(const char* source) {
  statePending = true;
  pendingSource = source;
}

unsigned long lastStatePublishMs = 0;
unsigned long lastWifiAttemptMs = 0;
unsigned long lastMqttAttemptMs = 0;

// NTP configuration for Unix epoch timestamps
const char* ntpServer = "pool.ntp.org";
const long  gmtOffset_sec = 0;
const int   daylightOffset_sec = 0;

// ==========================================
// Helpers
// ==========================================
uint32_t getTimestamp() {
  time_t now = time(nullptr);
  // 2023-11-14; anything earlier means NTP has not synchronised yet.
  return (now > 1700000000) ? (uint32_t)now : 0;
}

void setPowerIndicator(bool state) {
  digitalWrite(PIN_LED, state ? HIGH : LOW);
}

void setFanSpeed(FanSpeed speed) {
  uint16_t pwm = FAN_PWM_OFF;
  switch (speed) {
    case FAN_LOW:
      pwm = FAN_PWM_LOW;
      break;
    case FAN_MEDIUM:
      pwm = FAN_PWM_MED;
      break;
    case FAN_HIGH:
      pwm = FAN_PWM_HIGH;
      break;
    case FAN_OFF:
    default:
      pwm = FAN_PWM_OFF;
      break;
  }

  bool starting = fanSpeed == FAN_OFF && speed != FAN_OFF && speed != FAN_HIGH;
  bool changed = fanSpeed != speed;
  if (changed) {
    boostActive = starting && FAN_START_BOOST_MS > 0;
    boostStartedMs = millis();
  }
  fanSpeed = speed;
  fanPwm = boostActive ? FAN_PWM_HIGH : pwm;
  // Avoid rewriting the PWM generator for every identical IR heartbeat.
  // Off/high are static outputs and do not require a PWM timer.
  if (changed || speed == FAN_OFF) {
    if (fanPwm == FAN_PWM_OFF || fanPwm == FAN_PWM_HIGH)
      digitalWrite(PIN_FAN, fanPwm ? HIGH : LOW);
    else
      analogWrite(PIN_FAN, fanPwm);
  }

  if (changed) {
    Serial.print("[Fan] Speed set to ");
    Serial.print(fanSpeedToString(speed));
    Serial.print(" (PWM: ");
    Serial.print(fanPwm);
    Serial.println("/1023)");
  }
}

void maintainFan() {
  if (!boostActive || millis() - boostStartedMs < FAN_START_BOOST_MS) return;
  boostActive = false;
  fanPwm = fanSpeed == FAN_LOW ? FAN_PWM_LOW : FAN_PWM_MED;
  analogWrite(PIN_FAN, fanPwm);
  queueState("motor-boost-complete");
}

void handleMotorCommand(const char* command) {
  if (strcmp(command, "motor release") == 0) {
    motorOverride = false;
    setFanSpeed(stateValid ? receivedFanSpeed : FAN_OFF);
    Serial.println("[Motor] IR control restored.");
  } else {
    FanSpeed speed;
    if (strcmp(command, "motor off") == 0) speed = FAN_OFF;
    else if (strcmp(command, "motor low") == 0) speed = FAN_LOW;
    else if (strcmp(command, "motor medium") == 0) speed = FAN_MEDIUM;
    else if (strcmp(command, "motor high") == 0) speed = FAN_HIGH;
    else {
      Serial.println("[Motor] Use motor off|low|medium|high|release");
      return;
    }
    motorOverride = true;
    setFanSpeed(speed);
    Serial.println("[Motor] Manual control active; IR capture continues.");
  }
  queueState("serial-motor");
}

void pollSerial() {
  static char line[32];
  static size_t length = 0;
  static bool overflow = false;
  // Bound work per loop; never wait for a newline.
  for (uint8_t n = 0; n < 32 && Serial.available(); ++n) {
    char c = Serial.read();
    if (c == '\r' || c == '\n') {
      if (overflow) Serial.println("[Motor] Command too long; ignored.");
      else if (length) {
        line[length] = '\0';
        handleMotorCommand(line);
      }
      length = 0;
      overflow = false;
    } else if (length < sizeof(line) - 1 && !overflow) line[length++] = c;
    else overflow = true;
  }
}

bool decodeAcFrame(uint32_t rawValue, bool &outPowerOn, uint8_t &outTargetTemp,
                   FanSpeed &outFanSpeed) {
  uint8_t header = (rawValue >> 24) & 0xFF;
  uint8_t flags = (rawValue >> 16) & 0xFF;
  uint8_t tempByte = (rawValue >> 8) & 0xFF;
  uint8_t invertedTemp = rawValue & 0xFF;

  if (header != AC_IR_HEADER) {
    Serial.println("[IR] Wrong AC header.");
    return false;
  }

  // NEC command integrity byte.
  if ((uint8_t)(~tempByte) != invertedTemp) {
    Serial.println("[IR] Checksum failed (temperature byte).");
    return false;
  }

  if (tempByte < AC_IR_MIN_TEMP || tempByte > AC_IR_MAX_TEMP) {
    Serial.println("[IR] Temperature outside supported range.");
    return false;
  }

  uint8_t fanCode = flags & AC_IR_FAN_MASK;
  uint8_t flagsWithoutCrc = flags & (AC_IR_RELAY_BIT | AC_IR_FAN_MASK);
  uint8_t receivedCrc = (flags >> AC_IR_CRC_SHIFT) & AC_IR_CRC_MASK;
  uint8_t expectedCrc = (AC_IR_HEADER ^ flagsWithoutCrc ^ tempByte) & AC_IR_CRC_MASK;

  if (receivedCrc != expectedCrc) {
    Serial.println("[IR] Checksum failed (frame).");
    return false;
  }

  outPowerOn = (flags & AC_IR_RELAY_BIT) != 0;
  outTargetTemp = tempByte;
  outFanSpeed = (FanSpeed)fanCode;
  return true;
}

void publishState(const char* source) {
  if (!mqttClient.connected()) {
    return;
  }

  JsonDocument doc;
  doc["ac_power_state"] = acPowerState;
  doc["temp"] = (float)targetTempC;
  doc["fan_speed"] = fanSpeedToString(fanSpeed);
  doc["fan_pwm"] = fanPwm;
  doc["timestamp"] = getTimestamp();
  doc["state_valid"] = stateValid;
  doc["source"] = source;
  doc["motor_override"] = motorOverride;
  doc["ir_fan_speed"] = fanSpeedToString(receivedFanSpeed);

  char jsonBuffer[384];
  if (measureJson(doc) >= sizeof(jsonBuffer)) {
    Serial.println("[MQTT] State exceeds JSON buffer.");
    return;
  }
  size_t length = serializeJson(doc, jsonBuffer, sizeof(jsonBuffer));
  if (length == 0) {
    Serial.println("[MQTT] Failed to serialize state (buffer too small).");
    return;
  }

  bool published = mqttClient.publish(MQTT_TOPIC_STATE, jsonBuffer, true);
  if (published) {
    lastStatePublishMs = millis();
    statePending = false;
  }

  Serial.print("[MQTT] ");
  Serial.print(MQTT_TOPIC_STATE);
  Serial.print(published ? " -> " : " FAILED -> ");
  Serial.println(jsonBuffer);
}

void applyDecodedState(bool powerOn, uint8_t tempC, FanSpeed fan) {
  bool changed = !stateValid ||
                 (powerOn != acPowerState) ||
                 (tempC != targetTempC) ||
                 (fan != receivedFanSpeed);

  acPowerState = powerOn;
  targetTempC = tempC;
  stateValid = true;
  receivedFanSpeed = fan;

  setPowerIndicator(acPowerState);
  if (!motorOverride) setFanSpeed(fan);

  Serial.print("[AC] power=");
  Serial.print(acPowerState ? "on" : "off");
  Serial.print(" temp=");
  Serial.print(targetTempC);
  Serial.print("C fan=");
  Serial.println(fanSpeedToString(fanSpeed));

  unsigned long now = millis();
  if (changed || (now - lastStatePublishMs >= STATE_MIN_PUBLISH_MS)) {
    queueState(changed ? "ir-change" : "ir-heartbeat");
  }
}

void setupWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  // Keep the modem awake so MQTT keepalive pings are not delayed.
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  WiFi.hostname("climate-receive");

  Serial.print("[WiFi] Connecting to: ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  unsigned long now = millis();
  if (now - lastWifiAttemptMs < WIFI_RETRY_MS) {
    return;
  }
  lastWifiAttemptMs = now;

  Serial.print("[WiFi] Reconnecting to: ");
  Serial.println(WIFI_SSID);
  // Do not call WiFi.disconnect() here: it aborts an association that may
  // still be in progress on a weak signal. Just restart the attempt.
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void maintainMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqttClient.connected()) {
    return;
  }

  unsigned long now = millis();
  if (now - lastMqttAttemptMs < MQTT_RETRY_MS) {
    return;
  }
  lastMqttAttemptMs = now;

  String clientId = "climate-rx-" + String(ESP.getChipId(), HEX);

  Serial.print("[MQTT] Connecting to ");
  Serial.print(MQTT_HOST);
  Serial.print(":");
  Serial.print(MQTT_PORT);
  Serial.print(" as ");
  Serial.println(clientId);

  bool connected = mqttClient.connect(
      clientId.c_str(), MQTT_USER, MQTT_PASS,
      MQTT_TOPIC_STATUS, 1, true, "{\"online\":false}");
  Serial.printf("[MQTT] Connect took %lu ms\n", millis() - now);

  if (connected) {
    Serial.println("[MQTT] Connected.");
    mqttClient.publish(MQTT_TOPIC_STATUS, "{\"online\":true}", true);
    // Publish current (possibly default/not-yet-synced) state so dashboards
    // receive something immediately after a broker/connection restart.
    if (!statePending) queueState("mqtt-connected");
  } else {
    Serial.print("[MQTT] Connection failed, rc=");
    Serial.print(mqttClient.state());
    Serial.println(". Will retry.");
  }
}

// ==========================================
// Arduino lifecycle
// ==========================================
void setup() {
  pinMode(PIN_FAN, OUTPUT);
  digitalWrite(PIN_FAN, LOW);
  Serial.begin(115200);
  delay(100);

  Serial.println();
  Serial.println("--- IoT Climate Control: Receiver / AC Feedback + Blower ---");
  Serial.printf("[Boot] FW=%s core=%s SDK=%s IR=%s\n", FW_VERSION,
                ESP.getCoreVersion().c_str(), ESP.getSdkVersion(), _IRREMOTEESP8266_VERSION_STR);
  Serial.printf("[Boot] ArduinoJson=%s PubSubClient=2.8 (validated baseline)\n", ARDUINOJSON_VERSION);
  Serial.print("[Boot] Reset: ");
  Serial.println(ESP.getResetReason());
  Serial.printf("[Boot] IR=D5/GPIO%d motor=D1/GPIO%d LED=D7/GPIO%d PWM=1000Hz/1023 boost=%lums\n",
                PIN_IR_RECV, PIN_FAN, PIN_LED, (unsigned long)FAN_START_BOOST_MS);
  Serial.println("[Boot] Motor OFF. Serial: motor off|low|medium|high|release");

  pinMode(PIN_LED, OUTPUT);
  setPowerIndicator(false);

  pinMode(PIN_FAN, OUTPUT);
  analogWriteRange(1023);
  analogWriteFreq(1000);
  setFanSpeed(FAN_OFF);

  irReceiver.enableIRIn();

  setupWifi();
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer, "time.google.com");

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setBufferSize(512);
  mqttClient.setKeepAlive(15);
  mqttClient.setSocketTimeout(3);
  // Core 3.1.2 uses Stream's timeout for DNS, TCP connect and writes.
  espClient.setTimeout(TCP_TIMEOUT_MS);

  lastWifiAttemptMs = millis();
  lastMqttAttemptMs = millis() - MQTT_RETRY_MS;
}

void loop() {
  // Drain capture before local commands and network work. Network calls can
  // still delay decoding; resuming here is not a guarantee of lossless capture.
  if (irReceiver.decode(&results)) {
    // Copy what we need, then resume reception before any slow MQTT publish.
    uint64_t rawValue = results.value;
    uint16_t bitCount = results.bits;
    bool isRepeat = results.repeat;
    bool overflow = results.overflow;
    decode_type_t protocol = results.decode_type;
    irReceiver.resume();
    lastIrActivityMs = millis();
    Serial.printf("[IR] capture protocol=%s bits=%u repeat=%u overflow=%u value=0x%08lX%08lX\n",
                  typeToString(protocol).c_str(), bitCount, isRepeat, overflow,
                  (unsigned long)(rawValue >> 32), (unsigned long)rawValue);

    if (!overflow && !isRepeat && bitCount == 32 &&
        (protocol == decode_type_t::NEC || protocol == decode_type_t::NEC_LIKE)) {
      uint32_t frame = (uint32_t)rawValue;
      char hexBuffer[11];
      snprintf(hexBuffer, sizeof(hexBuffer), "0x%08lX", (unsigned long)frame);
      Serial.print("[IR] RX ");
      Serial.println(hexBuffer);

      bool powerOn = false;
      uint8_t tempC = 24;
      FanSpeed fan = FAN_OFF;

      if (decodeAcFrame(frame, powerOn, tempC, fan)) {
        applyDecodedState(powerOn, tempC, fan);
      } else {
        Serial.println("[IR] Ignoring frame that is not a valid AC command.");
      }
    } else {
      Serial.println("[IR] Ignored: repeat, overflow, unsupported protocol or bit count.");
    }
  }

  pollSerial();
  maintainFan();
  // The library has no public capture-active API. A recently observed LOW or
  // completed capture conservatively defers networking across NEC gaps/repeats.
  // An edge arriving after this check can still overlap a synchronous MQTT call.
  if (digitalRead(PIN_IR_RECV) == LOW) lastIrActivityMs = millis();
  if (boostActive || millis() - lastIrActivityMs < IR_QUIET_MS) {
    yield();
    return;
  }
  unsigned long networkStartedMs = millis();
  maintainWifi();
  if (WiFi.status() == WL_CONNECTED) {
    maintainMqtt();
  }
  mqttClient.loop();
  if (statePending && mqttClient.connected() &&
      millis() - lastPublishAttemptMs >= STATE_MIN_PUBLISH_MS) {
    lastPublishAttemptMs = millis();
    publishState(pendingSource);
  }
  unsigned long networkMs = millis() - networkStartedMs;
  if (networkMs >= 100) Serial.printf("[Network] Loop stalled %lu ms\n", networkMs);
}
