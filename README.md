# IoT Auto Climate Control Module

An IoT automation system for conventional air conditioners based on PIR motion occupancy, ambient temperature/humidity metrics, and external weather data fetched via the OpenWeatherMap API over an authenticated MQTT broker.

Comprehensive multi-page documentation and technical specifications:
- [System Documentation Hub (`docs/README.md`)](./docs/README.md)
  - [System Architecture & Topology (`docs/system-architecture.md`)](./docs/system-architecture.md)
  - [MQTT Wire Protocol & Payloads (`docs/mqtt-protocol-and-topics.md`)](./docs/mqtt-protocol-and-topics.md)
  - [Hardware Specifications & Firmware (`docs/hardware-and-firmware.md`)](./docs/hardware-and-firmware.md)
  - [Consumer Backend & REST API (`docs/consumer-backend-api.md`)](./docs/consumer-backend-api.md)
  - [Frontend Dashboard & Web Application (`docs/frontend-dashboard.md`)](./docs/frontend-dashboard.md)
  - [Analytics, ML & Streamlit Hub (`docs/analytics-and-ml.md`)](./docs/analytics-and-ml.md)
  - [Message Broker & Infrastructure (`docs/broker-and-infrastructure.md`)](./docs/broker-and-infrastructure.md)
  - [Utilities, CLI Tools & Testing (`docs/utilities-and-testing.md`)](./docs/utilities-and-testing.md)

---

## Architecture Overview

```text
[ Room Lighting ] <-- (GPIO12 relay: occupancy, 2h idle-off) -- [ Transmitter Node (ESP8266) ] -- 38 kHz NEC IR --> [ AC Unit ]
                                                |   \                                              (IR-driven only, no mains relay)
                                                |    \-- same IR frames (feedback decode) --> [ Receiver Node (ESP8266) ]
                                                | (transmit/data)                                   | (receive/state = decoded IR)
                                                v                                                   v
                                    [ MQTT Broker (Mosquitto 2) ] <--------------------------------+
                                         ^           | (transmit/data, receive/state, api/weather)
                                         |           v
                                    [ API-Producer ]   [ Consumer Node (Express 5 REST API & Dashboard) ]
                                    (OpenWeatherMap)      ├── GET /api/health
                                                          ├── GET /api/dashboard
                                                          ├── GET /api/transmit/latest
                                                          ├── GET /api/receive/latest
                                                          ├── GET /api/weather/latest
                                                          ├── GET /api/history/{topic}
                                                          └── POST /api/command
```

---

## Directory Structure

```text
.
├── broker/
│   ├── docker-compose.yaml     # Eclipse Mosquitto 2 container definition
│   └── mosquitto.conf          # Broker authentication and listener configs
├── transmit-node/
│   ├── transmit.ino            # ESP8266 PIR, DHT11, and KY-005 IR transmitter
│   └── secrets.h.example       # Template for Wi-Fi and MQTT credentials
├── receive-node/
│   ├── receive.ino             # ESP8266 VS1838B IR feedback listener, fan PWM, state LEDs (no AC relay)
│   └── secrets.h.example       # Template for Wi-Fi and MQTT credentials
├── api-producer/
│   ├── main.py                 # OpenWeatherMap poller and MQTT publisher
│   ├── requirements.txt        # Python dependencies
│   └── .env.example            # Environment configuration template
├── consumer/
│   ├── main.py                 # FastAPI REST API & in-memory sliding ring buffer
│   ├── requirements.txt        # Python dependencies
│   └── .env.example            # Environment configuration template
├── scripts/
│   └── e2e_integration_test.py # End-to-end integration and latency benchmark
├── analytics/                  # Telemetry analytics, ML regression & Streamlit app
│   ├── generate_mock_data.py   # 100,000-row telemetry dataset generator
│   ├── train_regression_model.py # Multi-model regression training & evaluation
│   ├── app.py                  # Comprehensive Streamlit analytics dashboard
│   ├── requirements.txt        # Analytics and ML dependencies
│   └── README.md               # Analytics documentation & user guide
├── specsheet.md                # System specification reference
└── handover.md                 # Production handover document
```

---

## Quickstart

### 1. Launch MQTT Broker
```bash
cd broker
docker compose up -d
```

### 2. Run Consumer REST API
```bash
source .venv/bin/activate
cd consumer
python main.py
```
*API endpoints will be accessible at `http://localhost:8000` (docs at `http://localhost:8000/docs`).*

### 3. Run Weather Producer
```bash
source .venv/bin/activate
cd api-producer
python main.py
```

### 4. Run System Verification Test
```bash
.venv/bin/python scripts/e2e_integration_test.py
```

---

### 5. Run Analytics, ML Training & Streamlit Dashboard

```bash
cd analytics

# 1. Generate 100,000 rows of mock telemetry data
python generate_mock_data.py --rows 100000

# 2. Train regression models and benchmark performance
python train_regression_model.py --compare-all

# 3. Launch Streamlit interactive dashboard
streamlit run app.py
```
*Streamlit dashboard will be accessible at `http://localhost:8501`.*
