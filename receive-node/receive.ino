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

// Standard opto-isolated relays trigger on active-LOW
#define RELAY_ACTIVE_LOW  true

// ==========================================
// Constants & Configuration
// ==========================================
#define MQTT_TOPIC_SUB    "transmit/data"
#define MQTT_TOPIC_ACK    "receive/ack"
#define AC_REMOTE_HEADER  0xA1

// Legacy static NEC codes (for backwards compatibility)
const uint32_t NEC_CODE_PWR_ON  = 0xFFA25D;
const uint32_t NEC_CODE_PWR_OFF = 0xFF629D;

// ==========================================
// Global Instances & State
// ==========================================
WiFiClient espClient;
PubSubClient mqttClient(espClient);
IRrecv irReceiver(PIN_IR_RECV);
decode_results results;

bool relayState = false;
uint8_t currentTargetTemp = 24; // Default starting target temperature in °C

// NTP configuration
const char* ntpServer = "pool.ntp.org";
const long  gmtOffset_sec = 0;
const int   daylightOffset_sec = 0;

long getTimestamp() {
  time_t now;
  time(&now);
  if (now > 100000) {
    return (long)now;
  }
  return (long)(millis() / 1000);
}

void setRelay(bool state) {
  relayState = state;
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(PIN_RELAY, state ? LOW : HIGH);
  } else {
    digitalWrite(PIN_RELAY, state ? HIGH : LOW);
  }
  // Status LED mirrors relay state
  digitalWrite(PIN_LED, state ? HIGH : LOW);
  Serial.print("[Relay Actuator] State changed to: ");
  Serial.println(state ? "ON" : "OFF");
}

void publishAck(const char* irCodeStr, bool state, uint8_t targetTemp) {
  // Schema: {"ir_code": "0x<hex>", "relay": bool, "target_temp": int, "ts": int}
  JsonDocument doc;
  doc["ir_code"] = irCodeStr;
  doc["relay"] = state;
  doc["target_temp"] = targetTemp;
  doc["ts"] = getTimestamp();

  char jsonBuffer[256];
  serializeJson(doc, jsonBuffer);

  Serial.print("[Publish ACK] Topic: ");
  Serial.print(MQTT_TOPIC_ACK);
  Serial.print(" | Payload: ");
  Serial.println(jsonBuffer);

  bool pubSuccess = mqttClient.publish(MQTT_TOPIC_ACK, jsonBuffer, false);
  if (!pubSuccess) {
    Serial.println("[MQTT] Warning: ACK publish failed.");
  }
}

/**
 * Attempts to decode custom 32-bit AC Remote frame:
 * [0xA1][Power: 0x01/0x00][TargetTemp: 16-32][~TargetTemp]
 */
bool decodeAcRemoteFrame(uint32_t rawValue, bool &outPowerOn, uint8_t &outTargetTemp) {
  uint8_t header = (rawValue >> 24) & 0xFF;
  if (header != AC_REMOTE_HEADER) {
    return false;
  }

  uint8_t pwrByte = (rawValue >> 16) & 0xFF;
  uint8_t tempByte = (rawValue >> 8) & 0xFF;
  uint8_t checkByte = rawValue & 0xFF;

  // Validate integrity checksum
  if (checkByte != (uint8_t)(~tempByte)) {
    Serial.println("[IR Decoder] Parity/checksum check failed on AC remote frame.");
    return false;
  }

  outPowerOn = (pwrByte == 0x01);
  outTargetTemp = tempByte;
  return true;
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.print("[MQTT Callback] Message arrived [");
  Serial.print(topic);
  Serial.print("]: ");

  if (strcmp(topic, MQTT_TOPIC_SUB) == 0) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload, length);
    if (!err) {
      if (!doc["target_temp"].isNull()) {
        currentTargetTemp = doc["target_temp"].as<uint8_t>();
      }

      if (!doc["ir_cmd"].isNull()) {
        const char* cmd = doc["ir_cmd"];
        Serial.print("Fallback cmd received: ");
        Serial.println(cmd);

        char synthCode[16];
        if (strcmp(cmd, "PWR_ON") == 0) {
          setRelay(true);
          uint8_t check = (uint8_t)(~currentTargetTemp);
          snprintf(synthCode, sizeof(synthCode), "0xA101%02X%02X", currentTargetTemp, check);
          publishAck(synthCode, relayState, currentTargetTemp);
        } else if (strcmp(cmd, "PWR_OFF") == 0) {
          setRelay(false);
          uint8_t check = (uint8_t)(~currentTargetTemp);
          snprintf(synthCode, sizeof(synthCode), "0xA100%02X%02X", currentTargetTemp, check);
          publishAck(synthCode, relayState, currentTargetTemp);
        }
      }
    } else {
      Serial.println("JSON parse error on fallback topic");
    }
  }
}

void setupWifi() {
  delay(10);
  Serial.println();
  Serial.print("[WiFi] Connecting to: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("[WiFi] Connected! IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n[WiFi] Connection failed. Will retry in loop.");
  }
}

void reconnectMqtt() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  while (!mqttClient.connected()) {
    Serial.print("[MQTT] Connecting to ");
    Serial.print(MQTT_HOST);
    Serial.print(":");
    Serial.println(MQTT_PORT);

    String clientId = "ESP8266-Receiver-" + String(ESP.getChipId(), HEX);

    if (mqttClient.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)) {
      Serial.println("[MQTT] Connected successfully.");
      mqttClient.subscribe(MQTT_TOPIC_SUB, 1);
      Serial.print("[MQTT] Subscribed to: ");
      Serial.println(MQTT_TOPIC_SUB);
    } else {
      Serial.print("[MQTT] Failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" - retrying in 3 seconds...");
      delay(3000);
      break;
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n--- IoT Auto Climate Control: Receiver Node ---");

  pinMode(PIN_RELAY, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  setRelay(false);

  irReceiver.enableIRIn();

  setupWifi();
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer, "time.nist.gov");

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    setupWifi();
  } else if (!mqttClient.connected()) {
    reconnectMqtt();
  }
  mqttClient.loop();

  // Decode incoming Infrared commands
  if (irReceiver.decode(&results)) {
    char hexBuffer[16];
    snprintf(hexBuffer, sizeof(hexBuffer), "0x%08X", (unsigned long)results.value);
    Serial.print("[IR Demodulator] Received code: ");
    Serial.println(hexBuffer);

    bool powerOn = false;
    uint8_t targetTemp = 24;

    if (decodeAcRemoteFrame(results.value, powerOn, targetTemp)) {
      Serial.print("[IR Decoder] Decoded AC Remote -> Power: ");
      Serial.print(powerOn ? "ON" : "OFF");
      Serial.print(", Target Temp: ");
      Serial.print(targetTemp);
      Serial.println("C");

      currentTargetTemp = targetTemp;
      setRelay(powerOn);
      publishAck(hexBuffer, relayState, currentTargetTemp);
    } else if (results.value == NEC_CODE_PWR_ON) {
      // Legacy code compatibility
      setRelay(true);
      publishAck("0xFFA25D", relayState, currentTargetTemp);
    } else if (results.value == NEC_CODE_PWR_OFF) {
      // Legacy code compatibility
      setRelay(false);
      publishAck("0xFF629D", relayState, currentTargetTemp);
    } else {
      Serial.print("[IR Demodulator] Unhandled IR Code: ");
      Serial.println(hexBuffer);
    }

    irReceiver.resume(); // Ready to receive next pulse train
  }
}
