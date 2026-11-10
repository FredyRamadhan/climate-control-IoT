#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <IRremoteESP8266.h>
#include <IRsend.h>
#include <ArduinoJson.h>
#include <math.h>
#include <time.h>
#include "secrets.h"

// ==========================================
// Hardware Pin Mapping (NodeMCU v2 / D1 mini)
// ==========================================
#define PIN_PIR       14  // D5 (GPIO14) - HC-SR501 PIR sensor
#define PIN_DHT       2   // D4 (GPIO2)  - DHT11 sensor
#define PIN_IR_EMIT   4   // D2 (GPIO4)  - KY-005 IR LED emitter
#define PIN_LED       16  // D0 (GPIO16) - Motion status indicator LED

// ==========================================
// Constants & Configuration
// ==========================================
#define DHTTYPE               DHT11
#define SAMPLE_INTERVAL_MS    5000UL    // Sensor sampling / MQTT publish interval
#define PIR_POLL_MS           100UL     // Poll PIR frequently so short motion is not missed
#define PIR_WARMUP_MS         30000UL   // HC-SR501 stabilisation time after power-up

#define MQTT_TOPIC_DATA       "transmit/data"
#define MQTT_TOPIC_STATUS     "transmit/status"

// Rule windows from plan.md
#define MOTION_RECENT_MS      300000UL  // 5 minutes
#define MOTION_IDLE_MS        600000UL  // 10 minutes

// Re-send the same IR state periodically so a receiver that rebooted/missed a
// frame can resynchronise. State changes are always sent immediately.
#define IR_HEARTBEAT_MS       60000UL

#define WIFI_RETRY_MS         10000UL
#define MQTT_RETRY_MS         10000UL

// ==========================================
// IR Protocol
// ==========================================
// 32-bit NEC-compatible frame. Byte 0 is the inverse of byte 1, which is
// required by the strict NEC decoder in IRremoteESP8266.
//
//   byte 3 : 0xA1 (protocol header)
//   byte 2 : relay bit (bit 7), 5-bit checksum (bits 6..2), fan (bits 1..0)
//   byte 1 : target temperature in °C (16..30)
//   byte 0 : ~byte 1 (NEC command integrity byte)
//
// Fan codes: 0 = off, 1 = low, 2 = medium, 3 = high
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
DHT dht(PIN_DHT, DHTTYPE);
IRsend irSender(PIN_IR_EMIT);

// Rule engine state
bool relayOn = false;                 // AC power relay state (also sent via IR)
uint8_t targetTempC = 24;             // AC target/setpoint temperature
FanSpeed fanSpeed = FAN_OFF;

bool motionEverSeen = false;
bool motionSinceLastSample = false;
unsigned long lastMotionMs = 0;
unsigned long lastPirPollMs = 0;

// Sensor state. Last good readings are kept if a DHT read fails.
float lastTempC = 24.0f;
float lastHum = 50.0f;

// Timers
unsigned long bootMillis = 0;
unsigned long lastSampleMs = 0;
unsigned long lastIrSendMs = 0;
unsigned long lastWifiAttemptMs = 0;
unsigned long lastMqttAttemptMs = 0;
bool lastIrValid = false;
uint32_t lastIrFrame = 0;

// NTP configuration for Unix epoch timestamps
const char* ntpServer = "pool.ntp.org";
const long  gmtOffset_sec = 0;
const int   daylightOffset_sec = 0;

// ==========================================
// Helpers
// ==========================================
float round1(float value) {
  return roundf(value * 10.0f) / 10.0f;
}

uint32_t getTimestamp() {
  time_t now = time(nullptr);
  // 2023-11-14; anything earlier means NTP has not synchronised yet.
  return (now > 1700000000) ? (uint32_t)now : 0;
}

bool motionWithin(unsigned long windowMs) {
  if (!motionEverSeen) {
    return false;
  }
  return (millis() - lastMotionMs) <= windowMs;
}

uint32_t buildIrFrame() {
  uint8_t flags = (relayOn ? AC_IR_RELAY_BIT : 0x00) | (fanSpeed & AC_IR_FAN_MASK);
  uint8_t crc = (AC_IR_HEADER ^ flags ^ targetTempC) & AC_IR_CRC_MASK;

  return ((uint32_t)AC_IR_HEADER << 24) |
         ((uint32_t)(flags | (crc << AC_IR_CRC_SHIFT)) << 16) |
         ((uint32_t)targetTempC << 8) |
         (uint32_t)(uint8_t)(~targetTempC);
}

void printIrFrame(uint32_t frame) {
  char hexStr[11];
  snprintf(hexStr, sizeof(hexStr), "0x%08X", frame);
  Serial.print(hexStr);
}

// Returns true when a frame was actually transmitted.
bool sendIrIfNeeded(bool force) {
  uint32_t frame = buildIrFrame();
  unsigned long now = millis();

  bool changed = !lastIrValid || (frame != lastIrFrame);
  bool heartbeatDue = lastIrValid && (now - lastIrSendMs >= IR_HEARTBEAT_MS);

  if (!force && !changed && !heartbeatDue) {
    return false;
  }

  // One repeat improves reliability with the KY-005; the receiver ignores
  // NEC repeat frames, so this cannot be mistaken for a state change.
  irSender.sendNEC(frame, 32, 1);

  lastIrFrame = frame;
  lastIrValid = true;
  lastIrSendMs = now;

  Serial.print("[IR] TX ");
  printIrFrame(frame);
  Serial.print(" relay=");
  Serial.print(relayOn ? "on" : "off");
  Serial.print(" temp=");
  Serial.print(targetTempC);
  Serial.print("C fan=");
  Serial.println(fanSpeedToString(fanSpeed));

  return true;
}

void applyControlRules(bool motion, float tempC, float hum) {
  bool prevRelay = relayOn;
  uint8_t prevTarget = targetTempC;
  FanSpeed prevFan = fanSpeed;

  bool recent5 = motionWithin(MOTION_RECENT_MS);
  bool recent10 = motionWithin(MOTION_IDLE_MS);

  // Rule 1: motion detected and relay off -> relay on.
  if (motion && !relayOn) {
    relayOn = true;
  }

  // Rule 5: no motion for 10 minutes -> relay off.
  if (!recent10) {
    relayOn = false;
  }

  // Temperature rules. Rule 2 has priority over rule 4 during the 5-10 minute
  // grace window; this avoids raising the setpoint while someone just left.
  if (recent10 && tempC < 24.0f) {
    // Rule 2: motion within 10 min and temp < 24 -> do nothing.
  } else if (recent5 && tempC > 24.0f) {
    // Rule 3: motion within 5 min and temp > 24 -> target 21 C.
    targetTempC = 21;
  } else if (!recent5 && tempC < 24.0f) {
    // Rule 4: no motion for 5 min and temp < 24 -> target 24 C.
    // With the priority above this effectively runs after the 10 minute idle
    // window, resetting the setpoint for the next occupied period.
    targetTempC = 24;
  }

  // Fan rules. Fan only runs while the AC relay is on and motion was recent.
  if (!relayOn) {
    fanSpeed = FAN_OFF;
  } else if (recent5) {
    if (hum < 50.0f) {
      // Rule 6: motion within 5 min and hum < 50% -> fan off.
      fanSpeed = FAN_OFF;
    } else if (hum > 50.0f) {
      // Rule 7: motion within 5 min and hum > 50% -> fan high.
      fanSpeed = FAN_HIGH;
    }
  }

  if (relayOn != prevRelay || targetTempC != prevTarget || fanSpeed != prevFan) {
    Serial.print("[Rules] relay=");
    Serial.print(relayOn ? "on" : "off");
    Serial.print(" target=");
    Serial.print(targetTempC);
    Serial.print("C fan=");
    Serial.print(fanSpeedToString(fanSpeed));
    Serial.print(" (recent5=");
    Serial.print(recent5 ? "yes" : "no");
    Serial.print(", recent10=");
    Serial.print(recent10 ? "yes" : "no");
    Serial.println(")");
  }
}

void publishTelemetry(bool motion, float tempC, float hum, bool sensorOk,
                      bool irSent, bool warmup) {
  if (!mqttClient.connected()) {
    return;
  }

  JsonDocument doc;
  doc["motion"] = motion;
  doc["temp"] = round1(tempC);          // measured room temperature
  doc["hum"] = round1(hum);
  doc["timestamp"] = getTimestamp();
  doc["fan_speed"] = fanSpeedToString(fanSpeed);
  doc["relay_on"] = relayOn;
  doc["target_temp"] = targetTempC;     // value transmitted via IR
  doc["sensor_ok"] = sensorOk;
  doc["ir_sent"] = irSent;
  doc["uptime_ms"] = millis();
  if (warmup) {
    doc["warmup"] = true;
  }
  if (irSent) {
    char irCode[11];
    snprintf(irCode, sizeof(irCode), "0x%08X", lastIrFrame);
    doc["ir_code"] = irCode;
  }

  char jsonBuffer[384];
  size_t length = serializeJson(doc, jsonBuffer, sizeof(jsonBuffer));
  if (length == 0) {
    Serial.println("[MQTT] Failed to serialize telemetry (buffer too small).");
    return;
  }

  bool published = mqttClient.publish(MQTT_TOPIC_DATA, jsonBuffer, false);
  Serial.print("[MQTT] ");
  Serial.print(MQTT_TOPIC_DATA);
  Serial.print(published ? " -> " : " FAILED -> ");
  Serial.println(jsonBuffer);
}

void setupWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.hostname("climate-transmit");

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

  String clientId = "climate-tx-" + String(ESP.getChipId(), HEX);

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
  delay(1000);  // DHT11 needs ~1 s after power-up before the first read.

  Serial.println();
  Serial.println("--- IoT Climate Control: Transmitter / Remote Node ---");

  bootMillis = millis();
  lastPirPollMs = bootMillis;
  lastSampleMs = bootMillis - SAMPLE_INTERVAL_MS;

  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);

  dht.begin();
  irSender.begin();

  // Publish the initial known state to the receiver (relay off, 24 C, fan off).
  sendIrIfNeeded(true);

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
  unsigned long now = millis();

  // Poll the PIR independently from the slower sensor/MQTT cadence. Do this
  // before network work so a blocked MQTT call cannot hide a motion event.
  if (now - lastPirPollMs >= PIR_POLL_MS) {
    lastPirPollMs = now;
    bool pirHigh = (digitalRead(PIN_PIR) == HIGH);
    digitalWrite(PIN_LED, pirHigh ? HIGH : LOW);
    if (pirHigh) {
      lastMotionMs = now;
      motionEverSeen = true;
      motionSinceLastSample = true;
    }
  }

  maintainWifi();
  if (WiFi.status() == WL_CONNECTED) {
    maintainMqtt();
  }
  mqttClient.loop();

  now = millis();
  if (now - lastSampleMs < SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSampleMs = now;

  bool motion = motionSinceLastSample;
  motionSinceLastSample = false;

  float tempReading = dht.readTemperature();
  float humReading = dht.readHumidity();
  bool tempOk = !isnan(tempReading);
  bool humOk = !isnan(humReading);

  if (tempOk) {
    lastTempC = tempReading;
  }
  if (humOk) {
    lastHum = humReading;
  }
  bool sensorOk = tempOk && humOk;

  bool warmup = (now - bootMillis) < PIR_WARMUP_MS;
  if (!warmup) {
    applyControlRules(motion, lastTempC, lastHum);
  }

  bool irSent = sendIrIfNeeded(false);
  publishTelemetry(motion, lastTempC, lastHum, sensorOk, irSent, warmup);
}
