#!/usr/bin/env python3
"""
IoT Auto Climate Control Module — End-to-End System Verification Suite
Validates the entire multi-node pipeline:
Broker -> Producer -> Simulated Firmware Nodes -> Consumer REST API.
"""

import sys
import time
import json
import subprocess
import requests
import paho.mqtt.client as mqtt

BASE_URL = "http://127.0.0.1:8000"
MQTT_HOST = "127.0.0.1"
MQTT_PORT = 1883
MQTT_USER = "iot_user"
MQTT_PASS = "iot_password"


def test_e2e():
    print("==================================================================")
    print("    STARTING END-TO-END PIPELINE & INTEGRATION VERIFICATION")
    print("==================================================================")

    # 1. Start Consumer Node
    print("\n[Step 1] Starting Consumer FastAPI service on port 8000...")
    consumer_proc = subprocess.Popen(
        [sys.executable, "consumer/main.py"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    # Wait for consumer /health to become available
    healthy = False
    for attempt in range(15):
        time.sleep(0.5)
        try:
            r = requests.get(f"{BASE_URL}/health", timeout=1)
            if r.status_code == 200 and r.json().get("status") == "ok":
                healthy = True
                print(f"Consumer service online after {attempt * 0.5:.1f}s.")
                break
        except requests.RequestException:
            pass

    if not healthy:
        print("ERROR: Consumer failed to start!")
        consumer_proc.kill()
        sys.exit(1)

    try:
        # 2. Run API-Producer once to publish retained weather
        print("\n[Step 2] Executing API-Producer (--once)...")
        prod_res = subprocess.run(
            [sys.executable, "api-producer/main.py", "--once"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert prod_res.returncode == 0, f"Producer failed: {prod_res.stderr}"
        print("API-Producer published weather payload successfully.")

        # Give Consumer MQTT client loop time to ingest
        time.sleep(1.0)

        # 3. Simulate Transmitter & Receiver Nodes over MQTT
        print("\n[Step 3] Simulating Transmitter and Receiver Nodes over MQTT...")
        try:
            client = mqtt.Client(
                callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                client_id="e2e-firmware-simulator",
            )
        except AttributeError:
            client = mqtt.Client(client_id="e2e-firmware-simulator")

        client.username_pw_set(MQTT_USER, MQTT_PASS)
        client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
        client.loop_start()

        # Telemetry sample 1: Motion detected (rising edge)
        ts1 = int(time.time())
        t_payload1 = {
            "motion": True,
            "temp_c": 27.2,
            "hum": 62.0,
            "ir_cmd": "PWR_ON",
            "ts": ts1,
        }
        client.publish("transmit/data", json.dumps(t_payload1), qos=1)
        print(f"Published transmit/data (PWR_ON): {t_payload1}")

        # Receiver ACK 1: Relay turned ON
        r_payload1 = {"ir_code": "0xFFA25D", "relay": True, "ts": ts1 + 1}
        client.publish("receive/ack", json.dumps(r_payload1), qos=1)
        print(f"Published receive/ack (Relay ON): {r_payload1}")

        time.sleep(0.5)

        # Telemetry sample 2: Motion cleared (falling edge)
        ts2 = int(time.time())
        t_payload2 = {
            "motion": False,
            "temp_c": 25.8,
            "hum": 58.5,
            "ir_cmd": "PWR_OFF",
            "ts": ts2,
        }
        client.publish("transmit/data", json.dumps(t_payload2), qos=1)
        print(f"Published transmit/data (PWR_OFF): {t_payload2}")

        # Receiver ACK 2: Relay turned OFF
        r_payload2 = {"ir_code": "0xFF629D", "relay": False, "ts": ts2 + 1}
        client.publish("receive/ack", json.dumps(r_payload2), qos=1)
        print(f"Published receive/ack (Relay OFF): {r_payload2}")

        client.loop_stop()
        client.disconnect()
        time.sleep(1.0)

        # 4. Query & Verify REST Endpoints
        print("\n[Step 4] Querying and Verifying Consumer REST Endpoints...")

        # /weather/latest
        w_res = requests.get(f"{BASE_URL}/weather/latest", timeout=2)
        assert w_res.status_code == 200, f"Expected 200, got {w_res.status_code}"
        w_data = w_res.json()
        print(f"GET /weather/latest -> {w_data}")
        assert "city" in w_data and "temp_c" in w_data and "hum" in w_data

        # /transmit/latest
        t_res = requests.get(f"{BASE_URL}/transmit/latest", timeout=2)
        assert t_res.status_code == 200, f"Expected 200, got {t_res.status_code}"
        t_data = t_res.json()
        print(f"GET /transmit/latest -> {t_data}")
        assert t_data["motion"] is False
        assert t_data["ir_cmd"] == "PWR_OFF"
        assert t_data["temp_c"] == 25.8

        # /receive/latest
        r_res = requests.get(f"{BASE_URL}/receive/latest", timeout=2)
        assert r_res.status_code == 200, f"Expected 200, got {r_res.status_code}"
        r_data = r_res.json()
        print(f"GET /receive/latest -> {r_data}")
        assert r_data["relay"] is False
        assert r_data["ir_code"] == "0xFF629D"

        # /history/transmit
        hist_t_res = requests.get(f"{BASE_URL}/history/transmit", timeout=2)
        assert hist_t_res.status_code == 200
        hist_t = hist_t_res.json()
        print(
            f"GET /history/transmit -> {len(hist_t)} records stored in ring buffer"
        )
        assert len(hist_t) == 2

        # /history/receive
        hist_r_res = requests.get(f"{BASE_URL}/history/receive", timeout=2)
        assert hist_r_res.status_code == 200
        hist_r = hist_r_res.json()
        print(
            f"GET /history/receive -> {len(hist_r)} records stored in ring buffer"
        )
        assert len(hist_r) == 2

        # 5. Measure Latency Benchmark (NFR: < 200ms)
        print("\n[Step 5] Measuring REST API Response Latency Benchmark...")
        latencies = []
        for i in range(25):
            t0 = time.perf_counter()
            r = requests.get(f"{BASE_URL}/transmit/latest", timeout=1)
            assert r.status_code == 200
            latencies.append((time.perf_counter() - t0) * 1000)

        avg_lat = sum(latencies) / len(latencies)
        max_lat = max(latencies)
        min_lat = min(latencies)
        print(f"Latency Statistics over 25 requests:")
        print(f"  Average : {avg_lat:.2f} ms")
        print(f"  Min     : {min_lat:.2f} ms")
        print(f"  Max     : {max_lat:.2f} ms")
        assert (
            avg_lat < 200.0
        ), f"Average latency {avg_lat:.2f}ms exceeds 200ms requirement!"
        print("  Latency Requirement (< 200ms): PASSED")

        print("\n==================================================================")
        print("       ALL END-TO-END SYSTEM INTEGRATION TESTS PASSED!")
        print("==================================================================")

    finally:
        print("\nShutting down Consumer service...")
        consumer_proc.terminate()
        consumer_proc.wait(timeout=5)
        print("Consumer service stopped.")


if __name__ == "__main__":
    test_e2e()
