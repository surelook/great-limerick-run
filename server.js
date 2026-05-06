/**
 * server.js — minimal static file server
 * Serves public/ for the frontend and data/ for the JSON
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 3000;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // serve data files from /data/
  const dataMatch = urlPath.match(/^\/data\/(.+)$/);
  const filePath = dataMatch
    ? join(__dirname, 'data', dataMatch[1])
    : join(__dirname, 'public', urlPath);

  if (!existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }

  const ext  = extname(filePath);
  const mime = MIME[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(readFileSync(filePath));
}).listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
