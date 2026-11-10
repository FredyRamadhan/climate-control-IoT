#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <IRremoteESP8266.h>
#include <IRrecv.h>
#include <IRutils.h>
#include <ArduinoJson.h>
#include <time.h>
#include "secrets.h"

// ==========================================
// Hardware Pin Mapping (NodeMCU v2 / D1 mini)
// ==========================================
#define PIN_IR_RECV   14  // D5 (GPIO14) - VS1838B IR receiver OUT
#define PIN_RELAY     12  // D6 (GPIO12) - 250 VAC opto-isolated relay IN
#define PIN_LED       13  // D7 (GPIO13) - Status LED (mirrors relay state)

// Most opto-isolated relay boards are active-LOW. Set false for active-HIGH.
#define RELAY_ACTIVE_LOW true

// ==========================================
// Constants & Configuration
// ==========================================
#define MQTT_TOPIC_STATE     "receive/state"
#define MQTT_TOPIC_STATUS    "receive/status"

#define WIFI_RETRY_MS        10000UL
#define MQTT_RETRY_MS        10000UL
#define STATE_MIN_PUBLISH_MS 1000UL   // De-duplicate repeated identical frames

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
bool stateValid = false;

bool relayState = false;
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

void setRelay(bool state) {
  bool changed = (state != relayState);

  relayState = state;
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(PIN_RELAY, state ? LOW : HIGH);
  } else {
    digitalWrite(PIN_RELAY, state ? HIGH : LOW);
  }
  digitalWrite(PIN_LED, state ? HIGH : LOW);

  if (changed) {
    Serial.print("[Relay] ");
    Serial.println(state ? "ON" : "OFF");
  }
}

bool decodeAcFrame(uint32_t rawValue, bool &outPowerOn, uint8_t &outTargetTemp,
                   FanSpeed &outFanSpeed) {
  uint8_t header = (rawValue >> 24) & 0xFF;
  uint8_t flags = (rawValue >> 16) & 0xFF;
  uint8_t tempByte = (rawValue >> 8) & 0xFF;
  uint8_t invertedTemp = rawValue & 0xFF;

  if (header != AC_IR_HEADER) {
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
  doc["timestamp"] = getTimestamp();
  doc["state_valid"] = stateValid;
  doc["source"] = source;

  char jsonBuffer[256];
  size_t length = serializeJson(doc, jsonBuffer, sizeof(jsonBuffer));
  if (length == 0) {
    Serial.println("[MQTT] Failed to serialize state (buffer too small).");
    return;
  }

  bool published = mqttClient.publish(MQTT_TOPIC_STATE, jsonBuffer, true);
  lastStatePublishMs = millis();

  Serial.print("[MQTT] ");
  Serial.print(MQTT_TOPIC_STATE);
  Serial.print(published ? " -> " : " FAILED -> ");
  Serial.println(jsonBuffer);
}

void applyDecodedState(bool powerOn, uint8_t tempC, FanSpeed fan) {
  bool changed = !stateValid ||
                 (powerOn != acPowerState) ||
                 (tempC != targetTempC) ||
                 (fan != fanSpeed);

  acPowerState = powerOn;
  targetTempC = tempC;
  fanSpeed = fan;
  stateValid = true;

  setRelay(acPowerState);

  Serial.print("[AC] power=");
  Serial.print(acPowerState ? "on" : "off");
  Serial.print(" temp=");
  Serial.print(targetTempC);
  Serial.print("C fan=");
  Serial.println(fanSpeedToString(fanSpeed));

  unsigned long now = millis();
  if (changed || (now - lastStatePublishMs >= STATE_MIN_PUBLISH_MS)) {
    publishState(changed ? "ir-change" : "ir-heartbeat");
  }
}

void setupWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
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
  WiFi.disconnect();
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

  if (connected) {
    Serial.println("[MQTT] Connected.");
    mqttClient.publish(MQTT_TOPIC_STATUS, "{\"online\":true}", true);
    // Publish current (possibly default/not-yet-synced) state so dashboards
    // receive something immediately after a broker/connection restart.
    publishState("mqtt-connected");
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
  Serial.begin(115200);
  delay(100);

  Serial.println();
  Serial.println("--- IoT Climate Control: Receiver / AC Emulator ---");

  pinMode(PIN_RELAY, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  setRelay(false);

  irReceiver.enableIRIn();

  setupWifi();
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer, "time.google.com");

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setBufferSize(512);
  mqttClient.setKeepAlive(15);
  mqttClient.setSocketTimeout(3);

  lastWifiAttemptMs = millis();
  lastMqttAttemptMs = millis() - MQTT_RETRY_MS;
}

void loop() {
  // Decode IR first. The receiver is resumed before any MQTT publish, so a
  // slow network operation cannot make us miss the next IR frame.
  if (irReceiver.decode(&results)) {
    // Copy what we need, then resume reception before any slow MQTT publish.
    uint64_t rawValue = results.value;
    uint16_t bitCount = results.bits;
    bool isRepeat = results.repeat;
    decode_type_t protocol = results.decode_type;
    irReceiver.resume();

    if (!isRepeat && bitCount == 32 &&
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
    }
  }

  maintainWifi();
  if (WiFi.status() == WL_CONNECTED) {
    maintainMqtt();
  }
  mqttClient.loop();
}
