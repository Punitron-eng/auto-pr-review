// Tiny local dashboard: GET / (page), GET /api/status (JSON), POST /api/poll (poll now).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log } from './util.js';

export function startDashboard({ cfg, getStatus, pollNow }) {
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
    } else {
      res.writeHead(404); res.end('not found');
    }
  });
  const { host = '127.0.0.1', port = 4545 } = cfg.dashboard || {};
  server.on('error', (err) => log.error(`Dashboard failed to start on ${host}:${port}: ${err.message}`));
  server.listen(port, host, () => log.info(`Dashboard: http://localhost:${port}`));
  return server;
}
