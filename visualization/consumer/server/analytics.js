import express from 'express';

// The model remains in Python. Expose only these fixed routes through the SPA's
// existing origin, so no analytics port or browser CORS configuration is needed.
export function analyticsRouter({ url, fetchUpstream = fetch }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(express.text({ type: 'text/csv', limit: '5mb' }));

  const forward = (path) => async (req, res) => {
    const target = new URL(path, `${url.replace(/\/$/, '')}/`);
    if (path === 'summary' && req.query.days !== undefined) {
      if (typeof req.query.days !== 'string' || !/^\d{1,3}$/.test(req.query.days)) {
        return res.status(422).json({ detail: 'Rentang waktu tidak valid.' });
      }
      target.searchParams.set('days', req.query.days);
    }
    const contentType = req.is('text/csv') ? 'text/csv' : 'application/json';
    try {
      const response = await fetchUpstream(target, {
        method: req.method,
        headers: { Accept: path.endsWith('.csv') ? 'text/csv' : 'application/json', 'Content-Type': contentType },
        ...(req.method === 'POST' ? { body: contentType === 'text/csv' ? req.body : JSON.stringify(req.body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      res.status(response.status);
      res.set('Content-Type', response.headers.get('content-type') || 'application/json');
      if (path === 'template.csv') res.attachment('contoh-telemetri.csv');
      res.send(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.status(503).json({ detail: 'Layanan analitik belum dapat dihubungi. Coba lagi setelah layanan tersedia.' });
    }
  };
  router.get('/summary', forward('summary'));
  router.get('/template.csv', forward('template.csv'));
  router.post('/predict', forward('predict'));
  router.post('/batch', (req, res, next) => {
    if (!req.is('text/csv')) return res.status(415).json({ detail: 'Unggah data dengan tipe text/csv.' });
    next();
  }, forward('batch'));
  return router;
}
