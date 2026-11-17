// Minimal MQTT 3.1.1 fixture for the Docker smoke test, not a general-purpose broker.
// It runs inside the test container and cannot address physical climate devices.
const { createServer } = require('node:net');
const { parser, generate } = require('mqtt-packet');

const sockets = new Set();
let sequence = 0;
let state = { relay_on: true, target_temp: 24, fan_speed: 'medium', override: false };
const timestamp = () => Math.floor(Date.now() / 1000);

function send(socket, packet) {
  if (!socket.destroyed) socket.write(generate(packet));
}

function publish(socket, topic, payload) {
  send(socket, { cmd: 'publish', topic, qos: 0, retain: false, payload: JSON.stringify(payload) });
}

function telemetry(socket) {
  publish(socket, 'transmit/data', {
    motion: true, temp: 26.4, hum: 58, timestamp: timestamp(),
    sensor_ok: true, ir_sent: true, uptime_ms: 7200000, ...state,
    override_indefinite: state.override, sequence: sequence++,
  });
  publish(socket, 'receive/state', {
    ac_power_state: state.relay_on, temp: state.target_temp,
    fan_speed: state.fan_speed, timestamp: timestamp(), state_valid: true,
  });
}

const broker = createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  const decoder = parser();
  decoder.on('error', () => socket.destroy());
  socket.on('data', (bytes) => decoder.parse(bytes));
  decoder.on('packet', (packet) => {
    if (packet.cmd === 'connect') {
      send(socket, { cmd: 'connack', returnCode: 0, sessionPresent: false });
    } else if (packet.cmd === 'subscribe') {
      send(socket, { cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 1) });
      for (let index = 0; index < 105; index++) telemetry(socket);
      publish(socket, 'transmit/status', { online: true });
      publish(socket, 'receive/status', { online: true });
      publish(socket, 'api/weather', { name: 'Surakarta', main: { temp: 301.15, humidity: 75 }, weather: [{ main: 'Rain' }] });
    } else if (packet.cmd === 'publish') {
      if (packet.qos === 1) send(socket, { cmd: 'puback', messageId: packet.messageId });
      if (packet.topic !== 'transmit/command') return;
      const command = JSON.parse(packet.payload.toString());
      if (command.request_id === 'docker-noack') return;
      if (command.request_id === 'docker-rejected') {
        publish(socket, 'transmit/command/ack', {
          ok: false, override: state.override, raw_only: false,
          request_id: command.request_id, timestamp: timestamp(), error: 'Test rejection',
        });
        return;
      }
      if (command.action === 'override') {
        for (const field of ['relay_on', 'target_temp', 'fan_speed']) {
          if (command[field] != null) state[field] = command[field];
        }
        state.override = true;
      } else if (command.action === 'release') state.override = false;
      publish(socket, 'transmit/command/ack', {
        ok: true, override: state.override, raw_only: command.action === 'raw',
        request_id: command.request_id, action: command.action, timestamp: timestamp(),
        applied: { relay_on: state.relay_on, target_temp: state.target_temp, fan_speed: state.fan_speed },
        ...(command.ir_code ? { ir_code: command.ir_code } : {}),
      });
      telemetry(socket);
    } else if (packet.cmd === 'pingreq') send(socket, { cmd: 'pingresp' });
    else if (packet.cmd === 'disconnect') socket.end();
  });
});

const interval = setInterval(() => {
  for (const socket of sockets) telemetry(socket);
}, 2000);
broker.listen(1883, '127.0.0.1', () => console.log('MQTT test broker ready'));
process.on('SIGTERM', () => {
  clearInterval(interval);
  for (const socket of sockets) socket.destroy();
  broker.close(() => process.exit(0));
});
