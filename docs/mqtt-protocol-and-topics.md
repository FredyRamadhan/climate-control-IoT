# MQTT Wire Protocol & Payload Specifications

This document defines the complete message bus contracts, topic catalog, serialization rules, QoS expectations, and bit-level protocol specifications used throughout the **IoT Auto Climate Control** system.

---

## 1. Topic Catalog Summary

| Topic | Publisher | Subscribers | QoS | Retained | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `transmit/data` | Transmitter Node | Consumer Backend | 1 | `false` | Periodic room climate metrics, occupancy, and internal control state. |
| `transmit/status` | Transmitter Node | Consumer Backend, Dashboard | 1 | `true` | Node connectivity lifecycle (LWT and connect announcements). |
| `transmit/command` | Consumer Backend / CLI | Transmitter Node | 1 | `false` | Commands to initiate manual overrides, set targets, or clear overrides. |
| `transmit/command/ack` | Transmitter Node | Consumer Backend / CLI | 1 | `false` | Synchronous execution confirmation returned by the transmitter. |
| `receive/state` | Receiver Node | Consumer Backend | 1 | `true` | Physical AC power state, fan PWM speed, and verified target temperature. |
| `receive/status` | Receiver Node | Consumer Backend, Dashboard | 1 | `true` | Node connectivity lifecycle (LWT and connect announcements). |
| `api/weather` | API-Producer Node | Consumer Backend | 1 | `true` | Real-time or simulated outdoor ambient temperature and humidity metrics. |

---

## 2. Topic Schemas & Payload Contracts

### 2.1 `transmit/data` (Telemetry Feed)
Published every 5,000 ms (`SAMPLE_INTERVAL_MS`) by the Transmitter Node.

#### Data Dictionary
| Field | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `motion` | `boolean` | Yes | `true` if motion was detected by the PIR sensor during the sample window. | `true` |
| `temp` | `number` (float) | Yes | Current indoor ambient temperature in °C rounded to 1 decimal place. | `27.4` |
| `hum` | `number` (float) | Yes | Current indoor relative humidity in % rounded to 1 decimal place. | `62.0` |
| `timestamp` | `integer` (uint32) | Yes | Unix epoch timestamp in seconds obtained via SNTP. Zero if unsynced. | `1763428800` |
| `fan_speed` | `string` | Yes | Current fan speed setting (`"off"`, `"low"`, `"medium"`, `"high"`). | `"high"` |
| `relay_on` | `boolean` | Yes | Target AC power relay state determined by rules or override. | `true` |
| `light_on` | `boolean` | Yes | Current physical state of the room lighting relay actuator. | `true` |
| `target_temp` | `integer` | Yes | AC temperature setpoint transmitted via IR (range: 16 to 30). | `21` |
| `sensor_ok` | `boolean` | Yes | `true` if both temperature and humidity read successfully from DHT11. | `true` |
| `ir_sent` | `boolean` | Yes | `true` if a fresh or heartbeat IR frame was emitted during this cycle. | `true` |
| `uptime_ms` | `integer` (uint32) | Yes | ESP8266 system uptime in milliseconds (`millis()`). | `382104` |
| `override` | `boolean` | Yes | `true` if automatic rules are suspended by a manual override. | `false` |
| `override_source` | `string` | Optional | Origin of override (`"mqtt"` or `"mqtt-raw"`). Included when `override=true`. | `"mqtt"` |
| `override_indefinite`| `boolean` | Optional | `true` if the override has no duration limit and persists until release. | `false` |
| `override_remaining_s`| `integer` | Optional | Seconds remaining before automatic control resumes. | `45` |
| `warmup` | `boolean` | Optional | `true` during the initial 30-second HC-SR501 PIR sensor warm-up window. | `true` |
| `ir_code` | `string` | Optional | Hex string of the last 32-bit IR frame emitted. Included when `ir_sent=true`. | `"0xA18715EA"` |

#### JSON Example (Standard Autonomous State)
```json
{
  "motion": true,
  "temp": 28.6,
  "hum": 68.2,
  "timestamp": 1763428815,
  "fan_speed": "high",
  "relay_on": true,
  "light_on": true,
  "target_temp": 21,
  "sensor_ok": true,
  "ir_sent": true,
  "uptime_ms": 128450,
  "override": false,
  "ir_code": "0xA18715EA"
}
```

#### JSON Example (Active Manual Override State)
```json
{
  "motion": false,
  "temp": 23.8,
  "hum": 52.0,
  "timestamp": 1763428840,
  "fan_speed": "medium",
  "relay_on": true,
  "light_on": true,
  "target_temp": 24,
  "sensor_ok": true,
  "ir_sent": false,
  "uptime_ms": 153450,
  "override": true,
  "override_source": "mqtt",
  "override_indefinite": false,
  "override_remaining_s": 42
}
```

---

### 2.2 `transmit/status` & `receive/status` (LWT & Connectivity)
Maintains high-fidelity node presence tracking across the network using MQTT Last Will and Testament (LWT).

#### Connection Flow
1. **MQTT Connect:** Client specifies LWT topic (`transmit/status` or `receive/status`), QoS `1`, Retain `true`, and payload `{"online":false}`.
2. **Post-Connect Announcement:** Immediately after establishing the session, the client publishes `{"online":true}` to the same topic with Retain `true`.
3. **Graceful Disconnect:** If disconnected cleanly, the node publishes `{"online":false}`.
4. **Ungraceful Disconnect:** If Wi-Fi drops or power is cut, the broker dispatches the stored LWT payload `{"online":false}` to all subscribers.

#### Payload Schema
```json
{
  "online": true
}
```

---

### 2.3 `transmit/command` (Manual Override Ingestion)
Published by the Consumer Backend (`POST /api/command`) or the `ir_override.py` CLI to commandeer the Transmitter Node.

#### Supported Actions

##### 1. Structured Override (`"action": "override"`)
Directly alters state variables and starts an expiration timer.

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `action` | `string` | Yes | Must be `"override"`. |
| `request_id` | `string` | Yes | Unique correlation token echoed back in the ACK. |
| `relay_on` | `boolean` | Optional | Desired AC power state (`true` = ON, `false` = OFF). |
| `light_on` | `boolean` | Optional | Desired lightbulb relay state (`true` = ON, `false` = OFF). |
| `target_temp` | `integer` | Optional | Target cooling temperature in °C (integer between 16 and 30). |
| `fan_speed` | `string` | Optional | Desired fan speed (`"off"`, `"low"`, `"medium"`, `"high"`). |
| `duration_s` | `integer` | Optional | Duration in seconds (0 = indefinite, max = 86400, default = 60). |

*Note: At least one of `relay_on`, `light_on`, `target_temp`, or `fan_speed` must be supplied.*

```json
{
  "action": "override",
  "request_id": "dash-1763428900-5162a",
  "relay_on": true,
  "light_on": true,
  "target_temp": 22,
  "fan_speed": "medium",
  "duration_s": 180
}
```

##### 2. Override Release (`"action": "release"`)
Immediately clears any active override and resumes autonomous sensor rules.

```json
{
  "action": "release",
  "request_id": "dash-1763428920-91a2b"
}
```

##### 3. Raw IR Frame Transmission (`"action": "raw"`)
Emits an explicit 32-bit hex NEC frame directly from the KY-005 IR LED.

```json
{
  "action": "raw",
  "request_id": "cli-1763428945-88f01",
  "ir_code": "0xA18710EF",
  "duration_s": 60
}
```

---

### 2.4 `transmit/command/ack` (Command Execution Acknowledgment)
Published by the Transmitter Node immediately after processing a command from `transmit/command`.

#### Data Dictionary
| Field | Type | Description |
| :--- | :--- | :--- |
| `ok` | `boolean` | `true` if the command was accepted and applied; `false` on validation error. |
| `request_id` | `string` | Echoed identifier from the request to allow synchronous client correlation. |
| `action` | `string` | Echoed action name (`"override"`, `"release"`, `"raw"`). |
| `override` | `boolean` | Indicates whether a manual override is now active. |
| `override_indefinite`| `boolean` | `true` if duration was set to 0. |
| `raw_only` | `boolean` | `true` if a raw frame did not conform to the internal AC protocol and was emitted once without updating state. |
| `applied` | `object` | Current applied states (`relay_on`, `light_on`, `target_temp`, `fan_speed`). Present when `ok=true` and `raw_only=false`. |
| `ir_code` | `string` | The exact 32-bit hex code transmitted over the IR LED. |
| `error` | `string` | Human-readable explanation if `ok=false`. |
| `timestamp` | `integer` | Unix timestamp of command execution. |

#### JSON Example (Successful Override)
```json
{
  "ok": true,
  "request_id": "dash-1763428900-5162a",
  "action": "override",
  "override": true,
  "override_indefinite": false,
  "raw_only": false,
  "override_source": "mqtt",
  "override_remaining_s": 180,
  "applied": {
    "relay_on": true,
    "light_on": true,
    "target_temp": 22,
    "fan_speed": "medium"
  },
  "ir_code": "0xA18616E9",
  "timestamp": 1763428901
}
```

#### JSON Example (Command Rejection)
```json
{
  "ok": false,
  "request_id": "dash-1763428900-5162a",
  "action": "override",
  "override": false,
  "override_indefinite": false,
  "raw_only": false,
  "error": "target_temp must be 16..30",
  "timestamp": 1763428901
}
```

---

### 2.5 `receive/state` (AC Actuation State Feed)
Published by the Receiver Node whenever a valid IR command is decoded, during periodic 60-second heartbeats, or upon MQTT reconnection.

#### Data Dictionary
| Field | Type | Description |
| :--- | :--- | :--- |
| `ac_power_state` | `boolean` | Operating power status of the AC unit (`true` = Active/ON, `false` = Standby/OFF) decoded from the IR command frame. AC power is controlled strictly via IR signals; relays are not used for AC power cutoff. |
| `temp` | `number` (float) | Current target setpoint temperature in °C decoded from the IR frame. |
| `fan_speed` | `string` | Decoded fan speed mode (`"off"`, `"low"`, `"medium"`, `"high"`). |
| `fan_pwm` | `integer` | Raw ESP8266 PWM duty cycle applied to the 2N2222 base pin (0 to 1023). |
| `timestamp` | `integer` | Unix timestamp of reception. |
| `state_valid` | `boolean` | `true` if at least one valid IR command frame has been decoded since boot. |
| `source` | `string` | Event trigger: `"ir-change"`, `"ir-heartbeat"`, or `"mqtt-connected"`. |

#### JSON Example
```json
{
  "ac_power_state": true,
  "temp": 21.0,
  "fan_speed": "high",
  "fan_pwm": 1023,
  "timestamp": 1763428816,
  "state_valid": true,
  "source": "ir-change"
}
```

---

### 2.6 `api/weather` (External Ambient Weather Feed)
Published by the Python `api-producer` node every 600 seconds with the MQTT `retain` flag set to `true`.

#### Data Dictionary
| Field | Type | Description |
| :--- | :--- | :--- |
| `city` | `string` | City name queried from OpenWeatherMap (e.g., `"Jakarta"`). |
| `temp_c` | `number` (float) | External ambient temperature in °C. |
| `hum` | `integer` | External ambient relative humidity in %. |
| `desc` | `string` | Natural language weather condition description (e.g., `"scattered clouds"`). |
| `ts` | `integer` | Unix timestamp of observation. |

#### JSON Example
```json
{
  "city": "Jakarta",
  "temp_c": 31.4,
  "hum": 78,
  "desc": "scattered clouds",
  "ts": 1763428800
}
```

---

## 3. The Custom 32-bit NEC Infrared Protocol

To ensure reliable, noise-immune wireless communication between the Transmitter and Receiver nodes without interference from commercial remotes, the system implements a customized 32-bit frame adhering to the physical layer of the NEC protocol (38 kHz modulation).

### 3.1 Bit-Level Frame Anatomy

A complete transmission consists of four 8-bit bytes (32 bits total):

```text
 31             24 23             16 15              8 7               0
+-----------------+-----------------+-----------------+-----------------+
| Byte 3: Header  | Byte 2: Flags   | Byte 1: Temp    | Byte 0: ~Temp   |
|      0xA1       | R |  CRC  | Fan |  16..30 (°C)    | Bitwise Inverse |
+-----------------+-----------------+-----------------+-----------------+
```

#### Byte Breakdown:
1. **Byte 3 — Protocol Header (`0xA1`):**
   - Fixed synchronizing identifier (`10100001`).
   - Frames starting with any other value are rejected by the receiver.

2. **Byte 2 — Actuation Flags & Frame Checksum:**
   - **Bit 7 (`0x80`):** AC Power State (`1` = ON, `0` = OFF). Dispatched via IR to the AC unit without cutting mains power.
   - **Bits 6..2 (`0x7C`):** 5-bit XOR Checksum (`(Header ^ FlagsClean ^ Temp) & 0x1F`) shifted left by 2 bits.
   - **Bits 1..0 (`0x03`):** Fan Speed code:
     - `00` (`0x00`): Off (`FAN_OFF`)
     - `01` (`0x01`): Low Speed (`FAN_LOW`)
     - `10` (`0x02`): Medium Speed (`FAN_MEDIUM`)
     - `11` (`0x03`): High Speed (`FAN_HIGH`)

3. **Byte 1 — Target Temperature:**
   - Single unsigned 8-bit integer representing target setpoint in Celsius.
   - Constrained to the valid operating envelope: `16 <= temp <= 30`.

4. **Byte 0 — Integrity Inversion (`~Byte 1`):**
   - Bitwise complement of Byte 1 (`(uint8_t)(~targetTempC)`).
   - Enforces standard NEC error detection where command and inverse command must cancel each other out (`Byte 1 ^ Byte 0 == 0xFF`).

---

### 3.2 Checksum Algorithm & Verification

The 5-bit checksum guarantees that corrupted IR pulses (e.g. from fluorescent lighting or reflections) are discarded.

#### Frame Construction in C++ ([transmit-node.ino](file:///home/frdn/Downloads/Kuliah/IoT/Proyek/board/transmit-node/transmit-node.ino#L178-L186))
```cpp
uint32_t buildIrFrame() {
  uint8_t flags = (relayOn ? AC_IR_RELAY_BIT : 0x00) | (fanSpeed & AC_IR_FAN_MASK);
  uint8_t crc = (AC_IR_HEADER ^ flags ^ targetTempC) & AC_IR_CRC_MASK;

  return ((uint32_t)AC_IR_HEADER << 24) |
         ((uint32_t)(flags | (crc << AC_IR_CRC_SHIFT)) << 16) |
         ((uint32_t)targetTempC << 8) |
         (uint32_t)(uint8_t)(~targetTempC);
}
```

#### Frame Decoding in C++ ([receive-node.ino](file:///home/frdn/Downloads/Kuliah/IoT/Proyek/board/receive-node/receive-node.ino#L150-L186))
```cpp
bool decodeAcFrame(uint32_t rawValue, bool &outPowerOn, uint8_t &outTargetTemp, FanSpeed &outFanSpeed) {
  uint8_t header       = (rawValue >> 24) & 0xFF;
  uint8_t flags        = (rawValue >> 16) & 0xFF;
  uint8_t tempByte     = (rawValue >> 8) & 0xFF;
  uint8_t invertedTemp = rawValue & 0xFF;

  // 1. Verify fixed protocol identifier
  if (header != AC_IR_HEADER) return false;

  // 2. Verify NEC inverted byte integrity
  if ((uint8_t)(~tempByte) != invertedTemp) return false;

  // 3. Verify temperature physical range
  if (tempByte < AC_IR_MIN_TEMP || tempByte > AC_IR_MAX_TEMP) return false;

  // 4. Verify 5-bit XOR frame checksum
  uint8_t flagsWithoutCrc = flags & (AC_IR_RELAY_BIT | AC_IR_FAN_MASK);
  uint8_t receivedCrc     = (flags >> AC_IR_CRC_SHIFT) & AC_IR_CRC_MASK;
  uint8_t expectedCrc     = (AC_IR_HEADER ^ flagsWithoutCrc ^ tempByte) & AC_IR_CRC_MASK;
  if (receivedCrc != expectedCrc) return false;

  outPowerOn    = (flags & AC_IR_RELAY_BIT) != 0;
  outTargetTemp = tempByte;
  outFanSpeed   = (FanSpeed)(flags & AC_IR_FAN_MASK);
  return true;
}
```

---

### 3.3 Frame Reference Examples

| Desired State | Power | Setpoint | Fan Speed | Raw 32-bit Hex Frame |
| :--- | :--- | :--- | :--- | :--- |
| **Max Cooling Occupied** | ON | 16°C | HIGH (3) | `0xA18710EF` |
| **Normal Cooling** | ON | 21°C | HIGH (3) | `0xA18715EA` |
| **Comfort Baseline** | ON | 24°C | MEDIUM (2) | `0xA18618E7` |
| **Eco Standby** | ON | 26°C | LOW (1) | `0xA1851AE5` |
| **System Shutoff** | OFF | 24°C | OFF (0) | `0xA10618E7` |
