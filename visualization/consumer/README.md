# Auto-Climate Control

An Express 5 backend and React + TypeScript frontend for the IoT climate controller. MQTT topics and the original REST endpoints remain compatible with the transmitter, receiver, and existing scripts. Room monitoring and controls run on Node; the Analitik tab reuses the Python analytics model through a small JSON adapter.

The Indonesian dashboard shows room temperature, humidity, motion, outside weather, AC state, lighting relay state, and device connectivity. Manual controls support AC power, the room-lighting relay, a 16–30°C setpoint, four fan speeds, timed overrides, indefinite overrides, and a return to automatic control. Light and dark themes use locally hosted fonts. Readings are never seeded with demo values; weather is sourced from OpenWeatherMap through the API producer.

## Development

Requires Node.js 22.12 or newer and npm. Run everything from this directory:

```sh
npm ci
cp .env.example .env
npm run dev
```

In PowerShell, use `Copy-Item .env.example .env` instead of `cp`. Edit `.env` with the broker address and credentials. The defaults match the previous consumer.

- Dashboard: <http://localhost:5173>
- Express API: <http://localhost:8000/health>

Vite proxies `/api` to Express, including a custom `PORT` from the root `.env`. Both processes reload during development. MQTT credentials stay on the server; no `VITE_` secrets are needed.

### Analytics tab

Open **Analitik** in the dashboard navigation, or go directly to `/#analitik`. The tab uses the same shell, typography, colors, light/dark themes, and browser history. Switching tabs preserves unsent room controls and analytics inputs.

Analytics includes energy summaries, hourly power/temperature trends, occupancy comparisons, model evaluation, scenario predictions, and CSV inference with full-result downloads. It reports the actual dataset size and marks the existing synthetic data explicitly. Predictions never issue hardware commands. Fresh room readings can prefill the simulator; occupant counts remain user estimates.

For local development, start the analytics adapter in another terminal using Python 3.13:

```powershell
cd ../analytics
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-api.txt
.\.venv\Scripts\python.exe -m uvicorn api:app --host 127.0.0.1 --port 8001
```

On Linux/macOS, use `.venv/bin/python` instead of `.venv\Scripts\python.exe`. Keep `npm run dev` running from the consumer directory. Express forwards `/api/analytics/*` to `ANALYTICS_URL` (default `http://127.0.0.1:8001`). If the adapter is unavailable, room monitoring and controls keep working and the analytics tab offers a retry.

The checked-in model was trained with scikit-learn 1.9.1; the API dependency file pins that version. The generator, trainer, model, dataset, and optional Streamlit app remain in `../analytics`.

## Production

```sh
npm ci
npm run build
npm start
```

Open <http://localhost:8000>. Express serves both the compiled React app and the API from one origin. Built JavaScript and CSS use fingerprinted filenames with immutable caching; HTML and API responses are not cached that way.

### Docker Compose

```sh
cp .env.example .env
# Edit .env: use MQTT_HOST=host.docker.internal for a broker on the Docker host.
# Use the actual broker address for a broker on another machine.
docker compose up --build -d
docker compose logs -f consumer
```

The `.env.example` default `127.0.0.1` is for a non-container Node process. Inside Docker, `127.0.0.1` addresses the consumer container itself. Set `MQTT_HOST` before starting Compose. If there is no `.env`, Compose defaults to `host.docker.internal`, with a Linux host gateway mapping included.

Compose builds and starts both `consumer` and `analytics`. The analytics service runs as an unprivileged user with a read-only filesystem and no published host port; Express reaches it on the private Compose network. Open <http://localhost:8000/#analitik> for analytics. Each service has its own health check, and analytics outages do not stop room controls.

### Docker without Compose

This starts the consumer only. For the integrated analytics tab, use Compose above, or set `ANALYTICS_URL` to a separately running adapter that the container can reach.

```sh
docker build --target production -t auto-climate-consumer .
docker run -d --name auto-climate --init --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  --env-file .env -e MQTT_HOST=host.docker.internal \
  -p 8000:8000 auto-climate-consumer
```

The multi-stage image contains production backend dependencies and compiled frontend assets. It runs as the unprivileged `node` user, checks HTTP liveness, and handles SIGTERM/SIGINT with a bounded shutdown. Compose also enables a read-only filesystem, drops capabilities, and rotates logs. Broker credentials are injected at runtime; `.env` is excluded from the build context. Place the control interface behind your existing access-controlled reverse proxy when exposing it outside your trusted network; this consumer does not add user authentication.

The health check reports process liveness even when MQTT is disconnected. Inspect the response's `mqtt` and `subscriptions_ready` fields to distinguish broker availability. The service reconnects automatically, so a broker outage does not require restarting the container.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `PORT` | `8000` | HTTP port; Compose maps the same host/container port |
| `MQTT_HOST` | `127.0.0.1` | Broker host; Compose defaults to `host.docker.internal` when unset |
| `MQTT_PORT` | `1883` | Broker port |
| `MQTT_PROTOCOL` | `mqtt` | `mqtt` or `mqtts` with normal certificate verification |
| `MQTT_USER` | `iot_user` | Broker username; empty disables authentication |
| `MQTT_PASS` | `iot_password` | Broker password |
| `MQTT_CLIENT_ID` | Generated unique ID | Optional fixed client ID; each consumer needs its own |
| `COMMAND_ACK_TIMEOUT` | `6` | Seconds to wait for the device ACK after broker publish confirmation |
| `COMMAND_PUBLISH_TIMEOUT` | `2` | Seconds to wait for the broker's publish confirmation |
| `STALE_AFTER_SECONDS` | `30` | Room/receiver telemetry freshness threshold |
| `CORS_ORIGIN` | Empty | Optional comma-separated browser origins; same-origin by default |
| `ANALYTICS_URL` | `http://127.0.0.1:8001` | Analytics adapter for local Node; Compose uses `http://analytics:8001` |

Environment variables take precedence over `.env`. Invalid configuration fails at startup with the affected field name. History is in memory, limited to 100 messages per topic, and resets on restart. Run one instance for a coherent view of history; multiple replicas each keep their own buffers.

## API

Every route below also works with an `/api` prefix. Error responses are JSON objects with a `detail` string.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/health` | HTTP and MQTT connection status |
| GET | `/dashboard` | One snapshot of all latest payloads, receipt timestamps, schema validity, and connection status |
| GET | `/transmit/latest` | Latest `transmit/data` payload |
| GET | `/receive/latest` | Latest `receive/state` payload |
| GET | `/transmit/status/latest` | Transmitter online/offline status |
| GET | `/receive/status/latest` | Receiver online/offline status |
| GET | `/command/latest` | Latest command acknowledgement |
| GET | `/weather/latest` | Latest `api/weather` payload |
| GET | `/history/{topic}` | Up to 100 messages in arrival order; empty array before the first message |
| POST | `/command` | Validate, publish with QoS 1, and wait for the matching device acknowledgement |

Full MQTT topic names work in latest/history routes. Aliases include `transmit`, `receive`, `receive/ack`, `command`, `command/ack`, and `weather`. A latest route returns 404 until its first message. Malformed JSON MQTT messages are discarded. JSON payloads with a schema mismatch remain available through the API and are flagged in dashboard metadata.

```json
{ "action": "override", "relay_on": true, "target_temp": 24, "fan_speed": "medium", "duration_s": 60 }
```

`override` requires at least one control field. `duration_s` defaults to 60; use `0` for an override until released, up to 86400 for timed overrides. Fan speeds: `off`, `low`, `medium`, `high`.

```json
{ "action": "release" }
```

```json
{ "action": "raw", "ir_code": "0xAABBCCDD", "duration_s": 5 }
```

Raw NEC frames accept 1–8 hexadecimal digits and are normalized to an eight-digit `0x` code. Extra fields, mixed raw/control fields, and out-of-range values return 422. An optional `request_id` correlates the response; otherwise the server creates one.

A successful HTTP response contains `{ "request_id", "sent", "ack" }`. Only `ack.ok === true` confirms application by the device. `ack: null` means the broker accepted the publish but the device did not confirm before the timeout. A rejected device ACK is returned unchanged. No broker connection yields 503; publish failure/timeout yields 502. Duplicate in-flight request IDs yield 409. Commands are not retained; retained or invalid ACKs cannot confirm a new command.

## Checks

```sh
npm run check
npm run test:ui
```

`check` runs the Node backend tests and the TypeScript/production frontend build. Browser tests use Playwright with the installed Chrome by default; set `PLAYWRIGHT_CHANNEL=msedge` for Edge, or install the Playwright browser with `npx playwright install chromium` and set `PLAYWRIGHT_CHANNEL=chromium`. Browser tests use isolated fixtures and do not send commands to real hardware.

With Docker running, validate the production image and Compose settings:

```sh
docker compose build
node tests/docker-smoke.js
```

The Docker smoke test creates a temporary Compose project on an available port and runs an isolated MQTT fixture inside its container. It verifies health checks, the unprivileged/read-only runtime, frontend assets, telemetry and bounded history, command acknowledgements and failures, and graceful shutdown. It removes its temporary container and network afterward. It does not connect to the broker in your `.env` or send commands to physical devices.

It also verifies the existing Python model through the Express proxy, period filtering, predictions, CSV inference and validation, and recovery after an analytics-service outage. Python tests can be run from `../analytics` with `.venv\Scripts\python.exe -m unittest discover -s tests -v`.

## Source layout

```text
server/             Express routes, MQTT lifecycle, schemas, bounded telemetry store
server/test/        API and command/telemetry integration tests
frontend/src/       React components, polling, theme, display helpers
frontend/public/    Self-hosted fonts and the original AC photograph
tests/              Browser interaction and responsive-layout tests
Dockerfile          Build, production dependencies, and unprivileged runtime stages
compose.yaml        Production container configuration
```
