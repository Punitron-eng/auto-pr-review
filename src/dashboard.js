// Tiny local dashboard: GET / (page), GET /api/status (JSON), POST /api/poll (poll now),
// POST /api/retest {repo, number, kind: 'verify'|'full'} (Re-test button),
// POST /api/approve {repo, number} (Accept button - approves the PR on GitHub).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log } from './util.js';

export function startDashboard({ cfg, getStatus, pollNow, retest, approve }) {
  const page = path.join(ROOT, 'public', 'index.html');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(page));
    } else if (req.method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(getStatus()));
    } else if (req.method === 'POST' && url.pathname === '/api/poll') {
      if (pollNow) pollNow();
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else if (req.method === 'POST' && url.pathname === '/api/retest') {
      jsonAction(req, res, (b) => retest ? retest(String(b.repo), Number(b.number), b.kind) : { code: 503, error: 'not available' });
    } else if (req.method === 'POST' && url.pathname === '/api/approve') {
      jsonAction(req, res, (b) => approve ? approve(String(b.repo), Number(b.number)) : { code: 503, error: 'not available' });
    } else {
      res.writeHead(404); res.end('not found');
    }
  });
  const { host = '127.0.0.1', port = 4545 } = cfg.dashboard || {};
  server.on('error', (err) => log.error(`Dashboard failed to start on ${host}:${port}: ${err.message}`));
  server.listen(port, host, () => log.info(`Dashboard: http://localhost:${port}`));
  return server;
}

/** JSON-only POST (so another website cannot trigger it with a plain form post - that would need a CORS preflight). */
function jsonAction(req, res, handler) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) { res.writeHead(415); res.end('json only'); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 10_000) req.destroy(); });
  req.on('end', async () => {
    let r;
    try { r = await handler(JSON.parse(raw)); }
    catch (err) { r = err instanceof SyntaxError ? { code: 400, error: 'bad json' } : { code: 500, error: err.message }; }
    res.writeHead(r.code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.error ? { ok: false, error: r.error } : { ok: true }));
  });
}
