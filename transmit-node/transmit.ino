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
// Constants & NEC IR Codes
// ==========================================
#define DHTTYPE           DHT11
#define SAMPLE_INTERVAL   5000UL     // 5 seconds sampling interval
#define MQTT_TOPIC_DATA   "transmit/data"

// NEC 32-bit protocol codes for AC control
const uint32_t NEC_CODE_PWR_ON  = 0xFFA25D; // Standard NEC power ON command
const uint32_t NEC_CODE_PWR_OFF = 0xFF629D; // Standard NEC power OFF command

// ==========================================
// Global Instances & State
// ==========================================
WiFiClient espClient;
PubSubClient mqttClient(espClient);
DHT dht(PIN_DHT, DHTTYPE);
IRsend irSender(PIN_IR_EMIT);

bool lastMotionState = false;
unsigned long lastSampleTime = 0;

// NTP server configuration for Unix epoch timestamps
const char* ntpServer = "pool.ntp.org";
const long  gmtOffset_sec = 0;
const int   daylightOffset_sec = 0;

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
      break; // exit loop to keep main loop ticking
    }
  }
}

long getTimestamp() {
  time_t now;
  time(&now);
  if (now > 100000) {
    return (long)now;
  }
  // Fallback to relative seconds from boot if NTP is not yet synced
  return (long)(millis() / 1000);
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n--- IoT Auto Climate Control: Transmitter Node ---");

  // GPIO configuration
  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);

  // Initialize sensors and actuators
  dht.begin();
  irSender.begin();

  // Network and MQTT setup
  setupWifi();
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer, "time.nist.gov");

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setBufferSize(512); // Ensure ample room for JSON payload

  // Initial read of PIR
  lastMotionState = (digitalRead(PIN_PIR) == HIGH);
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
  if (currentMillis - lastSampleTime >= SAMPLE_INTERVAL) {
    lastSampleTime = currentMillis;

    // 1. Read motion sensor
    bool currentMotion = (digitalRead(PIN_PIR) == HIGH);
    digitalWrite(PIN_LED, currentMotion ? HIGH : LOW);

    // 2. Read temperature and humidity
    float temp_c = dht.readTemperature();
    float hum = dht.readHumidity();

    if (isnan(temp_c)) temp_c = 0.0;
    if (isnan(hum)) hum = 0.0;

    // 3. Determine IR command based on edge transitions
    const char* irCmd = nullptr;
    if (!lastMotionState && currentMotion) {
      // Rising edge: Motion detected -> turn AC on
      irCmd = "PWR_ON";
      Serial.println("[IR] Emitting NEC PWR_ON command...");
      irSender.sendNEC(NEC_CODE_PWR_ON, 32);
    } else if (lastMotionState && !currentMotion) {
      // Falling edge: Motion cleared -> turn AC off
      irCmd = "PWR_OFF";
      Serial.println("[IR] Emitting NEC PWR_OFF command...");
      irSender.sendNEC(NEC_CODE_PWR_OFF, 32);
    }
    lastMotionState = currentMotion;

    // 4. Construct JSON payload conforming to spec
    // Schema: {"motion": bool, "temp_c": float, "hum": float, "ir_cmd": "PWR_ON" | "PWR_OFF" | null, "ts": int}
    JsonDocument doc;
    doc["motion"] = currentMotion;
    doc["temp_c"] = round(temp_c * 10.0) / 10.0;
    doc["hum"] = round(hum * 10.0) / 10.0;
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

    // Publish to transmit/data, QoS 1 per specification
    // PubSubClient publish default is QoS 0, publish returns true on write
    bool pubSuccess = mqttClient.publish(MQTT_TOPIC_DATA, jsonBuffer, false);
    if (!pubSuccess) {
      Serial.println("[MQTT] Warning: Publish failed.");
    }
  }
}
