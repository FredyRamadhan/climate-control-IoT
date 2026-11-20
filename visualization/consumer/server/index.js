import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { readConfig } from './config.js';
import { TelemetryStore } from './store.js';
import { MqttService } from './mqtt-service.js';
import { createApp } from './app.js';
import { TelegramService } from './telegram-service.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) dotenv.config({ path: envPath, quiet: true });

let config;
try {
  config = readConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const store = new TelemetryStore();
const mqttService = new MqttService({ config, store });
const telegramService = new TelegramService({ config, store, mqttService });
const app = createApp({ config, store, mqttService });
const server = app.listen(config.PORT, config.HOST, () => {
  console.info(`Auto-Climate Control listening at http://${config.HOST}:${config.PORT}`);
  mqttService.start();
  telegramService.start();
});

server.on('error', (error) => {
  console.error(`HTTP server failed: ${error.code || error.message}`);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info('Shutting down Auto-Climate Control.');
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  // Reject pending commands so HTTP requests can finish before closing the server.
  await Promise.all([telegramService.stop(), mqttService.stop()]);
  server.close(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
