#!/usr/bin/env python3
"""
IoT Auto Climate Control Module — Consumer Node
FastAPI service subscribing to the transmit/receive node topics via paho-mqtt
and serving the validated payloads over REST.
"""

import os
import json
import time
import uuid
import logging
from collections import deque
from threading import Lock
from pathlib import Path
from typing import Dict, Any, Optional, Literal
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, ValidationError
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

# How long POST /command waits for the transmitter ACK before giving up.
COMMAND_ACK_TIMEOUT = float(os.getenv("COMMAND_ACK_TIMEOUT", "6"))

# Dashboard static assets, served at / and /static.
DASHBOARD_DIR = Path(__file__).parent / "dashboard"

# MQTT Topics published by the transmitter and receiver nodes
TOPIC_TRANSMIT = "transmit/data"
TOPIC_TRANSMIT_STATUS = "transmit/status"
TOPIC_COMMAND_ACK = "transmit/command/ack"
TOPIC_RECEIVE = "receive/state"
TOPIC_RECEIVE_STATUS = "receive/status"
TOPIC_WEATHER = "api/weather"

# Topic the transmitter subscribes to for manual commands (see tools/ir_override.py).
TOPIC_COMMAND_PUBLISH = "transmit/command"

# Command validation limits, shared with the transmitter firmware.
MAX_DURATION_S = 86400          # overrides may last at most 24 h
TEMP_MIN_C, TEMP_MAX_C = 16, 30
FAN_SPEEDS = ("off", "low", "medium", "high")

# Topics are subscribed with QoS 1
SUBSCRIPTIONS = (
    (TOPIC_TRANSMIT, 1),
    (TOPIC_TRANSMIT_STATUS, 1),
    (TOPIC_COMMAND_ACK, 1),
    (TOPIC_RECEIVE, 1),
    (TOPIC_RECEIVE_STATUS, 1),
    (TOPIC_WEATHER, 1),
)

# Topic canonicalization map. "receive/ack" is kept as a legacy alias.
TOPIC_MAP = {
    "transmit": TOPIC_TRANSMIT,
    "transmit/data": TOPIC_TRANSMIT,
    "transmit/status": TOPIC_TRANSMIT_STATUS,
    "command": TOPIC_COMMAND_ACK,
    "command/ack": TOPIC_COMMAND_ACK,
    "transmit/command/ack": TOPIC_COMMAND_ACK,
    "receive": TOPIC_RECEIVE,
    "receive/state": TOPIC_RECEIVE,
    "receive/ack": TOPIC_RECEIVE,
    "receive/status": TOPIC_RECEIVE_STATUS,
    "weather": TOPIC_WEATHER,
    "api/weather": TOPIC_WEATHER,
}

VALID_TOPIC_NAMES = (
    "transmit, transmit/status, command/ack, "
    "receive, receive/status, weather"
)


# ==========================================
# Payload schemas (must match the firmware)
# ==========================================
class TransmitTelemetry(BaseModel):
    """Payload published by transmit-node on transmit/data."""

    model_config = ConfigDict(extra="allow")

    motion: bool
    temp: float                      # measured room temperature
    hum: float
    timestamp: int
    fan_speed: str
    relay_on: bool
    target_temp: int                 # AC setpoint encoded into the IR frame
    sensor_ok: bool
    ir_sent: bool
    uptime_ms: int
    override: bool
    ir_code: Optional[str] = None
    warmup: Optional[bool] = None
    override_source: Optional[str] = None
    override_indefinite: Optional[bool] = None
    override_remaining_s: Optional[int] = None


class ReceiveState(BaseModel):
    """Payload published by receive-node on receive/state."""

    model_config = ConfigDict(extra="allow")

    ac_power_state: bool
    temp: float                      # AC setpoint decoded from IR
    fan_speed: str
    timestamp: int
    state_valid: bool
    source: Optional[str] = None


class AppliedState(BaseModel):
    """State echoed by the transmitter after a successful override."""

    model_config = ConfigDict(extra="allow")

    relay_on: bool
    target_temp: int
    fan_speed: str


class CommandAck(BaseModel):
    """Payload published by transmit-node on transmit/command/ack."""

    model_config = ConfigDict(extra="allow")

    ok: bool
    override: bool
    raw_only: bool
    timestamp: int
    request_id: Optional[str] = None
    action: Optional[str] = None
    override_source: Optional[str] = None
    override_indefinite: Optional[bool] = None
    override_remaining_s: Optional[int] = None
    applied: Optional[AppliedState] = None
    ir_code: Optional[str] = None
    error: Optional[str] = None


class NodeStatus(BaseModel):
    """Last-will/status payload published on transmit/status and receive/status."""

    online: bool


class CommandRequest(BaseModel):
    """Manual command accepted by POST /command.

    Mirrors the payloads built by tools/ir_override.py: "override" changes the
    relay/setpoint/fan for `duration_s` seconds, "release" clears an active
    override, and "raw" transmits a 32-bit NEC frame.
    """

    model_config = ConfigDict(extra="forbid")

    action: Literal["override", "release", "raw"]
    request_id: Optional[str] = None
    relay_on: Optional[bool] = None
    target_temp: Optional[int] = None
    fan_speed: Optional[str] = None
    ir_code: Optional[str] = None
    duration_s: int = 60


MODEL_BY_TOPIC = {
    TOPIC_TRANSMIT: TransmitTelemetry,
    TOPIC_RECEIVE: ReceiveState,
    TOPIC_COMMAND_ACK: CommandAck,
    TOPIC_TRANSMIT_STATUS: NodeStatus,
    TOPIC_RECEIVE_STATUS: NodeStatus,
}

# Thread-safe ring buffers (last 100 messages per topic)
buffers_lock = Lock()
buffers: Dict[str, deque] = {
    topic: deque(maxlen=100) for topic, _ in SUBSCRIPTIONS
}

mqtt_client: Optional[mqtt.Client] = None


def normalize_payload(topic: str, data: Any) -> Any:
    """Coerce a node payload into its canonical schema.

    Unknown topics (for example weather) are stored unchanged. A payload that
    does not match the schema is still buffered as-is so a transient firmware
    mismatch never hides telemetry from the REST API.
    """
    model = MODEL_BY_TOPIC.get(topic)
    if model is None:
        return data

    try:
        return model.model_validate(data).model_dump(exclude_none=True)
    except ValidationError as exc:
        logger.warning("Payload on %s does not match the node schema: %s", topic, exc)
        return data


def resolve_canonical_topic(topic_query: str) -> Optional[str]:
    """Resolves short names ('transmit', 'weather') or full topic strings to canonical keys."""
    normalized = topic_query.strip().lower()
    if normalized in TOPIC_MAP:
        return TOPIC_MAP[normalized]
    # Check if raw topic exists in buffers
    if topic_query in buffers:
        return topic_query
    return None


def normalize_hex(value: str) -> str:
    """Normalizes a raw IR code to the 0xAABBCCDD form expected by the firmware.

    Follows the same rules as tools/ir_override.py.
    """
    text = value.strip()
    if text.lower().startswith("0x"):
        text = text[2:]
    if not text or len(text) > 8:
        raise ValueError("ir_code must contain 1-8 hexadecimal digits")
    try:
        number = int(text, 16)
    except ValueError:
        raise ValueError("ir_code must be hexadecimal")
    if number < 0 or number > 0xFFFFFFFF:
        raise ValueError("ir_code must fit in 32 bits")
    return f"0x{number:08X}"


def build_command_payload(req: CommandRequest, request_id: str) -> Dict[str, Any]:
    """Validates a CommandRequest and builds the transmit/command payload.

    Raises ValueError with a user-facing message when validation fails, using
    the same rules as tools/ir_override.py and the transmitter firmware.
    """
    if req.duration_s < 0 or req.duration_s > MAX_DURATION_S:
        raise ValueError(f"duration_s must be between 0 and {MAX_DURATION_S} seconds")

    if req.action == "release":
        if req.ir_code is not None or req.relay_on is not None or \
                req.target_temp is not None or req.fan_speed is not None:
            raise ValueError("release does not accept relay/temp/fan/ir_code fields")
        return {"action": "release", "request_id": request_id}

    if req.action == "raw":
        if req.relay_on is not None or req.target_temp is not None or \
                req.fan_speed is not None:
            raise ValueError("relay/temp/fan cannot be combined with a raw frame")
        if not req.ir_code:
            raise ValueError("raw action requires ir_code")
        return {
            "action": "raw",
            "ir_code": normalize_hex(req.ir_code),
            "duration_s": req.duration_s,
            "request_id": request_id,
        }

    # action == "override"
    if req.ir_code is not None:
        raise ValueError("ir_code only applies to the raw action")
    if req.relay_on is None and req.target_temp is None and req.fan_speed is None:
        raise ValueError("override requires at least one of relay_on, target_temp, fan_speed")
    if req.target_temp is not None and not TEMP_MIN_C <= req.target_temp <= TEMP_MAX_C:
        raise ValueError(f"target_temp must be between {TEMP_MIN_C} and {TEMP_MAX_C} Celsius")
    if req.fan_speed is not None and req.fan_speed not in FAN_SPEEDS:
        raise ValueError(f"fan_speed must be one of: {', '.join(FAN_SPEEDS)}")

    payload: Dict[str, Any] = {
        "action": "override",
        "duration_s": req.duration_s,
        "request_id": request_id,
    }
    if req.relay_on is not None:
        payload["relay_on"] = req.relay_on
    if req.target_temp is not None:
        payload["target_temp"] = req.target_temp
    if req.fan_speed is not None:
        payload["fan_speed"] = req.fan_speed
    return payload


def on_mqtt_connect(client, userdata, flags, rc, properties=None):
    rc_code = rc if isinstance(rc, int) else rc.value
    if rc_code == 0:
        logger.info(f"Connected to MQTT Broker at {MQTT_HOST}:{MQTT_PORT}")
        # Subscribe to every telemetry/status topic published by both nodes.
        client.subscribe(list(SUBSCRIPTIONS))
        logger.info(
            "Subscribed to topics: %s",
            ", ".join(topic for topic, _ in SUBSCRIPTIONS),
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

    data = normalize_payload(topic, data)

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
    version="1.2.0",
    description=(
        "REST API service consuming, validating, and buffering telemetry and "
        "status payloads from the transmitter and receiver nodes. Also serves "
        "the web dashboard and forwards manual commands to transmit/command."
    ),
    lifespan=lifespan,
)

# The dashboard is normally served from this service, but CORS allows it to be
# opened from disk or embedded elsewhere (e.g. a local static file server).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", summary="Health check endpoint")
def get_health():
    """Returns the service health status, including the MQTT connection state."""
    return {
        "status": "ok",
        "mqtt": bool(mqtt_client is not None and mqtt_client.is_connected()),
    }


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
    """Returns the most recent payload from receive/state."""
    with buffers_lock:
        buf = buffers[TOPIC_RECEIVE]
        if not buf:
            raise HTTPException(
                status_code=404, detail="No receiver data received yet"
            )
        return buf[-1]


@app.get("/command/latest", summary="Latest command ACK payload")
def get_command_latest():
    """Returns the most recent payload from transmit/command/ack."""
    with buffers_lock:
        buf = buffers[TOPIC_COMMAND_ACK]
        if not buf:
            raise HTTPException(
                status_code=404, detail="No command ACK received yet"
            )
        return buf[-1]


@app.get("/transmit/status/latest", summary="Latest transmitter status")
def get_transmit_status_latest():
    """Returns the latest online/offline state from transmit/status."""
    with buffers_lock:
        buf = buffers[TOPIC_TRANSMIT_STATUS]
        if not buf:
            raise HTTPException(
                status_code=404, detail="No transmitter status received yet"
            )
        return buf[-1]


@app.get("/receive/status/latest", summary="Latest receiver status")
def get_receive_status_latest():
    """Returns the latest online/offline state from receive/status."""
    with buffers_lock:
        buf = buffers[TOPIC_RECEIVE_STATUS]
        if not buf:
            raise HTTPException(
                status_code=404, detail="No receiver status received yet"
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
            detail=f"Topic '{topic}' is not tracked. Valid topics: {VALID_TOPIC_NAMES}",
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
            detail=f"Topic '{topic}' is not tracked. Valid topics: {VALID_TOPIC_NAMES}",
        )

    with buffers_lock:
        buf = buffers[canonical]
        return list(buf)


@app.post("/command", summary="Send a manual command to the transmitter")
def post_command(req: CommandRequest):
    """Publishes an override/release/raw command on transmit/command.

    Works like tools/ir_override.py: the payload is validated, published with
    QoS 1, and the endpoint waits for the matching ACK on transmit/command/ack
    (already buffered by this service) before responding.
    """
    request_id = req.request_id or f"dash-{int(time.time())}-{uuid.uuid4().hex[:6]}"

    try:
        payload = build_command_payload(req, request_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    client = mqtt_client
    if client is None or not client.is_connected():
        raise HTTPException(
            status_code=503,
            detail="MQTT broker is not connected; the command was not sent",
        )

    # Remember the ACKs that were already buffered so only the ACK produced by
    # this command is matched. Keeping the list referenced also keeps those
    # dicts alive, which makes the identity check below reliable.
    with buffers_lock:
        pre_existing_acks = list(buffers[TOPIC_COMMAND_ACK])
    known_ack_ids = {id(entry) for entry in pre_existing_acks}

    try:
        info = client.publish(
            TOPIC_COMMAND_PUBLISH, json.dumps(payload), qos=1
        )
        info.wait_for_publish(timeout=2.0)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to publish the command: {exc}"
        )

    deadline = time.monotonic() + COMMAND_ACK_TIMEOUT
    while time.monotonic() < deadline:
        with buffers_lock:
            for entry in reversed(buffers[TOPIC_COMMAND_ACK]):
                if id(entry) not in known_ack_ids and \
                        isinstance(entry, dict) and \
                        entry.get("request_id") == request_id:
                    return {"request_id": request_id, "sent": payload, "ack": entry}
        time.sleep(0.1)

    return JSONResponse(
        status_code=200,
        content={
            "request_id": request_id,
            "sent": payload,
            "ack": None,
            "detail": (
                f"No ACK received within {COMMAND_ACK_TIMEOUT:.0f} s; "
                "the transmitter may be offline."
            ),
        },
    )


@app.get("/", include_in_schema=False)
def get_dashboard():
    """Serves the bundled web dashboard."""
    index = DASHBOARD_DIR / "index.html"
    if index.exists():
        return FileResponse(index)
    raise HTTPException(status_code=404, detail="Dashboard not found")


# Static assets (vendored Chart.js, ...). Mounted last so API routes match first.
if DASHBOARD_DIR.exists():
    app.mount("/static", StaticFiles(directory=DASHBOARD_DIR), name="static")


def run():
    uvicorn.run("main:app", host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    run()
