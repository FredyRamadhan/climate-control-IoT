#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <IRremoteESP8266.h>
#include <IRsend.h>
#include <ArduinoJson.h>
#include <ctype.h>
#include <math.h>
#include <stdlib.h>
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
#define MQTT_TOPIC_CMD        "transmit/command"
#define MQTT_TOPIC_CMD_ACK    "transmit/command/ack"

// Rule windows from plan.md
#define MOTION_RECENT_MS      300000UL  // 5 minutes
#define MOTION_IDLE_MS        600000UL  // 10 minutes

// Manual override defaults
#define OVERRIDE_DEFAULT_SEC  60UL      // duration used when duration_s is omitted
#define OVERRIDE_MAX_SEC      86400UL   // reject durations longer than 24 hours
#define COMMAND_BUFFER_SIZE   384       // max JSON command size accepted over MQTT

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

// Manual override state
bool overrideActive = false;
bool overrideIndefinite = false;
unsigned long overrideStartMs = 0;
uint32_t overrideDurationMs = 0;
const char* overrideSource = nullptr;

// Pending MQTT command. The callback only copies the payload; the main loop
// parses and applies it so IR transmission never happens inside the callback.
char pendingCommand[COMMAND_BUFFER_SIZE];
bool pendingCommandReady = false;
bool pendingCommandOverflow = false;

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

bool decodeAcFrame(uint32_t rawValue, bool &outPowerOn, uint8_t &outTargetTemp,
                   FanSpeed &outFanSpeed) {
  uint8_t header = (rawValue >> 24) & 0xFF;
  uint8_t flags = (rawValue >> 16) & 0xFF;
  uint8_t tempByte = (rawValue >> 8) & 0xFF;
  uint8_t invertedTemp = rawValue & 0xFF;

  if (header != AC_IR_HEADER) {
    return false;
  }
  if ((uint8_t)(~tempByte) != invertedTemp) {
    return false;
  }
  if (tempByte < AC_IR_MIN_TEMP || tempByte > AC_IR_MAX_TEMP) {
    return false;
  }

  uint8_t flagsWithoutCrc = flags & (AC_IR_RELAY_BIT | AC_IR_FAN_MASK);
  uint8_t receivedCrc = (flags >> AC_IR_CRC_SHIFT) & AC_IR_CRC_MASK;
  uint8_t expectedCrc = (AC_IR_HEADER ^ flagsWithoutCrc ^ tempByte) & AC_IR_CRC_MASK;
  if (receivedCrc != expectedCrc) {
    return false;
  }

  outPowerOn = (flags & AC_IR_RELAY_BIT) != 0;
  outTargetTemp = tempByte;
  outFanSpeed = (FanSpeed)(flags & AC_IR_FAN_MASK);
  return true;
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

bool parseFanSpeed(const char* value, FanSpeed &outSpeed) {
  if (value == nullptr) {
    return false;
  }
  if (strcmp(value, "off") == 0) {
    outSpeed = FAN_OFF;
    return true;
  }
  if (strcmp(value, "low") == 0) {
    outSpeed = FAN_LOW;
    return true;
  }
  if (strcmp(value, "medium") == 0) {
    outSpeed = FAN_MEDIUM;
    return true;
  }
  if (strcmp(value, "high") == 0) {
    outSpeed = FAN_HIGH;
    return true;
  }
  return false;
}

bool parseHex32(const char* text, uint32_t &outValue) {
  if (text == nullptr) {
    return false;
  }

  while (*text == ' ') {
    text++;
  }
  if (text[0] == '0' && (text[1] == 'x' || text[1] == 'X')) {
    text += 2;
  }

  size_t length = strlen(text);
  if (length == 0 || length > 8) {
    return false;
  }
  for (size_t i = 0; i < length; i++) {
    if (!isxdigit((unsigned char)text[i])) {
      return false;
    }
  }

  outValue = (uint32_t)strtoul(text, nullptr, 16);
  return true;
}

bool parseDurationSeconds(JsonDocument &doc, uint32_t &outSeconds) {
  outSeconds = (uint32_t)OVERRIDE_DEFAULT_SEC;
  if (doc["duration_s"].isNull()) {
    return true;
  }
  if (!doc["duration_s"].is<long>()) {
    return false;
  }

  long seconds = doc["duration_s"].as<long>();
  if (seconds < 0 || seconds > (long)OVERRIDE_MAX_SEC) {
    return false;
  }
  outSeconds = (uint32_t)seconds;
  return true;
}

void beginOverride(uint32_t durationMs, const char* source) {
  overrideActive = true;
  overrideIndefinite = (durationMs == 0);
  overrideStartMs = millis();
  overrideDurationMs = durationMs;
  overrideSource = source;

  Serial.print("[CMD] Override active, source=");
  Serial.print(source);
  if (overrideIndefinite) {
    Serial.println(" (indefinite)");
  } else {
    Serial.print(" duration=");
    Serial.print(durationMs / 1000UL);
    Serial.println("s");
  }
}

uint32_t overrideRemainingSeconds() {
  if (!overrideActive || overrideIndefinite) {
    return 0;
  }

  unsigned long elapsed = millis() - overrideStartMs;
  if (elapsed >= overrideDurationMs) {
    return 0;
  }
  return (uint32_t)((overrideDurationMs - elapsed + 999UL) / 1000UL);
}

void updateOverrideExpiry() {
  if (!overrideActive || overrideIndefinite) {
    return;
  }
  if ((millis() - overrideStartMs) < overrideDurationMs) {
    return;
  }

  overrideActive = false;
  overrideIndefinite = false;
  overrideDurationMs = 0;
  overrideSource = nullptr;
  Serial.println("[CMD] Override expired; automatic rules resumed.");
}

void publishCommandAck(const char* requestId, bool ok, const char* action,
                       const char* error, bool rawOnly, const char* irCodeHex) {
  if (!mqttClient.connected()) {
    return;
  }

  JsonDocument doc;
  doc["ok"] = ok;
  if (requestId != nullptr && requestId[0] != '\0') {
    doc["request_id"] = requestId;
  }
  if (action != nullptr && action[0] != '\0') {
    doc["action"] = action;
  }
  doc["override"] = overrideActive;
  doc["override_indefinite"] = overrideIndefinite;
  doc["raw_only"] = rawOnly;

  if (overrideActive) {
    if (overrideSource != nullptr) {
      doc["override_source"] = overrideSource;
    }
    if (!overrideIndefinite) {
      doc["override_remaining_s"] = overrideRemainingSeconds();
    }
  }

  if (ok && !rawOnly) {
    JsonObject applied = doc["applied"].to<JsonObject>();
    applied["relay_on"] = relayOn;
    applied["target_temp"] = targetTempC;
    applied["fan_speed"] = fanSpeedToString(fanSpeed);
  }

  if (irCodeHex != nullptr) {
    doc["ir_code"] = irCodeHex;
  } else if (ok && !rawOnly) {
    char code[11];
    snprintf(code, sizeof(code), "0x%08X", lastIrFrame);
    doc["ir_code"] = code;
  }

  if (error != nullptr) {
    doc["error"] = error;
  }
  doc["timestamp"] = getTimestamp();

  char jsonBuffer[384];
  size_t length = serializeJson(doc, jsonBuffer, sizeof(jsonBuffer));
  if (length == 0) {
    Serial.println("[CMD] Failed to serialize ACK.");
    return;
  }

  bool published = mqttClient.publish(MQTT_TOPIC_CMD_ACK, jsonBuffer, false);
  Serial.print("[MQTT] ");
  Serial.print(MQTT_TOPIC_CMD_ACK);
  Serial.print(published ? " -> " : " FAILED -> ");
  Serial.println(jsonBuffer);
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
  doc["override"] = overrideActive;
  if (overrideActive) {
    if (overrideSource != nullptr) {
      doc["override_source"] = overrideSource;
    }
    doc["override_indefinite"] = overrideIndefinite;
    if (!overrideIndefinite) {
      doc["override_remaining_s"] = overrideRemainingSeconds();
    }
  }
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

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (strcmp(topic, MQTT_TOPIC_CMD) != 0) {
    return;
  }

  if (length >= sizeof(pendingCommand)) {
    pendingCommandOverflow = true;
    pendingCommandReady = true;
    return;
  }

  memcpy(pendingCommand, payload, length);
  pendingCommand[length] = '\0';
  pendingCommandOverflow = false;
  pendingCommandReady = true;

  Serial.print("[CMD] Received on ");
  Serial.print(topic);
  Serial.print(": ");
  Serial.println(pendingCommand);
}

void processPendingCommand() {
  if (!pendingCommandReady) {
    return;
  }
  pendingCommandReady = false;

  if (pendingCommandOverflow) {
    pendingCommandOverflow = false;
    Serial.println("[CMD] Command payload too large; rejected.");
    publishCommandAck("", false, "", "command payload too large", false, nullptr);
    return;
  }

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, pendingCommand);
  if (err) {
    Serial.print("[CMD] JSON parse error: ");
    Serial.println(err.c_str());
    publishCommandAck("", false, "", "invalid JSON", false, nullptr);
    return;
  }

  const char* requestId = doc["request_id"].is<const char*>()
                              ? doc["request_id"].as<const char*>()
                              : "";
  const char* action = doc["action"].is<const char*>()
                           ? doc["action"].as<const char*>()
                           : "";

  if (strcmp(action, "override") == 0) {
    bool newRelay = relayOn;
    uint8_t newTemp = targetTempC;
    FanSpeed newFan = fanSpeed;
    bool hasStateField = false;

    if (!doc["relay_on"].isNull()) {
      if (!doc["relay_on"].is<bool>()) {
        publishCommandAck(requestId, false, action, "relay_on must be boolean", false, nullptr);
        return;
      }
      newRelay = doc["relay_on"].as<bool>();
      hasStateField = true;
    }

    if (!doc["target_temp"].isNull()) {
      if (!doc["target_temp"].is<long>()) {
        publishCommandAck(requestId, false, action, "target_temp must be an integer", false, nullptr);
        return;
      }
      long temp = doc["target_temp"].as<long>();
      if (temp < AC_IR_MIN_TEMP || temp > AC_IR_MAX_TEMP) {
        publishCommandAck(requestId, false, action, "target_temp must be 16..30", false, nullptr);
        return;
      }
      newTemp = (uint8_t)temp;
      hasStateField = true;
    }

    if (!doc["fan_speed"].isNull()) {
      if (!doc["fan_speed"].is<const char*>()) {
        publishCommandAck(requestId, false, action, "fan_speed must be a string", false, nullptr);
        return;
      }
      if (!parseFanSpeed(doc["fan_speed"].as<const char*>(), newFan)) {
        publishCommandAck(requestId, false, action,
                          "fan_speed must be off/low/medium/high", false, nullptr);
        return;
      }
      hasStateField = true;
    }

    if (!hasStateField) {
      publishCommandAck(requestId, false, action, "no override fields supplied", false, nullptr);
      return;
    }

    uint32_t durationSeconds = 0;
    if (!parseDurationSeconds(doc, durationSeconds)) {
      publishCommandAck(requestId, false, action, "duration_s must be 0..86400", false, nullptr);
      return;
    }

    // Keep the AC state physically consistent for structured commands.
    if (!newRelay) {
      newFan = FAN_OFF;
    }

    relayOn = newRelay;
    targetTempC = newTemp;
    fanSpeed = newFan;
    beginOverride(durationSeconds * 1000UL, "mqtt");
    sendIrIfNeeded(true);
    publishCommandAck(requestId, true, action, nullptr, false, nullptr);

  } else if (strcmp(action, "release") == 0) {
    overrideActive = false;
    overrideIndefinite = false;
    overrideDurationMs = 0;
    overrideSource = nullptr;

    bool warmup = (millis() - bootMillis) < PIR_WARMUP_MS;
    if (!warmup) {
      applyControlRules(motionSinceLastSample, lastTempC, lastHum);
    }
    sendIrIfNeeded(true);
    Serial.println("[CMD] Override released.");
    publishCommandAck(requestId, true, action, nullptr, false, nullptr);

  } else if (strcmp(action, "raw") == 0) {
    const char* rawText = doc["ir_code"].is<const char*>()
                              ? doc["ir_code"].as<const char*>()
                              : "";
    uint32_t frame = 0;
    if (!parseHex32(rawText, frame)) {
      publishCommandAck(requestId, false, action,
                        "ir_code must be a 32-bit hex string", false, nullptr);
      return;
    }

    uint32_t durationSeconds = 0;
    if (!parseDurationSeconds(doc, durationSeconds)) {
      publishCommandAck(requestId, false, action, "duration_s must be 0..86400", false, nullptr);
      return;
    }

    bool powerOn = false;
    uint8_t tempC = 24;
    FanSpeed fan = FAN_OFF;
    char hexBuffer[11];
    snprintf(hexBuffer, sizeof(hexBuffer), "0x%08lX", (unsigned long)frame);

    if (decodeAcFrame(frame, powerOn, tempC, fan)) {
      relayOn = powerOn;
      targetTempC = tempC;
      fanSpeed = fan;
      beginOverride(durationSeconds * 1000UL, "mqtt-raw");
      sendIrIfNeeded(true);
      Serial.print("[CMD] Raw AC frame applied: ");
      Serial.println(hexBuffer);
      publishCommandAck(requestId, true, action, nullptr, false, nullptr);
    } else {
      // Not one of our AC frames: send it once for testing other NEC devices.
      irSender.sendNEC(frame, 32, 1);
      Serial.print("[CMD] Raw one-shot IR sent: ");
      Serial.println(hexBuffer);
      publishCommandAck(requestId, true, action, nullptr, true, hexBuffer);
    }

  } else {
    publishCommandAck(requestId, false, action, "unknown action", false, nullptr);
  }
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
    if (mqttClient.subscribe(MQTT_TOPIC_CMD, 1)) {
      Serial.print("[MQTT] Subscribed to ");
      Serial.println(MQTT_TOPIC_CMD);
    } else {
      Serial.print("[MQTT] Failed to subscribe to ");
      Serial.println(MQTT_TOPIC_CMD);
    }
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
  mqttClient.setCallback(mqttCallback);
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
  processPendingCommand();
  updateOverrideExpiry();

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
  if (!warmup && !overrideActive) {
    applyControlRules(motion, lastTempC, lastHum);
  }

  bool irSent = sendIrIfNeeded(false);
  publishTelemetry(motion, lastTempC, lastHum, sensorOk, irSent, warmup);
}
