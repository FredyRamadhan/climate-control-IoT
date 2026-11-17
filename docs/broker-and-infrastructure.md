# Message Broker & Infrastructure Administration

This document details the configuration, deployment, security policies, and administrative tooling for the **Eclipse Mosquitto 2** MQTT broker service located in [broker/](file:///home/frdn/Downloads/Kuliah/IoT/Proyek/broker/).

---

## 1. Container Architecture & Service Definition

The broker is containerized via Docker Compose in [docker-compose.yaml](file:///home/frdn/Downloads/Kuliah/IoT/Proyek/broker/docker-compose.yaml):

```yaml
services:
  broker:
    image: eclipse-mosquitto:2
    container_name: iot-mosquitto-broker
    restart: unless-stopped
    ports:
      - "1883:1883"
      - "9001:9001"
    volumes:
      - ./mosquitto.conf:/mosquitto/config/mosquitto.conf:ro
      - ./passwd:/mosquitto/config/passwd:ro
      - ./data:/mosquitto/data
      - ./log:/mosquitto/log
```

### Key Infrastructure Attributes
- **Base Image:** Official `eclipse-mosquitto:2` Docker Alpine image.
- **Port 1883 (`0.0.0.0:1883`):** Standard TCP MQTT protocol listener used by ESP8266 microcontrollers, the Express Consumer backend, the API Producer, and CLI utilities.
- **Port 9001 (`0.0.0.0:9001`):** WebSockets listener for direct browser MQTT connections.
- **Read-Only Mounts (`:ro`):** Configuration and password files are mounted read-only into the running broker container to prevent runtime tampering.
- **Persistent Storage Volumes:** Mounts local directories `./data` (retained messages and client session states) and `./log` (system audit log).

---

## 2. Broker Configuration File (`mosquitto.conf`)

Source: [mosquitto.conf](file:///home/frdn/Downloads/Kuliah/IoT/Proyek/broker/mosquitto.conf)

```ini
# Eclipse Mosquitto 2 Configuration
# Listener for standard MQTT traffic
listener 1883 0.0.0.0
protocol mqtt

# Listener for WebSockets (port 9001 per spec)
listener 9001 0.0.0.0
protocol websockets

# Security & Authentication
allow_anonymous true
password_file /mosquitto/config/passwd

# Persistence configuration
persistence true
persistence_location /mosquitto/data/

# Logging configuration
log_dest stdout
log_dest file /mosquitto/log/mosquitto.log
log_type error
log_type warning
log_type notice
log_type information
log_type subscribe
log_type unsubscribe
connection_messages true
log_timestamp true
log_timestamp_format %Y-%m-%dT%H:%M:%S
```

### Configuration Breakdown
- **Dual Listeners:** Separate listeners bind to `0.0.0.0` on ports 1883 (TCP) and 9001 (WebSockets), permitting simultaneous communication from hardware boards and web clients.
- **Authentication:** `password_file` points to the hashed credentials list. `allow_anonymous true` permits rapid prototyping in local networks, while registered accounts (`iot_user`) are strictly validated against `passwd`. For production, `allow_anonymous` should be set to `false`.
- **Persistence:** Retains QoS 1 session state across container restarts in `/mosquitto/data/mosquitto.db`.
- **Audit Logging:** Logs connection events, disconnections, topic subscriptions, and warnings with ISO-8601 timestamps to both `stdout` and `/mosquitto/log/mosquitto.log`.

---

## 3. User & Password Management Automation

Source script: [manage_mqtt_auth.sh](file:///home/frdn/Downloads/Kuliah/IoT/Proyek/scripts/manage_mqtt_auth.sh)

Because `passwd` is mounted read-only (`:ro`) into the running Mosquitto container for security, manual in-place editing inside the container is blocked. The project provides an automated bash utility in `scripts/manage_mqtt_auth.sh` that spins up an ephemeral container, applies PBKDF2 hashing, enforces Mosquitto 2 permission requirements (UID `1883`, mode `0700`), and sends a `SIGHUP` reload signal to Mosquitto.

### Command Reference

#### 1. Add or Update a User
```bash
./scripts/manage_mqtt_auth.sh add <username> <password>
```
*Example:*
```bash
./scripts/manage_mqtt_auth.sh add iot_user iot_password
```
- Uses `mosquitto_passwd -b` to hash and store the credential.
- Sets file ownership to UID `1883:1883` and permissions to `chmod 700`.
- Signals Mosquitto via `kill -HUP 1` to reload credentials without dropping existing client connections.

#### 2. Remove a User
```bash
./scripts/manage_mqtt_auth.sh delete <username>
```
*Example:*
```bash
./scripts/manage_mqtt_auth.sh delete old_sensor_node
```

#### 3. List Registered Users
```bash
./scripts/manage_mqtt_auth.sh list
```
Displays all usernames currently registered in `broker/passwd`.

#### 4. Recreate & Reset Password File
```bash
./scripts/manage_mqtt_auth.sh reset <username> <password>
```
Erases the existing password file and creates a fresh file with a single initial administrative user.

---

## 4. Host Networking & Docker Gateway Resolution

### 4.1 Reaching the Broker from Containers
When the Consumer backend runs inside a Docker container (via `compose.yaml`), connecting to `127.0.0.1` addresses the container itself rather than the host broker.
- **Docker Compose Gateway:** [compose.yaml](file:///home/frdn/Downloads/Kuliah/IoT/Proyek/visualization/consumer/compose.yaml) maps the host interface using `extra_hosts`:
  ```yaml
  extra_hosts:
    - "host.docker.internal:host-gateway"
  ```
- **Configuration:** Set `MQTT_HOST=host.docker.internal` in the Consumer container environment.

### 4.2 Reaching the Broker from ESP8266 Microcontrollers
Microcontrollers on the local Wi-Fi network cannot resolve `localhost` or `host.docker.internal`.
1. Determine the host workstation's LAN IP address:
   ```bash
   python3 scripts/debug_broker.py
   ```
2. Configure that LAN IP (e.g., `192.168.1.120`) in `board/transmit-node/secrets.h` and `board/receive-node/secrets.h`.
3. Ensure host firewall rules allow inbound traffic on port 1883:
   ```bash
   sudo ufw allow 1883/tcp
   sudo ufw allow 9001/tcp
   ```

---

## 5. Broker Diagnostics & Health Verification Suite

Source script: [debug_broker.py](file:///home/frdn/Downloads/Kuliah/IoT/Proyek/scripts/debug_broker.py)

The diagnostic suite validates network reachability, TCP sockets, authentication enforcement, and prints the exact parameters needed for ESP8266 nodes.

### Running the Diagnostic Suite
```bash
python3 scripts/debug_broker.py
```

### Test Stages Executed
1. **Network Interface Discovery:** Resolves the primary outgoing LAN IP address of the host machine (e.g. `192.168.0.121`).
2. **TCP Port Checks:** Probes TCP port 1883 (MQTT) and port 9001 (WebSockets) for open socket connections.
3. **Authentication Verification:**
   - Attempts an anonymous connection to verify whether unauthenticated access is correctly handled.
   - Attempts an authenticated connection using `iot_user` / `iot_password`.
   - Subscribes to `test/diagnostic`, publishes a test message, and asserts loopback reception within 2 seconds.
4. **Firmware Secrets Output:** Prints a ready-to-copy code block formatted for `secrets.h`.

#### Sample Output
```text
======================================================================
  IoT Auto Climate Control — Broker Diagnostic Suite
======================================================================
[*] Host LAN IP Address : 192.168.0.121
[*] Testing TCP port 1883 (MQTT TCP Protocol)... ONLINE [PASS]
[*] Testing TCP port 9001 (WebSockets Protocol)... ONLINE [PASS]
[*] Testing MQTT Authentication Rules...
    - Testing Authenticated connection (iot_user)... CONNECTED [PASS]
    - Testing Loopback Publish/Subscribe... MESSAGE DELIVERED [PASS]

[+] ALL BROKER TESTS PASSED. Broker is ready for multi-node operations.
```
