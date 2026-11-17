#!/usr/bin/env python3
"""
IoT Auto Climate Control Module — Comprehensive Streamlit Analytics & ML Dashboard
Provides end-to-end telemetry analytics, regression model evaluation, real-time prediction sandbox,
scenario simulation, and hardware REST API integration for the IoT Climate Control system.
"""

import os
import json
import logging
from pathlib import Path
from typing import Optional, Dict, Any

import streamlit as st
import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import joblib

# Page configuration
st.set_page_config(
    page_title="IoT Climate & AC Power Analytics",
    page_icon="❄️",
    layout="wide",
    initial_sidebar_state="expanded",
)

# Custom Styling
st.markdown(
    """
    <style>
    .metric-card {
        background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
        border: 1px solid #334155;
        border-radius: 10px;
        padding: 16px 20px;
        color: #f8fafc;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
    }
    .metric-title {
        font-size: 0.85rem;
        font-weight: 600;
        text-transform: uppercase;
        color: #94a3b8;
        letter-spacing: 0.05em;
    }
    .metric-value {
        font-size: 1.85rem;
        font-weight: 700;
        color: #38bdf8;
        margin-top: 4px;
    }
    .metric-sub {
        font-size: 0.8rem;
        color: #64748b;
        margin-top: 2px;
    }
    .status-badge-on {
        background-color: #065f46;
        color: #34d399;
        padding: 4px 10px;
        border-radius: 6px;
        font-weight: 600;
        font-size: 0.85rem;
    }
    .status-badge-off {
        background-color: #374151;
        color: #9ca3af;
        padding: 4px 10px;
        border-radius: 6px;
        font-weight: 600;
        font-size: 0.85rem;
    }
    .stTabs [data-baseweb="tab-list"] {
        gap: 8px;
    }
    .stTabs [data-baseweb="tab"] {
        height: 48px;
        padding-left: 18px;
        padding-right: 18px;
        border-radius: 6px 6px 0 0;
        font-weight: 600;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

# Paths resolution relative to analytics directory
ANALYTICS_DIR = Path(__file__).resolve().parent
DATA_PATH = ANALYTICS_DIR / "data" / "climate_telemetry_100k.csv"
MODEL_PATH = ANALYTICS_DIR / "models" / "ac_power_regressor.joblib"
METRICS_PATH = ANALYTICS_DIR / "models" / "model_metrics.json"
PREDICTIONS_PATH = ANALYTICS_DIR / "models" / "test_predictions_sample.csv"


# -----------------------------------------------------------------------------
# Data & Model Loaders (Cached)
# -----------------------------------------------------------------------------
@st.cache_data(show_spinner=False)
def load_telemetry_data(csv_path: str, max_rows: Optional[int] = None) -> Optional[pd.DataFrame]:
    """Loads and caches the generated telemetry dataset."""
    p = Path(csv_path)
    if not p.exists():
        return None
    try:
        df = pd.read_csv(p, nrows=max_rows)
        if "timestamp" in df.columns:
            df["timestamp"] = pd.to_datetime(df["timestamp"])
        return df
    except Exception as e:
        st.error(f"Error loading dataset: {e}")
        return None


@st.cache_resource(show_spinner=False)
def load_trained_model(model_path: str):
    """Loads and caches the trained scikit-learn regression pipeline."""
    p = Path(model_path)
    if not p.exists():
        return None
    try:
        model = joblib.load(p)
        return model
    except Exception as e:
        st.error(f"Error loading model artifact: {e}")
        return None


@st.cache_data(show_spinner=False)
def load_model_metadata(metrics_path: str) -> Optional[Dict[str, Any]]:
    """Loads evaluation metrics and training metadata."""
    p = Path(metrics_path)
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


# -----------------------------------------------------------------------------
# Sidebar Navigation & System Status
# -----------------------------------------------------------------------------
def render_sidebar():
    with st.sidebar:
        st.title("❄️ Climate AI Control")
        st.caption("IoT Telemetry & Regression Hub")
        st.markdown("---")

        # System Artifact Status
        data_exists = DATA_PATH.exists()
        model_exists = MODEL_PATH.exists()

        st.subheader("System Status")
        col_s1, col_s2 = st.columns(2)
        with col_s1:
            if data_exists:
                st.markdown("🟢 **Data Ready**")
                file_mb = DATA_PATH.stat().st_size / (1024 * 1024)
                st.caption(f"{file_mb:.1f} MB CSV")
            else:
                st.markdown("🔴 **No Data**")
                st.caption("Needs Generation")

        with col_s2:
            if model_exists:
                st.markdown("🟢 **Model Ready**")
                st.caption("Champion Active")
            else:
                st.markdown("🟠 **No Model**")
                st.caption("Needs Training")

        st.markdown("---")

        # Electricity Cost Settings
        st.subheader("Tariff Configuration")
        currency = st.selectbox("Currency", ["IDR (PLN)", "USD ($)"], index=0)
        if currency == "IDR (PLN)":
            tariff_kwh = st.number_input("Tariff per kWh (Rp)", value=1444, step=50)
            currency_symbol = "Rp"
        else:
            tariff_kwh = st.number_input("Tariff per kWh ($)", value=0.15, step=0.01)
            currency_symbol = "$"

        st.markdown("---")
        st.caption("IoT Auto Climate Control — Tubes System v1.0")

    return {
        "tariff_kwh": tariff_kwh,
        "currency_symbol": currency_symbol,
        "data_exists": data_exists,
        "model_exists": model_exists,
    }


# -----------------------------------------------------------------------------
# Page: Executive Overview & System Architecture
# -----------------------------------------------------------------------------
def page_executive_overview(df: Optional[pd.DataFrame], config: Dict[str, Any]):
    st.header("📊 Executive Overview & System Architecture")
    st.markdown(
        """
        The **Auto Climate Control Module** combines ESP8266 edge sensing (PIR occupancy, DHT11 temp/humidity),
        authenticated Eclipse Mosquitto MQTT messaging, external OpenWeather API forecasting, and
        machine learning predictive modeling to optimize air conditioner energy consumption.
        """
    )

    if df is None:
        st.warning(
            f"⚠️ Telemetry dataset not found at `{DATA_PATH}`.\n\n"
            "Please generate the 100,000-row mock dataset first by running:\n"
            "```bash\npython tubes/analytics/generate_mock_data.py --rows 100000\n```"
        )
        return

    # Top KPI Cards
    total_records = len(df)
    active_mask = df["ac_power_state"] == 1
    active_ratio = (active_mask.mean()) * 100
    avg_power = df["ac_power_consumption_w"].mean()
    active_avg_power = df.loc[active_mask, "ac_power_consumption_w"].mean()
    avg_indoor_t = df["indoor_temp_c"].mean()
    avg_outdoor_t = df["outdoor_temp_c"].mean()

    # Total energy calculation assuming 60s sampling interval
    total_energy_kwh = (df["ac_power_consumption_w"].sum() * (60.0 / 3600.0)) / 1000.0
    total_cost = total_energy_kwh * config["tariff_kwh"]

    col1, col2, col3, col4, col5 = st.columns(5)
    with col1:
        st.markdown(
            f"""
            <div class="metric-card">
                <div class="metric-title">Total Observations</div>
                <div class="metric-value">{total_records:,}</div>
                <div class="metric-sub">100k Mock Telemetry Records</div>
            </div>
            """,
            unsafe_allow_html=True,
        )
    with col2:
        st.markdown(
            f"""
            <div class="metric-card">
                <div class="metric-title">AC Duty Cycle</div>
                <div class="metric-value">{active_ratio:.1f}%</div>
                <div class="metric-sub">Active Cooling State</div>
            </div>
            """,
            unsafe_allow_html=True,
        )
    with col3:
        st.markdown(
            f"""
            <div class="metric-card">
                <div class="metric-title">Mean AC Load</div>
                <div class="metric-value">{avg_power:.1f} W</div>
                <div class="metric-sub">{active_avg_power:.1f} W during active duty</div>
            </div>
            """,
            unsafe_allow_html=True,
        )
    with col4:
        st.markdown(
            f"""
            <div class="metric-card">
                <div class="metric-title">Indoor / Outdoor Temp</div>
                <div class="metric-value">{avg_indoor_t:.1f}° / {avg_outdoor_t:.1f}°</div>
                <div class="metric-sub">Mean Ambient Temperatures</div>
            </div>
            """,
            unsafe_allow_html=True,
        )
    with col5:
        st.markdown(
            f"""
            <div class="metric-card">
                <div class="metric-title">Cumulative Energy</div>
                <div class="metric-value">{total_energy_kwh:,.1f} kWh</div>
                <div class="metric-sub">Est. Cost: {config['currency_symbol']} {total_cost:,.0f}</div>
            </div>
            """,
            unsafe_allow_html=True,
        )

    st.markdown("###")

    # Architecture Visual Pipeline
    col_arch, col_spec = st.columns([1.4, 1])
    with col_arch:
        st.subheader("System Topology Flow")
        st.markdown(
            """
            ```text
            [ ESP8266 Transmitter ]  ── PIR + DHT11 ──> [ MQTT: transmit/data ]
                     │ (38kHz NEC IR)                            │
                     ▼                                           ▼
            [ AC Unit Controller ]                  [ Eclipse Mosquitto Broker ]
                     ▲                                           │
                     │ (250 VAC Relay)                           ├─> [ MQTT: receive/ack ]
            [ ESP8266 Receiver ]    <── VS1838B IR ──────────────┤
                                                                 │
            [ OpenWeather API-Producer ] ── Weather ─────────────┴─> [ MQTT: api/weather ]
                                                                         │
                                                                         ▼
                                                            [ FastAPI Consumer Node ]
                                                                         │
                                                                         ▼
                                                       [ Streamlit Analytics & ML ]
            ```
            """
        )

    with col_spec:
        st.subheader("Implemented Control Rules")
        st.markdown(
            """
            - **Rule 1 (Hot Occupancy):** `motion == True` & `temp > 28°C` → Target 16°C, Full Power (Max cooling).
            - **Rule 2 (Vacant Moderation):** `motion == False` (> 5 min) & `temp < 24°C` → Target 24°C, Eco Moderation.
            - **Rule 3 (Vacant Auto-Off):** `motion == False` (> 10 min) → Auto Power Off to 4.5W Standby.
            - **Default Occupied:** `motion == True` & `temp <= 28°C` → Target 24°C Baseline Comfort.
            """
        )

    # Telemetry Sample Table
    with st.expander("🔍 View Raw Telemetry Data Sample (First 25 Rows)", expanded=False):
        st.dataframe(df.head(25), use_container_width=True)


# -----------------------------------------------------------------------------
# Page: Exploratory Data Analytics (EDA)
# -----------------------------------------------------------------------------
def page_exploratory_analytics(df: Optional[pd.DataFrame]):
    st.header("📈 Exploratory Data Analytics (EDA)")

    if df is None:
        st.warning(f"Dataset not available at `{DATA_PATH}`. Please run data generation script first.")
        return

    st.markdown("Comprehensive statistical distribution, diurnal patterns, and cross-feature correlations.")

    # Slicing for fast responsive visualization if dataset is 100k rows
    sample_size = min(15000, len(df))
    df_sample = df.sample(n=sample_size, random_state=42).copy() if len(df) > sample_size else df.copy()

    tab1, tab2, tab3, tab4 = st.tabs(
        ["🌡️ Thermal Dynamics", "🕒 Diurnal Patterns", "👥 Occupancy & Load", "🔥 Correlation Heatmap"]
    )

    with tab1:
        st.subheader("Ambient Thermal Profiles")
        col_t1, col_t2 = st.columns(2)

        with col_t1:
            fig_temp = px.histogram(
                df_sample,
                x=["indoor_temp_c", "outdoor_temp_c"],
                barmode="overlay",
                nbins=50,
                opacity=0.7,
                title="Indoor vs Outdoor Temperature Distribution (°C)",
                labels={"value": "Temperature (°C)", "variable": "Sensor"},
                color_discrete_map={"indoor_temp_c": "#38bdf8", "outdoor_temp_c": "#f97316"},
            )
            fig_temp.update_layout(template="plotly_dark", legend=dict(yanchor="top", y=0.95, xanchor="right", x=0.95))
            st.plotly_chart(fig_temp, use_container_width=True)

        with col_t2:
            fig_hum = px.histogram(
                df_sample,
                x=["indoor_humidity", "outdoor_humidity"],
                barmode="overlay",
                nbins=50,
                opacity=0.7,
                title="Indoor vs Outdoor Relative Humidity Distribution (%)",
                labels={"value": "Relative Humidity (%)", "variable": "Sensor"},
                color_discrete_map={"indoor_humidity": "#34d399", "outdoor_humidity": "#60a5fa"},
            )
            fig_hum.update_layout(template="plotly_dark", legend=dict(yanchor="top", y=0.95, xanchor="right", x=0.95))
            st.plotly_chart(fig_hum, use_container_width=True)

        # Delta T vs Power
        fig_scatter = px.scatter(
            df_sample[df_sample["ac_power_state"] == 1].sample(min(3000, len(df_sample))),
            x="temp_delta",
            y="ac_power_consumption_w",
            color="occupancy_count",
            size="outdoor_temp_c",
            title="AC Power Consumption vs Cooling Delta (Indoor Temp - Target Temp)",
            labels={
                "temp_delta": "Temperature Delta (°C)",
                "ac_power_consumption_w": "AC Power (Watts)",
                "occupancy_count": "Occupants",
            },
            color_continuous_scale="Viridis",
        )
        fig_scatter.update_layout(template="plotly_dark")
        st.plotly_chart(fig_scatter, use_container_width=True)

    with tab2:
        st.subheader("Diurnal 24-Hour Cycle Analysis")
        # Hourly grouping
        hourly_summary = (
            df.groupby(df["hour_of_day"].round().astype(int))
            .agg(
                avg_power=("ac_power_consumption_w", "mean"),
                avg_indoor_temp=("indoor_temp_c", "mean"),
                avg_outdoor_temp=("outdoor_temp_c", "mean"),
                active_duty=("ac_power_state", "mean"),
            )
            .reset_index()
        )

        fig_diurnal = make_subplots(specs=[[{"secondary_y": True}]])
        fig_diurnal.add_trace(
            go.Scatter(
                x=hourly_summary["hour_of_day"],
                y=hourly_summary["avg_power"],
                name="Avg Power (W)",
                line=dict(color="#38bdf8", width=3),
            ),
            secondary_y=False,
        )
        fig_diurnal.add_trace(
            go.Scatter(
                x=hourly_summary["hour_of_day"],
                y=hourly_summary["avg_outdoor_temp"],
                name="Outdoor Temp (°C)",
                line=dict(color="#f97316", width=2, dash="dash"),
            ),
            secondary_y=True,
        )
        fig_diurnal.add_trace(
            go.Scatter(
                x=hourly_summary["hour_of_day"],
                y=hourly_summary["avg_indoor_temp"],
                name="Indoor Temp (°C)",
                line=dict(color="#34d399", width=2),
            ),
            secondary_y=True,
        )

        fig_diurnal.update_layout(
            title="Diurnal Load Profile: Mean Power Load & Temperature by Hour of Day",
            template="plotly_dark",
            xaxis_title="Hour of Day (00:00 - 23:00)",
            hovermode="x unified",
        )
        fig_diurnal.update_yaxes(title_text="Power Consumption (Watts)", secondary_y=False)
        fig_diurnal.update_yaxes(title_text="Temperature (°C)", secondary_y=True)
        st.plotly_chart(fig_diurnal, use_container_width=True)

    with tab3:
        st.subheader("PIR Motion & Room Occupancy Impact")
        col_o1, col_o2 = st.columns(2)

        with col_o1:
            fig_occ_box = px.box(
                df_sample[df_sample["ac_power_state"] == 1],
                x="occupancy_count",
                y="ac_power_consumption_w",
                color="occupancy_count",
                title="Power Consumption Distribution by Room Occupant Count (Active AC)",
                labels={"occupancy_count": "Number of Occupants", "ac_power_consumption_w": "Power (W)"},
            )
            fig_occ_box.update_layout(template="plotly_dark", showlegend=False)
            st.plotly_chart(fig_occ_box, use_container_width=True)

        with col_o2:
            fig_weather = px.bar(
                df.groupby("weather_condition")["ac_power_consumption_w"].mean().reset_index(),
                x="weather_condition",
                y="ac_power_consumption_w",
                color="weather_condition",
                title="Mean AC Power Consumption by Weather Condition",
                labels={"weather_condition": "OpenWeather Condition", "ac_power_consumption_w": "Mean Power (W)"},
                color_discrete_sequence=px.colors.qualitative.Plotly,
            )
            fig_weather.update_layout(template="plotly_dark", showlegend=False)
            st.plotly_chart(fig_weather, use_container_width=True)

    with tab4:
        st.subheader("Pearson Correlation Matrix")
        numeric_cols = [
            "indoor_temp_c",
            "indoor_humidity",
            "outdoor_temp_c",
            "outdoor_humidity",
            "motion_detected",
            "occupancy_count",
            "target_temp_c",
            "temp_delta",
            "ac_power_state",
            "ac_power_consumption_w",
        ]
        corr = df_sample[numeric_cols].corr()

        fig_corr = px.imshow(
            corr,
            text_auto=".2f",
            aspect="auto",
            color_continuous_scale="RdBu_r",
            title="Correlation Heatmap of Telemetry Features and AC Power Target",
        )
        fig_corr.update_layout(template="plotly_dark")
        st.plotly_chart(fig_corr, use_container_width=True)


# -----------------------------------------------------------------------------
# Page: Model Performance & Evaluation Hub
# -----------------------------------------------------------------------------
def page_model_evaluation(metadata: Optional[Dict[str, Any]]):
    st.header("🧠 Model Performance & Evaluation Hub")

    if metadata is None:
        st.warning(
            f"⚠️ Model evaluation metadata not found at `{METRICS_PATH}`.\n\n"
            "Train the regression model first by running:\n"
            "```bash\npython tubes/analytics/train_regression_model.py --compare-all\n```"
        )
        return

    champion_name = metadata.get("champion_model", "Unknown")
    metrics = metadata.get("champion_metrics", {})
    all_benchmarks = metadata.get("all_model_benchmarks", {})
    importances = metadata.get("feature_importances", {})

    st.success(f"🏆 Active Champion Estimator: **{champion_name.upper()}**")

    # Metric scorecard
    col_m1, col_m2, col_m3, col_m4, col_m5 = st.columns(5)
    with col_m1:
        st.metric("R² Score (Goodness of Fit)", f"{metrics.get('r2_score', 0):.4f}")
    with col_m2:
        st.metric("Root Mean Squared Error (RMSE)", f"{metrics.get('rmse', 0):.2f} W")
    with col_m3:
        st.metric("Mean Absolute Error (MAE)", f"{metrics.get('mae', 0):.2f} W")
    with col_m4:
        st.metric("Mean Absolute Percentage Error (MAPE)", f"{metrics.get('mape_percent', 0):.2f}%")
    with col_m5:
        st.metric("Training Time", f"{metrics.get('fit_duration_seconds', 0):.2f}s")

    st.markdown("---")

    col_bench, col_imp = st.columns([1, 1])

    with col_bench:
        st.subheader("Model Benchmark Comparison")
        if all_benchmarks:
            bench_df = pd.DataFrame(all_benchmarks).T.reset_index()
            bench_df.rename(columns={"index": "Model"}, inplace=True)
            st.dataframe(bench_df, use_container_width=True)

            fig_comp = px.bar(
                bench_df,
                x="Model",
                y="r2_score",
                color="Model",
                title="Model Comparison by R² Score",
                text_auto=".4f",
            )
            fig_comp.update_layout(template="plotly_dark", showlegend=False, yaxis_range=[0.8, 1.0])
            st.plotly_chart(fig_comp, use_container_width=True)
        else:
            st.info("Single model benchmark recorded.")

    with col_imp:
        st.subheader("Top Predictive Feature Importances")
        if importances:
            imp_df = pd.DataFrame(list(importances.items()), columns=["Feature", "Importance"])
            imp_df = imp_df.sort_values(by="Importance", ascending=True).tail(10)

            fig_imp = px.bar(
                imp_df,
                x="Importance",
                y="Feature",
                orientation="h",
                title="Top 10 Feature Drivers of AC Power",
                color="Importance",
                color_continuous_scale="Blues",
            )
            fig_imp.update_layout(template="plotly_dark", showlegend=False)
            st.plotly_chart(fig_imp, use_container_width=True)

    # Parity & Residual Diagnostic Plots
    st.subheader("Parity Plot & Residual Diagnostics")
    if PREDICTIONS_PATH.exists():
        pred_df = pd.read_csv(PREDICTIONS_PATH)
        col_p1, col_p2 = st.columns(2)

        with col_p1:
            fig_parity = px.scatter(
                pred_df,
                x="actual_power_w",
                y="predicted_power_w",
                opacity=0.6,
                title="Actual vs Predicted AC Power (Parity Plot)",
                labels={"actual_power_w": "Actual Telemetry Power (W)", "predicted_power_w": "Model Prediction (W)"},
            )
            # Add identity diagonal
            min_val = min(pred_df["actual_power_w"].min(), pred_df["predicted_power_w"].min())
            max_val = max(pred_df["actual_power_w"].max(), pred_df["predicted_power_w"].max())
            fig_parity.add_shape(
                type="line",
                x0=min_val,
                y0=min_val,
                x1=max_val,
                y1=max_val,
                line=dict(color="#ef4444", dash="dash", width=2),
            )
            fig_parity.update_layout(template="plotly_dark")
            st.plotly_chart(fig_parity, use_container_width=True)

        with col_p2:
            fig_resid = px.histogram(
                pred_df,
                x="residual_w",
                nbins=60,
                title="Residual Error Distribution (Actual - Predicted)",
                labels={"residual_w": "Residual Error (Watts)"},
                color_discrete_sequence=["#38bdf8"],
            )
            fig_resid.update_layout(template="plotly_dark")
            st.plotly_chart(fig_resid, use_container_width=True)
    else:
        st.info("Test holdout predictions sample not found. Re-run model training to generate parity plots.")


# -----------------------------------------------------------------------------
# Page: Real-Time Prediction Sandbox ("What-If" Simulator)
# -----------------------------------------------------------------------------
def page_realtime_prediction(model: Any, config: Dict[str, Any]):
    st.header("🔮 Real-Time Prediction Sandbox (What-If Simulator)")
    st.markdown(
        "Interactively adjust environmental, sensor, and AC control parameters to predict power load in real-time."
    )

    if model is None:
        st.warning(
            f"⚠️ Trained model not found at `{MODEL_PATH}`.\n\n"
            "Please train the model first by running:\n"
            "```bash\npython tubes/analytics/train_regression_model.py\n```"
        )
        return

    col_input1, col_input2 = st.columns(2)

    with col_input1:
        st.subheader("Sensor & Ambient Conditions")
        indoor_temp = st.slider("Indoor Temperature (°C) [DHT11]", 18.0, 36.0, 28.5, 0.1)
        indoor_hum = st.slider("Indoor Relative Humidity (%) [DHT11]", 35.0, 90.0, 65.0, 0.5)
        outdoor_temp = st.slider("Outdoor Temperature (°C) [OpenWeather]", 20.0, 42.0, 33.0, 0.1)
        outdoor_hum = st.slider("Outdoor Relative Humidity (%) [OpenWeather]", 40.0, 98.0, 75.0, 0.5)
        weather_cond = st.selectbox("Weather Condition", ["Clear", "Clouds", "Rain", "Thunderstorm"], index=1)
        hour_of_day = st.slider("Hour of Day (24h Clock)", 0.0, 23.9, 14.0, 0.5)

    with col_input2:
        st.subheader("AC Controls & Occupancy")
        ac_power_state = st.radio("AC Power State", ["ON (Active)", "OFF (Standby)"], horizontal=True)
        ac_pwr_int = 1 if ac_power_state.startswith("ON") else 0

        target_temp = st.slider("AC Target Temperature (°C) [NEC IR Setpoint]", 16, 30, 24, 1)
        fan_speed = st.selectbox("Fan Speed", ["Low", "Medium", "High", "Auto", "Off"], index=1 if ac_pwr_int else 4)
        motion_detected = st.toggle("PIR Motion Detected (HC-SR501)", value=True)
        motion_int = 1 if motion_detected else 0
        occupancy_count = st.number_input("Estimated Room Occupancy Count", min_value=0, max_value=20, value=3 if motion_detected else 0)

    # Compute derived features
    temp_delta = indoor_temp - target_temp

    # Assemble inference input dataframe
    input_data = pd.DataFrame(
        [
            {
                "indoor_temp_c": indoor_temp,
                "indoor_humidity": indoor_hum,
                "outdoor_temp_c": outdoor_temp,
                "outdoor_humidity": outdoor_hum,
                "occupancy_count": occupancy_count,
                "target_temp_c": target_temp,
                "temp_delta": temp_delta,
                "hour_of_day": hour_of_day,
                "motion_detected": motion_int,
                "ac_power_state": ac_pwr_int,
                "weather_condition": weather_cond,
                "fan_speed": fan_speed,
            }
        ]
    )

    # Perform prediction
    pred_power = float(model.predict(input_data)[0])
    pred_power = max(0.0, pred_power)
    pred_kw = pred_power / 1000.0

    # Cost calculations
    hourly_cost = pred_kw * config["tariff_kwh"]
    daily_cost_24h = hourly_cost * 24.0
    daily_cost_8h = hourly_cost * 8.0
    monthly_cost = daily_cost_8h * 30.0

    st.markdown("---")
    st.subheader("Prediction Results & Operational Insights")

    col_res1, col_res2, col_res3 = st.columns([1.2, 1, 1])

    with col_res1:
        st.markdown(
            f"""
            <div class="metric-card" style="border-left: 5px solid #38bdf8;">
                <div class="metric-title">Predicted AC Power Consumption</div>
                <div class="metric-value">{pred_power:.1f} W <span style="font-size: 1.1rem; color: #94a3b8;">({pred_kw:.3f} kW)</span></div>
                <div class="metric-sub">Thermal Delta: {temp_delta:+.1f}°C | Fan: {fan_speed}</div>
            </div>
            """,
            unsafe_allow_html=True,
        )

    with col_res2:
        st.markdown(
            f"""
            <div class="metric-card" style="border-left: 5px solid #34d399;">
                <div class="metric-title">Operating Cost Projection</div>
                <div class="metric-value">{config['currency_symbol']} {hourly_cost:.2f} <span style="font-size: 0.9rem; color: #94a3b8;">/ hour</span></div>
                <div class="metric-sub">Est. 8h/day: {config['currency_symbol']} {daily_cost_8h:,.0f} | 30d: {config['currency_symbol']} {monthly_cost:,.0f}</div>
            </div>
            """,
            unsafe_allow_html=True,
        )

    with col_res3:
        if ac_pwr_int == 0:
            status_text = "Standby Mode"
            badge_color = "#64748b"
            advice = "AC is switched OFF. Unit draws minimal parasitic standby electronics power (~4.5W)."
        elif pred_power < 500:
            status_text = "Eco Saver Mode"
            badge_color = "#34d399"
            advice = "Room is near target temperature. Inverter compressor running at low frequency."
        elif pred_power < 1100:
            status_text = "Nominal Comfort Load"
            badge_color = "#38bdf8"
            advice = "Standard operational duty. Compressor maintaining balanced comfort setpoint."
        else:
            status_text = "Heavy Cooling Load"
            badge_color = "#f97316"
            advice = "High cooling demand due to large temperature delta and occupancy. Consider raising target by 1-2°C."

        st.markdown(
            f"""
            <div class="metric-card" style="border-left: 5px solid {badge_color};">
                <div class="metric-title">Efficiency Rating</div>
                <div class="metric-value" style="color: {badge_color};">{status_text}</div>
                <div class="metric-sub">{advice}</div>
            </div>
            """,
            unsafe_allow_html=True,
        )


# -----------------------------------------------------------------------------
# Page: Batch Prediction & Presets
# -----------------------------------------------------------------------------
def page_batch_scenarios(model: Any):
    st.header("⚡ Batch Prediction & Preset Scenarios")
    st.markdown("Test realistic pre-configured scenarios or upload your own CSV dataset for batch inference.")

    if model is None:
        st.warning(f"Trained model not available at `{MODEL_PATH}`. Please train the model first.")
        return

    tab_preset, tab_upload = st.tabs(["📋 Preset Test Scenarios", "📁 Batch CSV Ingestion"])

    with tab_preset:
        st.subheader("Select Realistic Test Case")
        scenarios = {
            "☀️ Scorching Afternoon Peak (8 Occupants, 36°C Outdoor)": {
                "indoor_temp_c": 30.5,
                "indoor_humidity": 68.0,
                "outdoor_temp_c": 36.5,
                "outdoor_humidity": 60.0,
                "occupancy_count": 8,
                "target_temp_c": 18,
                "temp_delta": 12.5,
                "hour_of_day": 14.0,
                "motion_detected": 1,
                "ac_power_state": 1,
                "weather_condition": "Clear",
                "fan_speed": "High",
            },
            "🌱 Mild Afternoon Eco Mode (2 Occupants, 28°C Outdoor)": {
                "indoor_temp_c": 24.5,
                "indoor_humidity": 55.0,
                "outdoor_temp_c": 28.0,
                "outdoor_humidity": 70.0,
                "occupancy_count": 2,
                "target_temp_c": 24,
                "temp_delta": 0.5,
                "hour_of_day": 16.0,
                "motion_detected": 1,
                "ac_power_state": 1,
                "weather_condition": "Clouds",
                "fan_speed": "Medium",
            },
            "🌙 Vacant Moderation Rule (0 Occupants, 24°C Outdoor)": {
                "indoor_temp_c": 23.5,
                "indoor_humidity": 50.0,
                "outdoor_temp_c": 24.0,
                "outdoor_humidity": 85.0,
                "occupancy_count": 0,
                "target_temp_c": 24,
                "temp_delta": -0.5,
                "hour_of_day": 22.0,
                "motion_detected": 0,
                "ac_power_state": 1,
                "weather_condition": "Rain",
                "fan_speed": "Low",
            },
            "💤 Off-Hour Auto-Off Standby (0 Occupants, Night)": {
                "indoor_temp_c": 26.0,
                "indoor_humidity": 65.0,
                "outdoor_temp_c": 23.0,
                "outdoor_humidity": 90.0,
                "occupancy_count": 0,
                "target_temp_c": 24,
                "temp_delta": 2.0,
                "hour_of_day": 3.0,
                "motion_detected": 0,
                "ac_power_state": 0,
                "weather_condition": "Clouds",
                "fan_speed": "Off",
            },
        }

        selected_scenario_name = st.selectbox("Choose Scenario", list(scenarios.keys()))
        scenario_data = pd.DataFrame([scenarios[selected_scenario_name]])

        st.dataframe(scenario_data, use_container_width=True)

        predicted_val = model.predict(scenario_data)[0]
        st.success(f"Predicted Power for **{selected_scenario_name}**: **{predicted_val:.2f} Watts**")

    with tab_upload:
        st.subheader("Upload Batch CSV for Prediction")
        uploaded_file = st.file_uploader("Upload CSV file containing telemetry columns", type=["csv"])
        if uploaded_file is not None:
            batch_df = pd.read_csv(uploaded_file)
            st.write(f"Uploaded {len(batch_df)} rows.")

            # Ensure temp_delta exists
            if "temp_delta" not in batch_df.columns and "indoor_temp_c" in batch_df.columns and "target_temp_c" in batch_df.columns:
                batch_df["temp_delta"] = batch_df["indoor_temp_c"] - batch_df["target_temp_c"]

            try:
                preds = model.predict(batch_df)
                batch_df["predicted_power_w"] = np.round(preds, 2)
                st.dataframe(batch_df.head(50), use_container_width=True)

                csv_bytes = batch_df.to_csv(index=False).encode("utf-8")
                st.download_button(
                    "📥 Download Predictions as CSV",
                    csv_bytes,
                    "batch_predictions.csv",
                    "text/csv",
                    key="download-batch-csv",
                )
            except Exception as e:
                st.error(f"Inference error on uploaded CSV: {e}")


# -----------------------------------------------------------------------------
# Page: IoT Hardware & API Integration
# -----------------------------------------------------------------------------
def page_hardware_integration():
    st.header("🔗 IoT Hardware & API Integration")
    st.markdown(
        """
        Check connectivity with the **FastAPI Consumer Node** (`consumer/main.py`)
        and monitor live telemetry buffers across MQTT topics.
        """
    )

    consumer_url = st.text_input("Consumer REST API Base URL", value="http://localhost:8000")

    col_btn, col_blank = st.columns([1, 3])
    with col_btn:
        check_btn = st.button("🔄 Poll Consumer REST API")

    if check_btn:
        import requests

        try:
            health_res = requests.get(f"{consumer_url}/health", timeout=2)
            if health_res.status_code == 200:
                health_data = health_res.json()
                st.success("✅ Connected to Consumer Node!")
                st.json(health_data)

                # Fetch latest topics
                col1, col2, col3 = st.columns(3)
                with col1:
                    st.subheader("Transmit Node Telemetry")
                    r_tx = requests.get(f"{consumer_url}/transmit/latest", timeout=2)
                    st.json(r_tx.json() if r_tx.status_code == 200 else {"status": "empty"})

                with col2:
                    st.subheader("Receiver Node Ack")
                    r_rx = requests.get(f"{consumer_url}/receive/latest", timeout=2)
                    st.json(r_rx.json() if r_rx.status_code == 200 else {"status": "empty"})

                with col3:
                    st.subheader("OpenWeather API Data")
                    r_wx = requests.get(f"{consumer_url}/weather/latest", timeout=2)
                    st.json(r_wx.json() if r_wx.status_code == 200 else {"status": "empty"})
            else:
                st.warning(f"Consumer responded with status code: {health_res.status_code}")
        except Exception as e:
            st.error(f"Could not connect to `{consumer_url}`. Ensure `consumer/main.py` is running! Details: {e}")


# -----------------------------------------------------------------------------
# Main Application Router
# -----------------------------------------------------------------------------
def main():
    config = render_sidebar()

    # Preload resources
    df = load_telemetry_data(str(DATA_PATH), max_rows=100000) if config["data_exists"] else None
    model = load_trained_model(str(MODEL_PATH)) if config["model_exists"] else None
    metadata = load_model_metadata(str(METRICS_PATH))

    # Top Navigation Tabs
    tabs = st.tabs(
        [
            "📊 Overview",
            "📈 Analytics (EDA)",
            "🧠 Model Evaluation",
            "🔮 Real-Time Sandbox",
            "⚡ Batch & Scenarios",
            "🔗 IoT Hardware API",
        ]
    )

    with tabs[0]:
        page_executive_overview(df, config)

    with tabs[1]:
        page_exploratory_analytics(df)

    with tabs[2]:
        page_model_evaluation(metadata)

    with tabs[3]:
        page_realtime_prediction(model, config)

    with tabs[4]:
        page_batch_scenarios(model)

    with tabs[5]:
        page_hardware_integration()


if __name__ == "__main__":
    main()
