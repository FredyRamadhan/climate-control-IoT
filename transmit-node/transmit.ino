#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <IRremoteESP8266.h>
#include <IRsend.h>
#include <ArduinoJson.h>
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
#define SAMPLE_INTERVAL_MS    5000UL     // 5 seconds sampling interval
#define MQTT_TOPIC_DATA       "transmit/data"

// Inactivity timeout thresholds for rule-based climate control
#define TIMEOUT_ECO_MS        300000UL   // 5 minutes (300,000 ms)
#define TIMEOUT_SHUTOFF_MS    600000UL   // 10 minutes (600,000 ms)

// Protocol header for AC remote emulation
#define AC_REMOTE_HEADER      0xA1

// ==========================================
// Global Instances & State
// ==========================================
WiFiClient espClient;
PubSubClient mqttClient(espClient);
DHT dht(PIN_DHT, DHTTYPE);
IRsend irSender(PIN_IR_EMIT);

// Rule-Based Control State
bool acPowerState = false;             // False = OFF, True = ON
uint8_t currentTargetTemp = 24;        // Default target temperature in °C
bool lastMotionState = false;
unsigned long lastMotionDetectedTime = 0;
unsigned long lastSampleTime = 0;
bool initialRun = true;

// NTP server configuration for Unix epoch timestamps
const char* ntpServer = "pool.ntp.org";
const long  gmtOffset_sec = 0;
const int   daylightOffset_sec = 0;

/**
 * Encodes AC remote commands into a 32-bit NEC frame:
 * Byte 3: Header (0xA1)
 * Byte 2: Power flag (0x01 = ON, 0x00 = OFF)
 * Byte 1: Target temperature (°C)
 * Byte 0: Checksum (~Target & 0xFF)
 */
uint32_t encodeAcCommand(bool powerOn, uint8_t targetTemp) {
  uint8_t pwrByte = powerOn ? 0x01 : 0x00;
  uint8_t checkByte = (uint8_t)(~targetTemp);
  return ((uint32_t)AC_REMOTE_HEADER << 24) |
         ((uint32_t)pwrByte << 16) |
         ((uint32_t)targetTemp << 8) |
         (uint32_t)checkByte;
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
    Serial.print("[MQTT] Attempting connection to ");
    Serial.print(MQTT_HOST);
    Serial.print(":");
    Serial.print(MQTT_PORT);
    Serial.print(" as ");
    Serial.println(MQTT_USER);

    String clientId = "ESP8266-Transmitter-" + String(ESP.getChipId(), HEX);

    if (mqttClient.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)) {
      Serial.println("[MQTT] Connected successfully.");
    } else {
      Serial.print("[MQTT] Failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" - retrying in 3 seconds...");
      delay(3000);
      break;
    }
  }
}

long getTimestamp() {
  time_t now;
  time(&now);
  if (now > 100000) {
    return (long)now;
  }
  return (long)(millis() / 1000);
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n--- IoT Auto Climate Control: Transmitter Remote Node ---");

  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);

  dht.begin();
  irSender.begin();

  setupWifi();
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer, "time.nist.gov");

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setBufferSize(512);

  lastMotionState = (digitalRead(PIN_PIR) == HIGH);
  lastMotionDetectedTime = millis();
  digitalWrite(PIN_LED, lastMotionState ? HIGH : LOW);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    setupWifi();
  } else if (!mqttClient.connected()) {
    reconnectMqtt();
  }
  mqttClient.loop();

  unsigned long currentMillis = millis();
  if (currentMillis - lastSampleTime >= SAMPLE_INTERVAL_MS) {
    lastSampleTime = currentMillis;

    // 1. Read Sensors
    bool currentMotion = (digitalRead(PIN_PIR) == HIGH);
    digitalWrite(PIN_LED, currentMotion ? HIGH : LOW);

    float temp_c = dht.readTemperature();
    float hum = dht.readHumidity();

    if (isnan(temp_c)) temp_c = 25.0; // Fallback baseline if sensor read fails
    if (isnan(hum)) hum = 60.0;

    // Track motion inactivity timing
    if (currentMotion) {
      lastMotionDetectedTime = currentMillis;
    }
    unsigned long noMotionDuration = currentMillis - lastMotionDetectedTime;

    // 2. Evaluate Rule-Based Climate Control Matrix
    bool desiredPower = acPowerState;
    uint8_t desiredTargetTemp = currentTargetTemp;
    const char* ruleMatched = "None";

    if (currentMotion) {
      if (temp_c > 28.0) {
        // Rule 1: Motion detected AND temp > 28°C -> target = 16°C (Max Cooling)
        desiredPower = true;
        desiredTargetTemp = 16;
        ruleMatched = "Rule 1 (Motion & Temp > 28 -> Target 16C, Power ON)";
      } else {
        // Comfort default for occupied room
        desiredPower = true;
        desiredTargetTemp = 24;
        ruleMatched = "Occupied Comfort (Temp <= 28 -> Target 24C, Power ON)";
      }
    } else {
      // Inactive room checks
      if (noMotionDuration >= TIMEOUT_SHUTOFF_MS && currentTargetTemp == 24) {
        // Rule 3: No motion > 10 min AND target == 24°C -> shut off
        desiredPower = false;
        ruleMatched = "Rule 3 (No motion > 10 min & Target == 24 -> Power OFF)";
      } else if (noMotionDuration >= TIMEOUT_ECO_MS && temp_c < 24.0) {
        // Rule 2: No motion > 5 min AND ambient temp < 24°C -> target = 24°C
        desiredPower = true;
        desiredTargetTemp = 24;
        ruleMatched = "Rule 2 (No motion > 5 min & Temp < 24 -> Target 24C, Power ON)";
      }
    }

    // 3. Determine if an IR Command needs to be emitted
    bool stateChanged = initialRun ||
                        (desiredPower != acPowerState) ||
                        (desiredTargetTemp != currentTargetTemp);
    initialRun = false;

    const char* irCmd = nullptr;
    if (stateChanged) {
      acPowerState = desiredPower;
      currentTargetTemp = desiredTargetTemp;

      irCmd = acPowerState ? "PWR_ON" : "PWR_OFF";
      uint32_t necCode = encodeAcCommand(acPowerState, currentTargetTemp);

      char hexStr[16];
      snprintf(hexStr, sizeof(hexStr), "0x%08X", necCode);

      Serial.print("[Rule Engine] Triggered: ");
      Serial.println(ruleMatched);
      Serial.print("[IR Remote] Emitting NEC Code: ");
      Serial.print(hexStr);
      Serial.print(" (Power: ");
      Serial.print(acPowerState ? "ON" : "OFF");
      Serial.print(", Target: ");
      Serial.print(currentTargetTemp);
      Serial.println("C)");

      // Transmit 32-bit NEC IR packet via KY-005 emitter
      irSender.sendNEC(necCode, 32);
    }
    lastMotionState = currentMotion;

    // 4. Construct and Publish MQTT Telemetry to transmit/data
    JsonDocument doc;
    doc["motion"] = currentMotion;
    doc["temp_c"] = round(temp_c * 10.0) / 10.0;
    doc["hum"] = round(hum * 10.0) / 10.0;
    doc["target_temp"] = currentTargetTemp;
    if (irCmd != nullptr) {
      doc["ir_cmd"] = irCmd;
    } else {
      doc["ir_cmd"] = nullptr;
    }
    doc["ts"] = getTimestamp();

    char jsonBuffer[256];
    serializeJson(doc, jsonBuffer);

    Serial.print("[Publish] Topic: ");
    Serial.print(MQTT_TOPIC_DATA);
    Serial.print(" | Payload: ");
    Serial.println(jsonBuffer);

    mqttClient.publish(MQTT_TOPIC_DATA, jsonBuffer, false);
  }
}
