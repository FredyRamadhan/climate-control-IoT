# IoT Auto Climate Control Module — Specsheet

---

## 1. Purpose & Scope

This specification defines the functional and non-functional requirements for the **Auto Climate Control Module** prototype — an IoT system automating a conventional air-conditioner (AC) based on occupancy, ambient temperature/humidity, and external weather fetched via the **OpenWeatherMap API**.

The scope covers four nodes (Transmitter, Receiver, Consumer, API-Producer) and one MQTT broker. Firmware implementations, cloud hosting, ML/data analysis and production deployments are out of scope.

---

## 2. System Overview

- **Transmitter (ESP8266):** Samples motion and ambient metrics; transmits IR commands to the AC; publishes telemetry.
- **Receiver (ESP8266):** Decodes IR commands as feedback, toggles a 250 VAC mains relay, and publishes acknowledgements.
- **API-Producer (Python):** Periodically queries OpenWeatherMap and publishes weather conditions.
- **Consumer (FastAPI):** Subscribes to all telemetry topics and serves data via a REST API.

---

## 3. System Requirements

| ID    | Requirement                                                                                         |
|-------|-----------------------------------------------------------------------------------------------------|
| SR-1  | The Transmitter shall sample PIR motion, DHT11 temperature, and humidity every 5 seconds.          |
| SR-2  | The Transmitter shall emit NEC-protocol IR commands via a KY-005 emitter.                           |
| SR-3  | The Transmitter shall publish telemetry to `transmit/data` over MQTT.                                |
| SR-4  | The Receiver shall decode IR signals via a VS1838B sensor and publish acknowledgements to `receive/ack`. |
| SR-5  | The Receiver shall drive an opto-isolated 250 VAC relay to switch AC mains power.                   |
| SR-6  | The Consumer shall subscribe to `transmit/data`, `receive/ack`, and `api/weather`.                   |
| SR-7  | The API-Producer shall poll OpenWeatherMap at a configured interval.                                |
| SR-8  | The API-Producer shall publish weather updates to `api/weather`.                                     |
| SR-9  | Firmware credentials (Wi-Fi, MQTT) shall be isolated in `secrets.h`.                                 |
| SR-10 | Backend credentials shall be loaded via environment variables (`.env`).                             |

---

## 4. Directory Structure

```text
/
├── receive-node/
│   ├── receive.ino
│   └── secrets.h
├── transmit-node/
│   ├── transmit.ino
│   └── secrets.h
├── broker/
│   └── docker-compose.yaml
├── consumer/
│   ├── main.py
│   └── .env
└── api-producer/
    ├── main.py
    └── .env
```

**Conventions:**
- Firmware directories contain exactly one `.ino` sketch and one untracked `secrets.h`.
- The broker configuration is containerized under `broker/`.
- Python services each utilize a single `main.py` entry point configured via `.env`.

---

## 5. Node Specifications

### 5.1 Transmitter Node (ESP8266)

| Parameter         | Specification                                                              |
|-------------------|----------------------------------------------------------------------------|
| MCU               | ESP8266 (NodeMCU v2 / D1 mini)                                             |
| Sensors           | HC-SR501 PIR (motion), DHT11 (temperature, humidity)                       |
| Actuator          | KY-005 IR LED emitter, NEC protocol @ 38 kHz                               |
| Indicator         | Onboard LED (active on motion detection)                                   |
| Connectivity      | Wi-Fi 2.4 GHz → MQTT (Mosquitto)                                           |
| Publish topic     | `transmit/data`                                                            |
| Sample interval   | 5 s                                                                        |
| Payload format    | JSON                                                                       |
| Payload schema    | `{"motion": bool, "temp_c": float, "hum": float, "target_temp": int, "ir_cmd": "PWR_ON" \| "PWR_OFF" \| null, "ts": int}` |
| QoS / Retained    | 1 / false                                                                  |
| Power             | 5 V USB                                                                    |
| GPIO mapping      | PIR → D5 (GPIO14), DHT11 → D4 (GPIO2), KY-005 → D2 (GPIO4), LED → D0 (GPIO16) |

**Rule-Based Climate Control Logic:**
- **Rule 1 (Hot Occupancy):** `motion == true` AND `temp_c > 28.0` → Set `target_temp = 16`, `PWR_ON` (Max cooling).
- **Rule 2 (Vacant Moderation):** `motion == false` for $> 5\text{ min}$ (300 s) AND `temp_c < 24.0` → Set `target_temp = 24`, `PWR_ON` (Eco moderation).
- **Rule 3 (Vacant Auto-Off):** `motion == false` for $> 10\text{ min}$ (600 s) AND `target_temp == 24` → Set `PWR_OFF` (Auto shut-off).
- **Default Occupied:** `motion == true` AND `temp_c <= 28.0` → Set `target_temp = 24`, `PWR_ON` (Comfort baseline).
- **IR Emulation:** Emits 32-bit structured NEC packets: `[0xA1][Power: 0x01/0x00][TargetTemp: 16-32][~TargetTemp]`.

---

### 5.2 Receiver Node (ESP8266)

| Parameter         | Specification                                                              |
|-------------------|----------------------------------------------------------------------------|
| MCU               | ESP8266 (NodeMCU v2 / D1 mini)                                             |
| Sensor            | VS1838B IR receiver (38 kHz demodulator)                                   |
| Actuator          | 250 VAC relay module (opto-isolated)                                       |
| Indicator         | Status LED (mirrors relay state)                                           |
| Connectivity      | Wi-Fi 2.4 GHz → MQTT (Mosquitto)                                           |
| Subscribed topic  | `transmit/data`                                                            |
| Publish topic     | `receive/ack`                                                              |
| Payload format    | JSON                                                                       |
| Payload schema    | `{"ir_code": "0x<hex>", "relay": bool, "target_temp": int, "ts": int}`    |
| QoS / Retained    | 1 / false                                                                  |
| Power             | 5 V USB + external relay coil supply                                       |
| GPIO mapping      | VS1838B OUT → D5 (GPIO14), Relay IN → D6 (GPIO12), Status LED → D7 (GPIO13) |

---

### 5.3 Consumer Node (FastAPI)

| Parameter          | Specification                                                             |
|--------------------|---------------------------------------------------------------------------|
| Runtime            | Python 3.11+ / FastAPI / Uvicorn                                          |
| MQTT Client        | paho-mqtt (threaded non-blocking loop)                                    |
| Subscribed topics  | `transmit/data`, `receive/ack`, `api/weather`                             |
| Buffer             | Ring buffer (last 100 messages/topic in memory)                           |
| Endpoints          | `GET /health`, `GET /{topic}/latest`, `GET /history/{topic}`               |
| Listen port        | 8000                                                                      |
| Config / Response  | `.env` / JSON                                                             |

---

### 5.4 API-Producer Node

| Parameter          | Specification                                                             |
|--------------------|---------------------------------------------------------------------------|
| Runtime            | Python 3.11+                                                              |
| Data source        | OpenWeatherMap REST API (`/data/2.5/weather`)                             |
| Query parameters   | `q={CITY}`, `appid={OPENWEATHER_API_KEY}`, `units=metric`                 |
| Poll interval      | 600 s default (`POLL_SECONDS`)                                            |
| Publish topic     | `api/weather`                                                             |
| Payload format     | JSON                                                                      |
| Payload schema     | `{"city": str, "temp_c": float, "hum": int, "desc": str, "ts": int}`      |
| QoS / Retained     | 1 / true                                                                  |
| Configuration      | `.env` (`OPENWEATHER_API_KEY`, `CITY`, `POLL_SECONDS`, MQTT credentials)  |

---

### 5.5 Broker Node

| Parameter          | Specification                                                             |
|--------------------|---------------------------------------------------------------------------|
| Software           | Eclipse Mosquitto 2 (Docker container)                                    |
| Ports              | 1883 (MQTT), 9001 (WebSocket)                                             |
| Authentication     | Password file; anonymous access disabled                                  |
| Persistence        | Volume-mounted storage for state and logs                                 |

---

## 6. MQTT Topic Map

| Topic            | Publisher     | Subscribers                   | QoS | Retained | Payload schema                                        |
|------------------|---------------|-------------------------------|-----|----------|-------------------------------------------------------|
| `transmit/data`  | Transmitter   | Receiver, Consumer            | 1   | false    | `{"motion": bool, "temp_c": float, "hum": float, "target_temp": int, "ir_cmd": str, "ts": int}` |
| `receive/ack`    | Receiver      | Consumer                      | 1   | false    | `{"ir_code": str, "relay": bool, "target_temp": int, "ts": int}` |
| `api/weather`    | API-Producer  | Consumer                      | 1   | true     | `{"city": str, "temp_c": float, "hum": int, "desc": str, "ts": int}` |

---

## 7. Configuration & Secrets

### 7.1 Firmware (`secrets.h`)
Required in both `transmit-node/` and `receive-node/`:
- `WIFI_SSID`, `WIFI_PASSWORD`
- `MQTT_HOST`, `MQTT_PORT`, `MQTT_USER`, `MQTT_PASS`

### 7.2 Services (`.env`)
Required in `consumer/` and `api-producer/`:
- Standard MQTT connection keys (`MQTT_HOST`, `MQTT_PORT`, etc.)
- Producer-specific: `OPENWEATHER_API_KEY`, `CITY`, `POLL_SECONDS`

*All secret files are excluded from version control.*

---

## 8. Functional Workflows

1. **Automation Loop:** The Transmitter reads sensors every 5 s. Motion state transitions emit NEC IR commands (`PWR_ON` or `PWR_OFF`) and broadcast JSON telemetry to `transmit/data`.
2. **Receiver & Actuation:** The Receiver decodes incoming IR commands (or falls back to `transmit/data`), switches the mains relay, and posts an acknowledgement to `receive/ack`.
3. **Weather Polling:** The API-Producer polls OpenWeatherMap every 10 minutes and publishes retained JSON data to `api/weather`.
4. **Data Aggregation:** The Consumer buffers the last 100 entries per topic and exposes current and historic data over REST.

---

## 9. Non-Functional Requirements

- **Reliability:** QoS 1 across all MQTT streams; automatic client reconnection on network drop.
- **Timing:** Sensor sampling interval $\le 5\text{ s}$; weather polling $\ge 600\text{ s}$; REST latency $< 200\text{ ms}$.
- **Electrical Safety:** Relay board must be opto-isolated from the ESP8266 GPIO pins.
- **Data Standards:** Payloads encoded in UTF-8 JSON containing standard Unix epoch timestamps (`ts`).

---

## 10. HTTP Endpoints (Consumer)

| Method | Endpoint             | Description                         |
|--------|----------------------|-------------------------------------|
| GET    | `/health`            | Service health check (`{"status": "ok"}`) |
| GET    | `/transmit/latest`   | Most recent Transmitter payload     |
| GET    | `/receive/latest`    | Most recent Receiver payload        |
| GET    | `/weather/latest`    | Most recent OpenWeatherMap payload  |
| GET    | `/history/{topic}`   | Sliding ring buffer (up to 100 msgs)|

---

## 11. Bill of Materials (Prototype)

| Item                                         | Qty |
|----------------------------------------------|-----|
| ESP8266 development boards (NodeMCU / D1 mini)| 2   |
| HC-SR501 PIR motion sensor                   | 1   |
| DHT11 temperature/humidity sensor            | 1   |
| KY-005 IR emitter module (38 kHz)            | 1   |
| VS1838B IR demodulator receiver              | 1   |
| Opto-isolated 250 VAC relay module           | 1   |
| Indicator LEDs + 220 Ω current-limiting resistors | 2   |
| Solderless breadboards & jumper leads        | 1 set |
| 5 V USB power adapters                       | 2   |

---

## 12. Assumptions & Constraints

- Prototype targets NEC-protocol IR emulation; no physical AC unit is connected directly to the high-voltage relay during initial testing.
- Operates within a single secure private subnet; TLS termination is deferred.
- Uses OpenWeatherMap free-tier limits.
- NodeMCU code targets current Arduino ESP8266 Core releases.

---

## 13. Excluded Scope

- Hardware security elements, mTLS, and encrypted storage.
- Dedicated frontend user interface (REST endpoints only).
- Over-the-air (OTA) device provisioning.
- Data analysis