import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPublicAssets } from './build-static.mjs';

// A localhost-only, allowlisted view of the unchanged source, for A/B inspection.
const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = new Set(['index.html', 'robots.txt', ...await collectPublicAssets(root)]);
const types = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
  let name;
  try { name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1) || 'index.html'; }
  catch { response.writeHead(400).end(); return; }
  if (!allowed.has(name)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': types[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(path.join(root, name));
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}).listen(8789, '127.0.0.1', () => console.log('Unchanged public source preview: http://127.0.0.1:8789'));
