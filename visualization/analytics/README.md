# IoT Auto Climate Control — Analytics & ML Prediction Hub

Comprehensive data science and machine learning extension for the **IoT Auto Climate Control Module**.

This module generates high-fidelity synthetic telemetry conforming to the IoT system architecture (`specsheet.md`), trains regression models to predict AC electrical power consumption (Watts), and exposes an interactive Streamlit dashboard for real-time inference and telemetry analytics.

---

## Architecture & Directory Structure

```text
tubes/analytics/
├── requirements.txt           # Python dependencies (scikit-learn, streamlit, plotly, etc.)
├── generate_mock_data.py      # High-fidelity 100,000-row mock telemetry generator
├── train_regression_model.py  # Model trainer, evaluator, and artifact generator
├── app.py                     # Streamlit analytics & real-time prediction dashboard
├── README.md                  # Module guide and documentation
├── data/                      # Output directory for dataset (generated on run)
│   └── climate_telemetry_100k.csv
└── models/                    # Persisted models & performance scorecards (generated on run)
    ├── ac_power_regressor.joblib
    ├── model_metrics.json
    └── test_predictions_sample.csv
```

---

## 1. Feature Dictionary & Physics Model

The dataset adheres to the physical specifications of an Inverter Air Conditioning system (1.0 - 2.0 PK) and the ESP8266 node telemetry defined in `specsheet.md`:

| Feature Name | Type | Unit | Description |
|---|---|---|---|
| `timestamp` | Datetime | ISO 8601 | Sequential sample timestamps (1-minute cadence) |
| `hour_of_day` | Float | 0.0 - 23.9 | Time of day governing diurnal outdoor heat wave |
| `day_of_week` | Int | 0 - 6 | Weekday vs weekend occupancy schedule |
| `indoor_temp_c` | Float | °C | Ambient room temperature (DHT11 sensor) |
| `indoor_humidity` | Float | % | Ambient relative humidity (DHT11 sensor) |
| `outdoor_temp_c` | Float | °C | Ambient outdoor temperature (OpenWeatherMap API) |
| `outdoor_humidity` | Float | % | Ambient outdoor humidity (OpenWeatherMap API) |
| `weather_condition` | String | Categorical | Condition: Clear, Clouds, Rain, Thunderstorm |
| `motion_detected` | Int | 0 / 1 | PIR motion occupancy (HC-SR501 sensor) |
| `occupancy_count` | Int | Count | Number of individuals in the room (0 to 10) |
| `target_temp_c` | Int | °C | NEC IR climate target setpoint (16°C - 30°C) |
| `temp_delta` | Float | °C | Cooling demand: `indoor_temp_c - target_temp_c` |
| `fan_speed` | String | Categorical | Fan mode: Low, Medium, High, Auto, Off |
| `relay_state` | Int | 0 / 1 | 250 VAC Relay state (VS1838B ACK) |
| `ac_power_state` | Int | 0 / 1 | AC operational state: 1 (Active), 0 (Standby) |
| **`ac_power_consumption_w`** | Float | **Watts** | **Regression Target**: Real-time AC electrical load |

---

## 2. Iteration, Testing & Build Guide

### Step 1: Install Dependencies
```bash
cd tubes/analytics
pip install -r requirements.txt
```

### Step 2: Generate 100,000 Rows of Mock Telemetry Data
```bash
python generate_mock_data.py --rows 100000
```
- Custom options:
  - `--rows 100000`: Number of telemetry rows to synthesize.
  - `--output data/my_custom_data.csv`: Custom output path.
  - `--interval 60`: Sampling interval in seconds.
  - `--seed 42`: Deterministic random seed.

### Step 3: Train Regression Model & Evaluate
```bash
python train_regression_model.py --compare-all
```
- Trains and compares:
  - Linear Regression
  - Ridge Regression
  - Random Forest Regressor
  - HistGradientBoosting Regressor (Champion)
- Automatically saves champion model pipeline to `models/ac_power_regressor.joblib` and metrics to `models/model_metrics.json`.

### Step 4: Launch Streamlit Analytics Dashboard
```bash
streamlit run app.py
```
Dashboard features:
- **📊 Overview:** Executive summary KPIs, total energy cost (IDR / USD), and system topology.
- **📈 EDA:** Diurnal heat profiles, correlation heatmaps, and occupancy distributions.
- **🧠 Model Evaluation:** $R^2$, RMSE, MAE metrics, parity scatter plots, residual distributions, and feature importance rankings.
- **🔮 Real-Time Sandbox:** "What-If" simulator with dynamic sliders for immediate power load prediction and efficiency ratings.
- **⚡ Batch & Scenarios:** Preset real-world tests (Heatwave, Eco Mode, Auto-Off) and custom CSV batch inference.
- **🔗 IoT Hardware API:** Live health check and telemetry inspection with the FastAPI Consumer node (`consumer/main.py`).
