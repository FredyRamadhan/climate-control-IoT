#!/usr/bin/env python3
"""
IoT Auto Climate Control — Mosquitto Broker & ESP8266 Diagnostic Suite
Validates broker status, network reachability, authentication enforcement,
and prints the exact network parameters needed for ESP8266 nodes.
"""

import sys
import time
import socket
import subprocess
import paho.mqtt.client as mqtt

MQTT_PORT = 1883
WS_PORT = 9001
MQTT_USER = "iot_user"
MQTT_PASS = "iot_password"


def get_host_ip():
    """Finds the primary outgoing/LAN IP address of the host machine."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Does not actually connect or send data, just routes to determine local interface
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def test_socket(host, port, desc):
    print(f"[*] Testing TCP port {port} ({desc})... ", end="")
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2.0)
    try:
        s.connect((host, port))
        s.close()
        print("ONLINE [PASS]")
        return True
    except Exception as e:
        print(f"FAILED ({e}) [FAIL]")
        return False


def test_auth():
    print("[*] Testing MQTT Authentication Rules...")

    # 1. Anonymous test (should fail)
    print("    - Testing Anonymous access rejection... ", end="")
    try:
        client_anon = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="test-anon-check",
        )
    except AttributeError:
        client_anon = mqtt.Client(client_id="test-anon-check")

    anon_rejected = False

    def on_connect_anon(c, userdata, flags, rc, properties=None):
        nonlocal anon_rejected
        rc_val = rc if isinstance(rc, int) else rc.value
        if rc_val != 0:
            anon_rejected = True

    client_anon.on_connect = on_connect_anon
    try:
        client_anon.connect("127.0.0.1", MQTT_PORT, keepalive=5)
        client_anon.loop(timeout=2.0)
    except Exception:
        anon_rejected = True
    finally:
        client_anon.disconnect()

    if anon_rejected:
        print("REJECTED AS REQUIRED [PASS]")
    else:
        print("UNEXPECTED ACCEPTANCE [FAIL]")

    # 2. Authenticated test
    print(f"    - Testing Authenticated connection ({MQTT_USER})... ", end="")
    try:
        client_auth = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="test-auth-check",
        )
    except AttributeError:
        client_auth = mqtt.Client(client_id="test-auth-check")

    client_auth.username_pw_set(MQTT_USER, MQTT_PASS)
    auth_ok = False
    msg_received = False

    def on_connect_auth(c, userdata, flags, rc, properties=None):
        nonlocal auth_ok
        rc_val = rc if isinstance(rc, int) else rc.value
        if rc_val == 0:
            auth_ok = True
            c.subscribe("test/diagnostic")

    def on_message(c, userdata, msg):
        nonlocal msg_received
        msg_received = True

    client_auth.on_connect = on_connect_auth
    client_auth.on_message = on_message

    try:
        client_auth.connect("127.0.0.1", MQTT_PORT, keepalive=10)
        client_auth.loop_start()
        time.sleep(0.5)

        if auth_ok:
            client_auth.publish("test/diagnostic", "diagnostic_ping", qos=1)
            time.sleep(0.5)

        client_auth.loop_stop()
        client_auth.disconnect()
    except Exception as e:
        print(f"FAILED ({e}) [FAIL]")
        return False

    if auth_ok and msg_received:
        print("AUTHENTICATED & PUB/SUB VERIFIED [PASS]")
        return True
    else:
        print(
            f"FAILED (auth_ok={auth_ok}, msg_received={msg_received}) [FAIL]"
        )
        return False


def main():
    print("==================================================================")
    print("       MOSQUITTO BROKER & ESP8266 NETWORK DIAGNOSTIC TOOL         ")
    print("==================================================================")

    lan_ip = get_host_ip()
    print(f"Host LAN IP Address: \033[1;32m{lan_ip}\033[0m")
    print()

    # Port reachability
    p1883_ok = test_socket("127.0.0.1", MQTT_PORT, "Standard MQTT TCP")
    p9001_ok = test_socket("127.0.0.1", WS_PORT, "WebSocket MQTT")

    if not p1883_ok:
        print(
            "\n[!] Error: Mosquitto is not listening on 1883. Run 'cd broker && docker compose up -d'"
        )
        sys.exit(1)

    print()
    auth_ok = test_auth()

    print("\n==================================================================")
    print("                ESP8266 CONFIGURATION CHEAT-SHEET                 ")
    print("==================================================================")
    print("Flash your ESP8266 with these exact definitions in 'secrets.h':\n")
    print(f'#define WIFI_SSID     "YOUR_WIFI_NAME"        // Must match host Wi-Fi')
    print(f'#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"')
    print(f'#define MQTT_HOST     "{lan_ip}"   // DO NOT USE 127.0.0.1!')
    print(f"#define MQTT_PORT     1883")
    print(f'#define MQTT_USER     "{MQTT_USER}"')
    print(f'#define MQTT_PASS     "{MQTT_PASS}"')
    print("------------------------------------------------------------------")
    print("Common ESP8266 Pitfalls Resolved:")
    print(
        " 1. Do NOT set MQTT_HOST to 127.0.0.1 (that points to ESP8266 itself)."
    )
    print(
        " 2. Do NOT prefix MQTT_HOST with 'http://' or 'mqtt://' (use raw IP string)."
    )
    print(" 3. ESP8266 and Host PC MUST be connected to the same Wi-Fi network.")
    print(" 4. Use client.connect(clientId, MQTT_USER, MQTT_PASS).")
    print(
        "    Connecting without credentials causes rc=5 (Connection Unauthorized)."
    )
    print("==================================================================")


if __name__ == "__main__":
    main()
