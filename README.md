# IoT Auto Climate Control Module

An IoT automation system for conventional air conditioners based on PIR motion occupancy, ambient temperature/humidity metrics, and external weather data fetched via the OpenWeatherMap API over an authenticated MQTT broker.

Detailed specifications and implementation audit documents:
- [Specification Sheet (`specsheet.md`)](./specsheet.md)
- [Production Handover & Audit Document (`handover.md`)](./handover.md)

---

## Architecture Overview

```text
[ Transmitter Node (ESP8266) ] -------- IR Command (38 kHz NEC) --------> [ AC Unit ]
     |                                                                         ^
     | (transmit/data)                                                         | (Mains Relay)
     v                                                                         |
[ MQTT Broker (Mosquitto 2) ] <---------------------------------------- [ Receiver Node (ESP8266) ]
     ^           | (transmit/data, receive/ack, api/weather)
     |           v
[ API-Producer ]   [ Consumer Node (FastAPI REST API) ]
(OpenWeatherMap)      ├── GET /health
                      ├── GET /transmit/latest
                      ├── GET /receive/latest
                      ├── GET /weather/latest
                      └── GET /history/{topic}
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
│   ├── receive.ino             # ESP8266 VS1838B IR receiver & relay controller
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
