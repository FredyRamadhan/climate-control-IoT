# Eclipse Mosquitto MQTT Broker

Containerized Eclipse Mosquitto 2 broker service with authentication, persistence, and WebSocket support.

---

## 1. Quickstart

### Start Broker:
```bash
docker compose up -d
```

### Stop Broker:
```bash
docker compose down
```

### View Live Logs:
```bash
docker logs -f iot-mosquitto-broker
```

---

## 2. Ports & Listeners

- **Port 1883 (`0.0.0.0:1883`):** Standard TCP MQTT.
- **Port 9001 (`0.0.0.0:9001`):** WebSockets MQTT protocol.

*Note: Anonymous access is strictly disabled (`allow_anonymous false`). All clients must provide a valid username and password.*

---

## 3. User & Password Management

### Automated Script (Recommended):
Use the project management utility located in `scripts/`:

```bash
# List all registered users
./scripts/manage_mqtt_auth.sh list

# Add or update a user's password
./scripts/manage_mqtt_auth.sh add <username> <password>

# Delete a user
./scripts/manage_mqtt_auth.sh delete <username>

# Reset password file with a single initial user
./scripts/manage_mqtt_auth.sh reset iot_user iot_password
```

### Manual Command:
Because `passwd` is mounted read-only (`:ro`) into the running container for security, modify it using an ephemeral container:

```bash
# Add/update user
docker run --rm -v "$(pwd):/broker" eclipse-mosquitto:2 \
  mosquitto_passwd -b /broker/passwd <username> <password>

# Fix permissions (required by Mosquitto 2)
docker run --rm -v "$(pwd):/broker" alpine \
  sh -c "chown 1883:1883 /broker/passwd && chmod 700 /broker/passwd"

# Reload Mosquitto container
docker exec iot-mosquitto-broker kill -HUP 1
```
