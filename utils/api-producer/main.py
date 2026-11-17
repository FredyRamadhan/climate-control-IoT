#!/usr/bin/env python3
"""
IoT Auto Climate Control Module — API-Producer Node
Periodically queries the OpenWeatherMap API and publishes current weather metrics to MQTT.
Conforms to specsheet.md Section 5.4 and Section 6.
"""

import os
import sys
import time
import json
import signal
import logging
import argparse
import requests
from pathlib import Path
from dotenv import load_dotenv
import paho.mqtt.client as mqtt

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [API-Producer] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("api-producer")

# Load environment variables
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    load_dotenv(dotenv_path=env_path)
else:
    load_dotenv()

MQTT_HOST = os.getenv("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "iot_user")
MQTT_PASS = os.getenv("MQTT_PASS", "iot_password")
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
CITY = os.getenv("CITY", "Jakarta")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "600"))

TOPIC_WEATHER = "api/weather"
OPENWEATHER_BASE_URL = "https://api.openweathermap.org/data/2.5/weather"

running = True


def signal_handler(signum, frame):
    global running
    logger.info(f"Received signal {signum}, initiating graceful shutdown...")
    running = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def fetch_weather(city: str, api_key: str) -> dict:
    """
    Fetches real-time weather from OpenWeatherMap.
    Falls back gracefully to simulated realistic metrics if API key is invalid/unconfigured.
    """
    if api_key and api_key not in ["YOUR_OPENWEATHER_API_KEY", "mock_dev_key"]:
        try:
            params = {
                "q": city,
                "appid": api_key,
                "units": "metric",
            }
            response = requests.get(OPENWEATHER_BASE_URL, params=params, timeout=10)
            if response.status_code == 200:
                data = response.json()
                return {
                    "city": str(data.get("name", city)),
                    "temp_c": round(float(data["main"]["temp"]), 1),
                    "hum": int(data["main"]["humidity"]),
                    "desc": str(data["weather"][0]["description"]),
                    "ts": int(data.get("dt", time.time())),
                }
            else:
                logger.warning(
                    f"OpenWeatherMap API responded with status {response.status_code}: {response.text}"
                )
        except requests.RequestException as e:
            logger.error(f"Network error querying OpenWeatherMap: {e}")

    # Fallback simulation when API key is a dummy/unreachable
    logger.info("Using simulated weather metric fallback for node operations.")
    return {
        "city": str(city),
        "temp_c": 28.5,
        "hum": 75,
        "desc": "scattered clouds (simulated)",
        "ts": int(time.time()),
    }


def create_mqtt_client() -> mqtt.Client:
    """Initializes and connects Paho MQTT client."""
    # Support both paho-mqtt 2.x and 1.x
    try:
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="api-producer-node",
        )
    except AttributeError:
        client = mqtt.Client(client_id="api-producer-node")

    if MQTT_USER and MQTT_PASS:
        client.username_pw_set(MQTT_USER, MQTT_PASS)

    def on_connect(c, userdata, flags, rc, properties=None):
        rc_code = rc if isinstance(rc, int) else rc.value
        if rc_code == 0:
            logger.info(f"Connected to MQTT Broker at {MQTT_HOST}:{MQTT_PORT}")
        else:
            logger.error(f"Failed to connect to MQTT broker, return code: {rc_code}")

    def on_disconnect(c, userdata, flags_or_rc, *args):
        logger.warning("Disconnected from MQTT Broker. Automatic reconnect active.")

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    return client


def main():
    parser = argparse.ArgumentParser(description="IoT API-Producer Node")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Poll weather once, publish, and exit (useful for test & verification)",
    )
    args = parser.parse_args()

    logger.info("Initializing API-Producer Node...")
    logger.info(f"Target City: {CITY} | Poll Interval: {POLL_SECONDS}s")

    client = create_mqtt_client()

    try:
        client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
        client.loop_start()
    except Exception as e:
        logger.error(f"Error connecting to MQTT Broker: {e}")
        sys.exit(1)

    # Initial publish
    try:
        while running:
            weather_data = fetch_weather(CITY, OPENWEATHER_API_KEY)
            payload_str = json.dumps(weather_data)

            # QoS 1, Retained true per specification
            msg_info = client.publish(TOPIC_WEATHER, payload_str, qos=1, retain=True)
            msg_info.wait_for_publish(timeout=5)

            logger.info(
                f"Published to '{TOPIC_WEATHER}' (QoS 1, retain=True): {payload_str}"
            )

            if args.once:
                break

            # Sleep in intervals of 1s to react to signals quickly
            sleep_elapsed = 0
            while running and sleep_elapsed < POLL_SECONDS:
                time.sleep(1)
                sleep_elapsed += 1

    finally:
        logger.info("Cleaning up and disconnecting MQTT client...")
        client.loop_stop()
        client.disconnect()
        logger.info("API-Producer stopped.")


if __name__ == "__main__":
    main()
