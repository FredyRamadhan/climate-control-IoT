#!/usr/bin/env python3
"""
IoT Auto Climate Control Module — Consumer Node
FastAPI service subscribing to telemetry topics via paho-mqtt and serving metrics over REST.
Conforms to specsheet.md Section 5.3, Section 6, and Section 10.
"""

import os
import json
import logging
from collections import deque
from threading import Lock
from pathlib import Path
from typing import Dict, Any, List, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
import paho.mqtt.client as mqtt
import uvicorn

# Logging configuration
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [Consumer] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("consumer")

# Load environment configuration
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    load_dotenv(dotenv_path=env_path)
else:
    load_dotenv()

MQTT_HOST = os.getenv("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "iot_user")
MQTT_PASS = os.getenv("MQTT_PASS", "iot_password")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

# Subscribed Topics
TOPIC_TRANSMIT = "transmit/data"
TOPIC_RECEIVE = "receive/ack"
TOPIC_WEATHER = "api/weather"

# Topic canonicalization map
TOPIC_MAP = {
    "transmit": TOPIC_TRANSMIT,
    "transmit/data": TOPIC_TRANSMIT,
    "receive": TOPIC_RECEIVE,
    "receive/ack": TOPIC_RECEIVE,
    "weather": TOPIC_WEATHER,
    "api/weather": TOPIC_WEATHER,
}

# Thread-safe ring buffers (last 100 messages per topic)
buffers_lock = Lock()
buffers: Dict[str, deque] = {
    TOPIC_TRANSMIT: deque(maxlen=100),
    TOPIC_RECEIVE: deque(maxlen=100),
    TOPIC_WEATHER: deque(maxlen=100),
}

mqtt_client: Optional[mqtt.Client] = None


def resolve_canonical_topic(topic_query: str) -> Optional[str]:
    """Resolves short names ('transmit', 'weather') or full topic strings to canonical keys."""
    normalized = topic_query.strip().lower()
    if normalized in TOPIC_MAP:
        return TOPIC_MAP[normalized]
    # Check if raw topic exists in buffers
    if topic_query in buffers:
        return topic_query
    return None


def on_mqtt_connect(client, userdata, flags, rc, properties=None):
    rc_code = rc if isinstance(rc, int) else rc.value
    if rc_code == 0:
        logger.info(f"Connected to MQTT Broker at {MQTT_HOST}:{MQTT_PORT}")
        # Subscribe to all 3 telemetry topics with QoS 1
        client.subscribe(
            [(TOPIC_TRANSMIT, 1), (TOPIC_RECEIVE, 1), (TOPIC_WEATHER, 1)]
        )
        logger.info(
            f"Subscribed to topics: {TOPIC_TRANSMIT}, {TOPIC_RECEIVE}, {TOPIC_WEATHER}"
        )
    else:
        logger.error(f"MQTT connection failed with code {rc_code}")


def on_mqtt_message(client, userdata, msg):
    topic = msg.topic
    try:
        payload_str = msg.payload.decode("utf-8")
        data = json.loads(payload_str)
    except Exception as e:
        logger.warning(
            f"Malformed message on {topic}: {e} | Raw: {msg.payload[:50]!r}"
        )
        return

    with buffers_lock:
        if topic not in buffers:
            buffers[topic] = deque(maxlen=100)
        buffers[topic].append(data)

    logger.debug(f"Received telemetry on {topic}: {data}")


def start_mqtt_client():
    global mqtt_client
    try:
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="consumer-node-fastapi",
        )
    except AttributeError:
        client = mqtt.Client(client_id="consumer-node-fastapi")

    if MQTT_USER and MQTT_PASS:
        client.username_pw_set(MQTT_USER, MQTT_PASS)

    client.on_connect = on_mqtt_connect
    client.on_message = on_mqtt_message

    try:
        client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
        client.loop_start()
        mqtt_client = client
        logger.info("MQTT background loop started.")
    except Exception as e:
        logger.error(f"Failed to connect MQTT client: {e}")


def stop_mqtt_client():
    global mqtt_client
    if mqtt_client:
        logger.info("Stopping MQTT client loop...")
        mqtt_client.loop_stop()
        mqtt_client.disconnect()
        mqtt_client = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Starting Consumer FastAPI application...")
    start_mqtt_client()
    yield
    # Shutdown
    logger.info("Shutting down Consumer FastAPI application...")
    stop_mqtt_client()


app = FastAPI(
    title="IoT Auto Climate Control — Consumer Node",
    version="1.0.0",
    description="REST API service consuming and buffering telemetry from MQTT broker.",
    lifespan=lifespan,
)


@app.get("/health", summary="Health check endpoint")
def get_health():
    """Returns the service health status."""
    return {"status": "ok"}


@app.get("/transmit/latest", summary="Latest Transmitter payload")
def get_transmit_latest():
    """Returns the most recent payload from transmit/data."""
    with buffers_lock:
        buf = buffers[TOPIC_TRANSMIT]
        if not buf:
            raise HTTPException(
                status_code=404, detail="No transmitter data received yet"
            )
        return buf[-1]


@app.get("/receive/latest", summary="Latest Receiver payload")
def get_receive_latest():
    """Returns the most recent payload from receive/ack."""
    with buffers_lock:
        buf = buffers[TOPIC_RECEIVE]
        if not buf:
            raise HTTPException(
                status_code=404, detail="No receiver data received yet"
            )
        return buf[-1]


@app.get("/weather/latest", summary="Latest OpenWeatherMap payload")
def get_weather_latest():
    """Returns the most recent payload from api/weather."""
    with buffers_lock:
        buf = buffers[TOPIC_WEATHER]
        if not buf:
            raise HTTPException(
                status_code=404, detail="No weather data received yet"
            )
        return buf[-1]


@app.get("/{topic:path}/latest", summary="Generic endpoint for latest topic payload")
def get_generic_latest(topic: str):
    """Retrieves the latest telemetry entry for a given topic or alias."""
    canonical = resolve_canonical_topic(topic)
    if not canonical:
        raise HTTPException(
            status_code=404,
            detail=f"Topic '{topic}' is not tracked. Valid topics: transmit, receive, weather",
        )

    with buffers_lock:
        buf = buffers[canonical]
        if not buf:
            raise HTTPException(
                status_code=404,
                detail=f"No data received yet for topic '{canonical}'",
            )
        return buf[-1]


@app.get(
    "/history/{topic:path}",
    summary="Sliding ring buffer (up to 100 messages) for topic",
)
def get_history(topic: str):
    """Returns up to the last 100 received messages for the specified topic in FIFO order."""
    canonical = resolve_canonical_topic(topic)
    if not canonical:
        raise HTTPException(
            status_code=404,
            detail=f"Topic '{topic}' is not tracked. Valid topics: transmit, receive, weather",
        )

    with buffers_lock:
        buf = buffers[canonical]
        return list(buf)


def run():
    uvicorn.run("main:app", host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    run()
