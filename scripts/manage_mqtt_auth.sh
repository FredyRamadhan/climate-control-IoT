#!/usr/bin/env bash
# ==============================================================================
# IoT Auto Climate Control — Mosquitto MQTT User & Password Administration
# Utility to add, delete, list, and reset credentials in broker/passwd.
# Automatically handles hashing, permissions (uid 1883, 0700), and broker reload.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BROKER_DIR="$PROJECT_ROOT/broker"
PASSWD_FILE="$BROKER_DIR/passwd"
CONTAINER_NAME="iot-mosquitto-broker"

usage() {
    echo "Usage: $0 {add|delete|list|reset} [args]"
    echo ""
    echo "Commands:"
    echo "  add <username> <password>    Add or update a user's password"
    echo "  delete <username>            Remove a user from the password file"
    echo "  list                         List all registered usernames"
    echo "  reset <username> <password>  Recreate the password file with a single user"
    echo ""
    echo "Examples:"
    echo "  $0 add esp_sensor secret123"
    echo "  $0 delete old_client"
    echo "  $0 list"
    echo "  $0 reset iot_user iot_password"
    exit 1
}

fix_permissions() {
    # Ensure correct ownership (1883:1883) and 0700 permissions required by Mosquitto 2
    if [ -f "$PASSWD_FILE" ]; then
        docker run --rm -v "$BROKER_DIR:/broker" alpine \
            sh -c "chown 1883:1883 /broker/passwd && chmod 700 /broker/passwd" >/dev/null 2>&1 || true
    fi
}

reload_broker() {
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "[*] Reloading Mosquitto broker configuration..."
        docker exec "$CONTAINER_NAME" kill -HUP 1 >/dev/null 2>&1 || \
            docker restart "$CONTAINER_NAME" >/dev/null 2>&1
        echo "[+] Mosquitto reloaded successfully."
    else
        echo "[!] Warning: Container '$CONTAINER_NAME' is not currently running. Changes will apply on next startup."
    fi
}

cmd="${1:-}"

case "$cmd" in
    add)
        username="${2:-}"
        password="${3:-}"
        if [ -z "$username" ] || [ -z "$password" ]; then
            echo "Error: Both username and password must be provided."
            usage
        fi

        echo "[*] Adding/updating user '$username' in $PASSWD_FILE..."
        # If passwd file doesn't exist, use -c (create)
        flag="-b"
        if [ ! -f "$PASSWD_FILE" ]; then
            flag="-b -c"
        fi

        docker run --rm -v "$BROKER_DIR:/broker" eclipse-mosquitto:2 \
            mosquitto_passwd $flag /broker/passwd "$username" "$password"

        fix_permissions
        reload_broker
        echo "[+] User '$username' configured successfully."
        ;;

    delete)
        username="${2:-}"
        if [ -z "$username" ]; then
            echo "Error: Username to delete must be provided."
            usage
        fi

        if [ ! -f "$PASSWD_FILE" ]; then
            echo "Error: Password file does not exist at $PASSWD_FILE"
            exit 1
        fi

        echo "[*] Deleting user '$username'..."
        docker run --rm -v "$BROKER_DIR:/broker" eclipse-mosquitto:2 \
            mosquitto_passwd -D /broker/passwd "$username"

        fix_permissions
        reload_broker
        echo "[+] User '$username' deleted successfully."
        ;;

    list)
        if [ ! -f "$PASSWD_FILE" ]; then
            echo "No password file found at $PASSWD_FILE."
            exit 0
        fi

        echo "Registered MQTT Users:"
        echo "----------------------"
        docker run --rm -v "$BROKER_DIR:/broker" alpine awk -F: '{print " - " $1}' /broker/passwd 2>/dev/null || \
            awk -F: '{print " - " $1}' "$PASSWD_FILE" 2>/dev/null || echo "Unable to read password file."
        ;;

    reset)
        username="${2:-}"
        password="${3:-}"
        if [ -z "$username" ] || [ -z "$password" ]; then
            echo "Error: Both initial username and password must be provided for reset."
            usage
        fi

        echo "[*] Resetting $PASSWD_FILE with initial user '$username'..."
        docker run --rm -v "$BROKER_DIR:/broker" eclipse-mosquitto:2 \
            mosquitto_passwd -b -c /broker/passwd "$username" "$password"

        fix_permissions
        reload_broker
        echo "[+] Mosquitto password file reset successfully with user '$username'."
        ;;

    *)
        usage
        ;;
esac
