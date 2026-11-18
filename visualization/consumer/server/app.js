import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { HttpError } from './schemas.js';
import { resolveTopic } from './topics.js';
import { analyticsRouter } from './analytics.js';

const defaultClientDirectory = fileURLToPath(new URL('../dist/client', import.meta.url));

export function createApp({ config, store, mqttService, clientDirectory = defaultClientDirectory, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      // Remain usable over HTTP on a local network; TLS can terminate at a reverse proxy.
      'upgrade-insecure-requests': null,
      'img-src': ["'self'", 'data:'],
      'style-src': ["'self'"],
      'script-src': ["'self'"],
    } },
    strictTransportSecurity: false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());

  const allowedOrigins = new Set(config.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean));
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && (allowedOrigins.has(origin) || allowedOrigins.has('*'))) {
      res.set('Access-Control-Allow-Origin', allowedOrigins.has('*') ? '*' : origin);
      res.vary('Origin');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/analytics', analyticsRouter({ url: config.ANALYTICS_URL }));

  const api = express.Router();
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  api.get('/health', noStore, (_req, res) => res.json({
    status: 'ok',
    mqtt: mqttService.connected,
    subscriptions_ready: mqttService.ready,
  }));
  api.get('/dashboard', noStore, (_req, res) => res.json({
    health: { status: 'ok', mqtt: mqttService.connected, subscriptions_ready: mqttService.ready },
    ...store.snapshot(),
    stale_after_seconds: config.STALE_AFTER_SECONDS,
    server_time: new Date().toISOString(),
  }));
  api.get('/history/*topic', noStore, (req, res) => {
    const query = req.params.topic.join('/');
    const topic = resolveTopic(query);
    if (!topic) throw new HttpError(404, `Topic '${query}' is not tracked`);
    res.json(store.history(topic));
  });
  // A RegExp retains multi-segment topic aliases in Express 5.
  api.get(/^\/(.+)\/latest$/, noStore, (req, res) => {
    const query = req.params[0];
    const topic = resolveTopic(query);
    if (!topic) throw new HttpError(404, `Topic '${query}' is not tracked`);
    if (!store.has(topic)) throw new HttpError(404, `No data received yet for topic '${topic}'`);
    res.json(store.latest(topic));
  });
  api.post('/command', noStore, async (req, res) => res.json(await mqttService.sendCommand(req.body)));

  // Keep the original firmware/tools API alongside the frontend's /api namespace.
  app.use('/api', api, (_req, res) => res.status(404).json({ detail: 'API endpoint not found' }));
  app.use(api);

  if (existsSync(resolve(clientDirectory, 'index.html'))) {
    app.use('/assets', express.static(resolve(clientDirectory, 'assets'), {
      maxAge: '1y', immutable: true,
    }));
    app.use(express.static(clientDirectory, { maxAge: '1h', index: false }));
    app.get('/', (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(resolve(clientDirectory, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => res.status(503).json({
      detail: 'Frontend not built. Run npm run build, or use the Vite development server at http://localhost:5173.',
    }));
  }

  app.use((_req, res) => res.status(404).json({ detail: 'Endpoint not found' }));
  app.use((error, req, res, _next) => {
    const status = error.status ?? 500;
    if (status >= 500 && !(error instanceof HttpError)) logger.error(error);
    const detail = error.type === 'entity.parse.failed' ? 'Request body must be valid JSON'
      : error.type === 'entity.too.large' ? (req.path.startsWith('/api/analytics/batch') ? 'Ukuran CSV maksimal 5 MB.' : 'Request body exceeds the 16 KB limit')
        : status < 500 || error instanceof HttpError ? error.message : 'Internal server error';
    res.status(status).json({ detail });
  });
  return app;
}
