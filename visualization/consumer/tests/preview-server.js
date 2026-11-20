import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { TelemetryStore } from '../server/store.js';
import { HttpError } from '../server/schemas.js';

// Browser fixtures intercept the API. This preview never connects to real hardware.
const app = createApp({
  config: readConfig({ TELEGRAM_ENABLED: 'false' }),
  store: new TelemetryStore(),
  mqttService: {
    connected: false,
    ready: false,
    async sendCommand() { throw new HttpError(503, 'Test preview does not connect to hardware'); },
  },
});
const server = app.listen(4173, '127.0.0.1');
function stop() {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
