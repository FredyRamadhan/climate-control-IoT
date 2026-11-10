#!/usr/bin/env python3
"""
IoT Auto Climate Control Module — Mock Telemetry Data Generator
Generates high-fidelity, physically consistent mock telemetry data for 100,000 rows.
Adheres to specsheet.md Section 5 (Transmitter, Receiver, API-Producer rules).
"""

import os
import argparse
import logging
from pathlib import Path
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [DataGenerator] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("generator")


def generate_climate_mock_data(
    num_rows: int = 100000,
    start_time: datetime = datetime(2026, 1, 1, 0, 0, 0),
    sample_interval_seconds: int = 60,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Generates physically consistent synthetic dataset for climate and AC power regression.

    Parameters:
    - num_rows: Number of time-series telemetry records (default: 100,000).
    - start_time: Datetime starting anchor.
    - sample_interval_seconds: Sampling cadence in seconds (default: 60s).
    - seed: Random seed for deterministic reproducibility.

    Returns:
    - pd.DataFrame containing 100,000 structured telemetry observations.
    """
    logger.info("Initializing mock data synthesis for %d rows (seed=%d)...", num_rows, seed)
    rng = np.random.default_rng(seed)

    # 1. Temporal feature scaffolding
    timestamps = [start_time + timedelta(seconds=i * sample_interval_seconds) for i in range(num_rows)]
    dt_series = pd.to_datetime(timestamps)

    hour = dt_series.hour.values + dt_series.minute.values / 60.0
    day_of_week = dt_series.dayofweek.values  # 0=Monday, 6=Sunday
    is_weekend = (day_of_week >= 5).astype(int)

    # 2. Outdoor Ambient Weather Dynamics (OpenWeather API simulation)
    # Diurnal solar cycle peak at ~14:00, coolest at ~05:00
    solar_phase = 2 * np.pi * (hour - 5) / 24.0
    diurnal_outdoor_temp = 28.0 + 5.5 * np.sin(solar_phase - np.pi / 2)  # 22.5°C to 33.5°C base

    # Multi-day atmospheric weather front variation (e.g. 5-day cycle)
    day_index = np.arange(num_rows) * (sample_interval_seconds / 86400.0)
    weather_front_fluctuation = 2.0 * np.sin(2 * np.pi * day_index / 5.2)

    # Weather condition categorization
    weather_noise = rng.normal(0, 0.8, size=num_rows)
    outdoor_temp_c = np.round(diurnal_outdoor_temp + weather_front_fluctuation + weather_noise, 2)
    outdoor_temp_c = np.clip(outdoor_temp_c, 21.0, 39.0)

    # Relative humidity is inversely correlated with temperature
    outdoor_humidity = np.round(92.0 - 1.8 * (outdoor_temp_c - 20.0) + rng.normal(0, 3.5, size=num_rows), 1)
    outdoor_humidity = np.clip(outdoor_humidity, 45.0, 98.0)

    # Determine weather descriptions
    weather_conditions = []
    condition_types = ["Clear", "Clouds", "Rain", "Thunderstorm"]
    for ot, oh in zip(outdoor_temp_c, outdoor_humidity):
        if oh > 85.0 and ot < 26.0:
            weather_conditions.append("Thunderstorm" if rng.random() > 0.65 else "Rain")
        elif oh > 70.0:
            weather_conditions.append("Clouds")
        else:
            weather_conditions.append("Clear")

    # 3. Room Occupancy & Motion Sensing (HC-SR501 PIR sensor)
    # Probability of occupancy depends on working hours (08:00 - 18:00) vs evening/night
    work_hour_mask = (hour >= 8.0) & (hour <= 18.0)
    evening_mask = (hour > 18.0) & (hour <= 22.5)

    occupancy_prob = np.where(
        is_weekend,
        np.where(work_hour_mask, 0.25, np.where(evening_mask, 0.55, 0.10)),
        np.where(work_hour_mask, 0.82, np.where(evening_mask, 0.40, 0.05)),
    )

    motion_detected = (rng.random(size=num_rows) < occupancy_prob).astype(int)

    # Continuous motion clusters (occupancy count)
    max_people = np.where(is_weekend, 4, 10)
    raw_occupancy = rng.integers(1, max_people + 1, size=num_rows) * motion_detected
    # Smooth occupancy count so people do not randomly appear and vanish in single minutes
    occupancy_count = pd.Series(raw_occupancy).rolling(window=10, min_periods=1).max().astype(int).values

    # 4. Indoor Ambient Climate (DHT11 sensor)
    # Influenced by outdoor temperature, human metabolic load, and AC status
    base_indoor_temp = 24.5 + 0.35 * (outdoor_temp_c - 26.0) + (occupancy_count * 0.32) + rng.normal(0, 0.4, size=num_rows)

    # 5. Rule-Based AC Climate Control Simulation (specsheet.md Section 5.1)
    # Rule 1: motion == 1 and temp_c > 28.0 -> target_temp = 16, PWR_ON
    # Rule 2: motion == 0 for > 5 min and temp_c < 24.0 -> target_temp = 24, PWR_ON
    # Rule 3: motion == 0 for > 10 min -> PWR_OFF
    # Default Occupied: motion == 1 and temp_c <= 28.0 -> target_temp = 24, PWR_ON
    target_temp_c = np.zeros(num_rows, dtype=int)
    ac_power_state = np.zeros(num_rows, dtype=int)
    fan_speed = []

    # Rolling vacancy window to simulate timers
    vacant_run_length = 0
    indoor_temp_sim = np.zeros(num_rows)
    curr_room_temp = 27.0

    for i in range(num_rows):
        is_motion = motion_detected[i]
        env_temp = base_indoor_temp[i]

        if is_motion:
            vacant_run_length = 0
        else:
            vacant_run_length += 1

        # Evaluate climate control rules
        if is_motion and curr_room_temp > 28.0:
            # Rule 1: Hot Occupancy
            target = 16
            pwr = 1
            fan = "High"
        elif not is_motion and vacant_run_length > 10:
            # Rule 3: Vacant Auto-Off (> 10 mins vacancy)
            target = 24
            pwr = 0
            fan = "Off"
        elif not is_motion and vacant_run_length > 5 and curr_room_temp < 24.0:
            # Rule 2: Vacant Moderation (> 5 mins vacancy)
            target = 24
            pwr = 1
            fan = "Low"
        elif is_motion:
            # Default Occupied
            target = rng.choice([22, 23, 24, 25], p=[0.2, 0.3, 0.4, 0.1])
            pwr = 1
            fan = "Auto"
        else:
            # Mild idle state
            target = 24
            pwr = 1 if rng.random() > 0.4 else 0
            fan = "Medium" if pwr else "Off"

        # Thermal evolution feedback
        cooling_effect = 0.08 * (curr_room_temp - target) if pwr == 1 else 0.0
        warming_drift = 0.03 * (env_temp - curr_room_temp)
        curr_room_temp = curr_room_temp - cooling_effect + warming_drift + rng.normal(0, 0.05)
        curr_room_temp = float(np.clip(curr_room_temp, 16.5, 34.5))

        indoor_temp_sim[i] = round(curr_room_temp, 2)
        target_temp_c[i] = target
        ac_power_state[i] = pwr
        fan_speed.append(fan)

    # Indoor Humidity (DHT11)
    indoor_humidity = np.round(
        np.clip(62.0 - 0.7 * (indoor_temp_sim - 24.0) - (10.0 * ac_power_state) + rng.normal(0, 2.0, size=num_rows), 38.0, 85.0),
        1,
    )

    # 6. Physical AC Power Consumption Regression Target (ac_power_consumption_w)
    # Physical thermodynamics model of 1.5 PK Inverter AC:
    # Standby: ~4.5 W
    # Active: Base compressor (~290W) + Delta cooling work + Outdoor lift + Human heat + Latent dehumidification
    delta_temp = np.maximum(0.0, indoor_temp_sim - target_temp_c)
    outdoor_lift = np.maximum(0.0, outdoor_temp_c - 25.0)
    latent_humidity_load = np.maximum(0.0, indoor_humidity - 50.0)

    fan_multipliers = {"Off": 0.0, "Low": 0.88, "Medium": 1.0, "High": 1.18, "Auto": 1.05}
    fan_factors = np.array([fan_multipliers.get(f, 1.0) for f in fan_speed])

    active_compressor_power = (
        290.0
        + (delta_temp * 92.0)
        + (outdoor_lift * 24.5)
        + (occupancy_count * 48.0)
        + (latent_humidity_load * 4.2)
    ) * fan_factors

    # Add realistic sensor & line fluctuations
    active_compressor_power += rng.normal(0, 16.0, size=num_rows)
    active_compressor_power = np.clip(active_compressor_power, 180.0, 2250.0)

    standby_power = 4.5 + rng.normal(0, 0.4, size=num_rows)

    ac_power_consumption_w = np.where(ac_power_state == 1, active_compressor_power, standby_power)
    ac_power_consumption_w = np.round(ac_power_consumption_w, 2)

    # Receiver Relay State mirrors AC Power State with high fidelity (99.8% match)
    relay_state = np.where(rng.random(size=num_rows) < 0.998, ac_power_state, 1 - ac_power_state)

    # Compile structured dataframe
    df = pd.DataFrame(
        {
            "timestamp": timestamps,
            "hour_of_day": np.round(hour, 2),
            "day_of_week": day_of_week,
            "is_weekend": is_weekend,
            "indoor_temp_c": indoor_temp_sim,
            "indoor_humidity": indoor_humidity,
            "outdoor_temp_c": outdoor_temp_c,
            "outdoor_humidity": outdoor_humidity,
            "weather_condition": weather_conditions,
            "motion_detected": motion_detected,
            "occupancy_count": occupancy_count,
            "target_temp_c": target_temp_c,
            "temp_delta": np.round(indoor_temp_sim - target_temp_c, 2),
            "fan_speed": fan_speed,
            "relay_state": relay_state,
            "ac_power_state": ac_power_state,
            "ac_power_consumption_w": ac_power_consumption_w,
        }
    )

    logger.info("Mock dataset successfully assembled: %s rows, %s columns.", f"{len(df):,}", len(df.columns))
    return df


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate mock telemetry dataset for IoT Auto Climate Control Module."
    )
    parser.add_argument(
        "--rows",
        type=int,
        default=100000,
        help="Number of telemetry rows to generate (default: 100,000).",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Path to save output CSV file. Defaults to tubes/analytics/data/climate_telemetry_100k.csv.",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=60,
        help="Sampling interval in seconds between data points (default: 60s).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducibility (default: 42).",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    # Determine default paths relative to this script
    script_dir = Path(__file__).resolve().parent
    if args.output:
        output_path = Path(args.output).resolve()
    else:
        output_path = script_dir / "data" / "climate_telemetry_100k.csv"

    output_path.parent.mkdir(parents=True, exist_ok=True)

    logger.info("Target output file: %s", output_path)
    df = generate_climate_mock_data(
        num_rows=args.rows,
        sample_interval_seconds=args.interval,
        seed=args.seed,
    )

    logger.info("Writing CSV to disk at %s ...", output_path)
    df.to_csv(output_path, index=False)

    file_size_mb = output_path.stat().st_size / (1024 * 1024)
    logger.info("Successfully generated mock dataset!")
    logger.info("File Size: %.2f MB", file_size_mb)
    logger.info("Dataset Summary:")
    logger.info(" - Total Rows: %s", f"{len(df):,}")
    logger.info(" - Date Range: %s -> %s", df['timestamp'].iloc[0], df['timestamp'].iloc[-1])
    logger.info(" - Active AC Duty Cycle: %.2f%%", (df['ac_power_state'].mean() * 100))
    logger.info(" - Mean Power Consumption: %.2f W", df['ac_power_consumption_w'].mean())
    logger.info(" - Indoor Temp Range: %.1f°C to %.1f°C", df['indoor_temp_c'].min(), df['indoor_temp_c'].max())
    logger.info(" - Outdoor Temp Range: %.1f°C to %.1f°C", df['outdoor_temp_c'].min(), df['outdoor_temp_c'].max())


if __name__ == "__main__":
    main()
