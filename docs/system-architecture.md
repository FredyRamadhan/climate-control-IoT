# System Architecture & Technical Topology

This document provides an exhaustive overview of the system architecture, node responsibilities, network communications, data flow lifecycles, and security controls across the **IoT Auto Climate Control** platform.

---

## 1. Node Responsibilities & Component Directory

The architecture consists of four operational tiers: **Embedded Physical Nodes**, **Message Broker Infrastructure**, **Backend & Presentation Services**, and **Analytics & Operational Tooling**.

```mermaid
graph TB
    subgraph Tier1 ["Tier 1: Embedded Edge Nodes"]
        TX["Transmitter Node (ESP8266)<br/>• HC-SR501 PIR Motion<br/>• DHT11 Temp/Humidity<br/>• KY-005 38kHz IR Emitter<br/>• GPIO12 Lighting-Only Relay (2h idle auto-off)"]
        AC["Conventional AC Unit<br/>• Driven exclusively by 38 kHz NEC IR<br/>• Power ON/OFF, 16-30°C setpoint, fan mode<br/>• Never disconnected from mains by a relay"]
        RX["Receiver Node (ESP8266 / AC Feedback Listener)<br/>• VS1838B IR Demodulator<br/>• 2N2222 1 kHz PWM Blower Simulator<br/>• Decoded AC State Indicator LEDs"]
        Fan["DC Blower Fan<br/>(simulation only)"]
    end

    subgraph Tier2 ["Tier 2: Messaging Infrastructure"]
        Broker["Eclipse Mosquitto 2 Broker<br/>• Port 1883: TCP MQTT<br/>• Port 9001: WebSockets<br/>• Hashed Credentials Auth<br/>• In-Memory / Disk Persistence"]
    end

    subgraph Tier3 ["Tier 3: Backend & Presentation Tier"]
        Producer["API-Producer (Python)<br/>• OpenWeatherMap Polling<br/>• Fallback Synthesizer"]
        Consumer["Consumer Backend (Express 5)<br/>• Telemetry Ring Buffer (100 msgs)<br/>• MQTT Client & ACK Correlator<br/>• REST API Server (Port 8000)"]
        Dashboard["Consumer Frontend (React 19)<br/>• Live Climate Monitoring<br/>• Manual Override Panel<br/>• Health & Device Status"]
    end

    subgraph Tier4 ["Tier 4: Analytics & Tools"]
        Analytics["Streamlit Analytics Hub (Python)<br/>• Telemetry EDA & Insights<br/>• Real-Time Inference Sandbox<br/>• HistGradientBoosting Regressor"]
        Tools["Operator CLI Utilities<br/>• ir_override.py<br/>• debug_broker.py<br/>• e2e_integration_test.py"]
    end

    TX -->|38 kHz NEC IR: AC power, setpoint, fan (direct to AC, no mains relay)| AC
    TX -->|Same IR frames decoded for AC feedback| RX
    RX -->|GPIO5 1 kHz PWM via 2N2222| Fan
    TX <-->|MQTT: transmit/data, transmit/status, transmit/command, transmit/command/ack| Broker
    RX <-->|MQTT: receive/state (decoded IR), receive/status| Broker
    Producer -->|MQTT: api/weather| Broker
    Broker <-->|MQTT Ingest & Command Dispatch| Consumer
    Consumer <-->|HTTP REST /api| Dashboard
    Consumer -.->|HTTP /health Inspection| Analytics
    Tools <-->|MQTT Command / Test Injection| Broker
```

### Detailed Component Roles

#### 1. Transmitter Node (`board/transmit-node`)
- **Microcontroller:** Espressif ESP8266 (NodeMCU v2 / D1 Mini).
- **Core Role:** Functions as the room environmental sensor hub, lighting controller, and air conditioner remote emulator.
- **Physical Sensing:** Polls the HC-SR501 PIR motion sensor every 100 ms to capture transient movement; reads ambient temperature and relative humidity from the DHT11 sensor every 5 seconds.
- **Rule Engine:** Executes a multi-condition deterministic state machine that decides whether the AC should run, what the cooling setpoint should be (16°C to 30°C), and the required fan speed.
- **Actuation:** Drives an opto-isolated relay connected to a mains lightbulb; emits 32-bit modulated infrared pulses at 38 kHz via the KY-005 emitter.
- **Manual Overrides:** Listens for commands on `transmit/command`, suspends automatic rule evaluation for a specified duration (or indefinitely), and reports confirmation to `transmit/command/ack`.

#### 2. Receiver Node (`board/receive-node`)
- **Microcontroller:** Espressif ESP8266 (NodeMCU v2 / D1 Mini).
- **Core Role:** Acts as an AC feedback receiver and blower motor simulator. In real-world operation, the physical air conditioning unit is controlled exclusively by the 38 kHz NEC IR signal emitted from the Transmitter Node. AC power (ON/OFF) is commanded entirely via IR signals without cutting off mains power. Physical relays are never used to switch AC power, avoiding compressor electrical damage; relays in this project are strictly reserved for room lighting.
- **Signal Decoding:** Utilizes a VS1838B IR demodulator to capture and validate 32-bit NEC-compatible frames. Verifies the custom protocol header (`0xA1`), bit inversion, and 5-bit XOR checksum.
- **Actuation & Simulation:** Drives an NPN transistor (2N2222) via 1 kHz PWM to simulate cooling fan speeds across 4 duty cycle stages (Off: 0%, Low: 33%, Medium: 67%, High: 100%) and mirrors power status on indicator LEDs.
- **Telemetry:** Publishes state transitions and regular heartbeats to `receive/state`.

#### 3. Message Broker (`broker`)
- **Service:** Containerized Eclipse Mosquitto 2.
- **Core Role:** Decoupled asynchronous publish-subscribe message backbone.
- **Network Boundaries:** Exposes TCP port `1883` for microcontrollers and backend services; exposes port `9001` for WebSocket clients.
- **Security:** Strict password file enforcement (`allow_anonymous true` in local development with authenticated fallback, or `allow_anonymous false` in production).

#### 4. API Producer Node (`utils/api-producer`)
- **Runtime:** Python 3.10+ daemon.
- **Core Role:** Queries the OpenWeatherMap API every 10 minutes (`600s`) for real-time outdoor temperature, humidity, and weather description.
- **Reliability:** Falls back gracefully to realistic simulated tropical metrics when network disconnects or API keys are invalid. Publishes to `api/weather` with the MQTT `retain` flag set to `true`.

#### 5. Consumer Backend & Frontend (`visualization/consumer`)
- **Runtime:** Node.js >= 22.12 running Express 5 and Vite 6 with React 19.
- **Core Role:** Subscribes to all active MQTT topics, validates payloads with Zod schemas, stores the last 100 messages per topic in an in-memory sliding ring buffer (`TelemetryStore`), serves a REST API, and dispatches manual override commands over MQTT with synchronous ACK waiting.
- **User Interface:** A single-page application built in React 19 and styled with custom responsive CSS. Features full Indonesian localization, real-time climate monitoring, manual setpoint controls, and light/dark theme switching.

#### 6. Analytics & Machine Learning Hub (`visualization/analytics`)
- **Runtime:** Python 3 with `scikit-learn`, `pandas`, `plotly`, and `streamlit`.
- **Core Role:** Contains a physics-based synthetic telemetry generator producing 100,000 rows of training data, trains multi-model regressions (HistGradientBoosting, Random Forest, Ridge, Linear) to predict real-time AC electrical load in Watts, and exposes an interactive 6-tab Streamlit dashboard.

---

## 2. Network Protocols & Communication Matrix

| Source | Destination | Protocol / Transport | Port | Payload Format | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Transmitter** | **Mosquitto** | MQTT v3.1.1 (TCP) | 1883 | UTF-8 JSON | Publishes `transmit/data`, `transmit/status`, `transmit/command/ack`. Subscribes to `transmit/command`. |
| **Receiver** | **Mosquitto** | MQTT v3.1.1 (TCP) | 1883 | UTF-8 JSON | Publishes `receive/state`, `receive/status`. |
| **API-Producer** | **OpenWeatherMap** | HTTPS / TLS 1.3 | 443 | JSON REST | Queries outdoor weather metrics for Jakarta or configured city. |
| **API-Producer** | **Mosquitto** | MQTT v3.1.1 (TCP) | 1883 | UTF-8 JSON | Publishes retained weather data to `api/weather`. |
| **Transmitter** | **Receiver** | Optical IR (38 kHz Carrier) | Direct LoS | 32-bit NEC Hex | Sends AC power, target temperature, and fan speed commands wirelessly. |
| **Consumer (Express)** | **Mosquitto** | MQTT v5 / v3.1.1 (TCP) | 1883 | UTF-8 JSON | Ingests all telemetry topics; publishes commands to `transmit/command`. |
| **Browser Client** | **Consumer (Express)** | HTTP/1.1 | 8000 | JSON REST / Static Assets | Polls `/api/dashboard`, `/api/history`, sends `POST /api/command`. |
| **Browser Client** | **Vite Dev Server** | HTTP / WebSocket | 5173 | HMR / Dev Bundle | Frontend development server (proxies `/api` to port 8000). |
| **Operator Browser** | **Streamlit** | HTTP / WebSocket | 8501 | Streamlit Protocol | Serves machine learning diagnostics, EDA, and real-time inference sandbox. |
| **ESP8266 Nodes** | **pool.ntp.org** | NTP (UDP) | 123 | NTP Epoch Packets | Synchronizes hardware clock for accurate Unix timestamps (`timestamp`). |

---

## 3. Core Operational Workflows & Sequence Diagrams

### 3.1 Autonomous Climate Control Loop

The diagram below illustrates how environmental sensor changes trigger automated actuation without human intervention:

```mermaid
sequenceDiagram
    autonumber
    participant S as Sensors (PIR / DHT11)
    participant TX as Transmitter Node
    participant AC as Conventional AC Unit (IR-driven)
    participant RX as Receiver Node (Feedback + Blower)
    participant M as Mosquitto Broker
    participant C as Consumer Backend
    participant UI as React Dashboard

    Note over S,TX: Every 100 ms PIR poll; Every 5000 ms DHT11 sample
    S->>TX: Motion Detected (HIGH) & DHT11 (29.5°C, 65% RH)
    TX->>TX: Evaluate Rule 1: Motion == true & Temp > 28°C<br/>-> AC Power (IR) = ON, Target = 16°C, Fan = HIGH
    TX->>TX: Turn ON Lighting Relay (GPIO12) — lighting only

    par Direct Optical AC Control
        TX->>AC: 38 kHz NEC IR frame (0xA18710EF)
        Note over AC: Applies Power ON, 16°C, Fan HIGH directly from IR.<br/>No mains relay ever switches the AC.
    and IR Feedback Decode and Blower Simulation
        TX->>RX: Same 38 kHz NEC IR frame (line-of-sight)
        RX->>RX: Decode Frame: Header=0xA1, Power=ON, Temp=16°C, Fan=HIGH
        RX->>RX: Update AC Power Indicator LED (HIGH) = decoded IR state
        RX->>RX: Set Fan PWM Duty Cycle to 1023 (1 kHz, 100% High)
        RX->>M: Publish receive/state (decoded IR state, QoS 1, retain=true)
    and Telemetry Broadcast
        TX->>M: Publish transmit/data (QoS 1, retain=false)
    end

    M->>C: Ingest transmit/data & receive/state
    C->>C: Store in Sliding Buffer (100 msgs max) & Validate Zod Schema
    UI->>C: Poll GET /api/dashboard (Cadence: 3s)
    C-->>UI: Return latest snapshot with metadata
    UI->>UI: Update live room temperature, target temp, fan animation, and status badges
```

### 3.2 Manual Override Command Dispatch Lifecycle

When an operator clicks "Terapkan pengaturan" or executes `ir_override.py`:

```mermaid
sequenceDiagram
    autonumber
    actor User as Operator / Web UI
    participant C as Consumer Backend (Express)
    participant M as Mosquitto Broker
    participant TX as Transmitter Node
    participant AC as Conventional AC Unit (IR-driven)
    participant RX as Receiver Node (Feedback + Blower)

    User->>C: POST /api/command {action: "override", relay_on: true, target_temp: 22, fan_speed: "medium", duration_s: 120}
    Note over User,TX: relay_on is the legacy field name for the IR AC power command.<br/>The only physical relay (GPIO12) switches lighting via light_on.
    C->>C: Zod Validation: Check temp in 16..30, fan in off/low/med/high<br/>Generate request_id: "dash-1700000-abcd"
    C->>C: Register pending Promise in Map<request_id, Resolver>
    C->>M: Publish to transmit/command (QoS 1, retain=false)

    M->>TX: Forward transmit/command payload
    TX->>TX: Parse JSON, set overrideActive=true, set duration=120s
    TX->>TX: Build NEC IR frame (0xA18616E9) for AC power / setpoint / fan
    TX->>AC: 38 kHz NEC IR from KY-005 (no mains relay switched)
    TX->>RX: Same IR frame decoded for feedback
    RX->>RX: Apply decoded state: AC Power ON, 22°C, Fan Medium (PWM 682)
    RX->>RX: Update AC state LED; drive blower via 1 kHz PWM
    RX->>M: Publish receive/state (source: "ir-change", decoded IR state)

    TX->>M: Publish transmit/command/ack {ok: true, request_id: "dash-...", applied: {...}}
    M->>C: Forward transmit/command/ack
    C->>C: Correlate request_id with pending Promise
    C-->>User: HTTP 200 OK {request_id: "...", sent: {...}, ack: {ok: true, ...}}
    User->>User: Display success alert & lock settings draft until receive/state confirms
```

### 3.3 Lightbulb Idle Auto-Off Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant PIR as PIR Sensor
    participant TX as Transmitter Node
    participant Light as Lighting Relay (GPIO12)

    Note over TX,Light: GPIO12 is the ONLY relay. It switches room lighting; AC power is never mains-switched and stays IR-driven.
    Note over TX: Normal room occupancy
    PIR->>TX: Motion detected
    TX->>TX: Update lastMotionMs = millis()
    TX->>Light: Ensure Lightbulb Relay is ON (Active LOW -> LOW)

    Note over TX: Room vacated (Occupants leave)
    loop Every 5000 ms
        TX->>TX: Check (millis() - lastMotionMs) > LIGHT_IDLE_MS (7,200,000 ms = 2 hours)
    end
    Note over TX: 2 hours elapsed without motion
    TX->>Light: De-energize Lighting Relay (Set HIGH)
    TX->>TX: Log: [Relay] Light bulb OFF
    Note over TX,Light: Lighting timeout does not affect AC power; AC commands continue over 38 kHz IR.
```

---

## 4. Security Architecture & Boundary Isolation

### 4.1 Authentication & Credential Isolation
1. **MQTT Authentication:**
   - Broker user accounts are stored in an encrypted/hashed password file (`broker/passwd`) using Mosquitto's internal PBKDF2 with SHA-512 hashing algorithm.
   - Microcontrollers authenticate via fixed credentials declared in `secrets.h`.
   - Node services authenticate via environment variables loaded from `.env`.
   - Files matching `secrets.h` and `.env` are strictly excluded from git tracking via `.gitignore`. Templates (`secrets.h.example`, `.env.example`) are provided with safe placeholders.

2. **Access Control Configuration:**
   - Mosquitto configuration (`broker/mosquitto.conf`) sets `allow_anonymous true` for seamless local lab environments with explicit password fallback, or `allow_anonymous false` for hardened deployments.
   - The password file is owned by UID `1883:1883` with strict file permissions (`0700`).

### 4.2 Container & Process Hardening
The Consumer backend Docker container is built with production security best practices defined in [compose.yaml](file:///home/frdn/Downloads/Kuliah/IoT/Proyek/visualization/consumer/compose.yaml):
- **Unprivileged User:** Executes under the non-root `node` system user (UID 1000).
- **Read-Only Root Filesystem:** Root filesystem is mounted read-only (`read_only: true`).
- **Capability Dropping:** All Linux capabilities are dropped (`cap_drop: - ALL`).
- **Privilege Escalation Prevention:** Enforces `no-new-privileges:true`.
- **Ephemeral Scratch Storage:** Temporary scratch directories are restricted to an in-memory tmpfs mount (`/tmp:size=16m,noexec,nosuid`).
- **Graceful Termination:** Configured with `stop_grace_period: 15s` and an init process (`init: true`) to gracefully drain MQTT commands and complete active HTTP connections.

### 4.3 Web Security Headers & Defenses
The Express 5 application implements comprehensive defenses in [app.js](file:///home/frdn/Downloads/Kuliah/IoT/Proyek/visualization/consumer/server/app.js):
- **Helmet Middleware:** Disables `x-powered-by`, enforces strict `Content-Security-Policy` permitting only local scripts and styles, and allows data URIs for images.
- **Payload Limits:** Incoming JSON request bodies are capped at 16 KB (`express.json({ limit: '16kb' })`) to prevent memory exhaustion attacks.
- **CORS Protection:** Configurable CORS filter (`CORS_ORIGIN`). By default, same-origin access is required.
- **Cache Invalidation:** Sensitive API endpoints apply `Cache-Control: no-store` headers to prevent intermediate proxies or browser history from caching telemetry or device commands.
