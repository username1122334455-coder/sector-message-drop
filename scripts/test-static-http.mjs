import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = new URL(process.argv[2] || 'http://127.0.0.1:8788');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('This test is restricted to the local preview; no live visit or message submissions');
const report = JSON.parse(await readFile(new URL('../.performance/last-build.json', import.meta.url), 'utf8'));
let checks = 0;
const request = (file, options) => fetch(new URL(file, base), { ...options, redirect: 'manual', signal: AbortSignal.timeout(10000) });
for (const file of report.files) {
  const route = file === 'index.html' ? '/' : `/${file}`;
  const response = await request(route);
  assert.equal(response.status, 200, `${file} should be served`);
  assert.ok(response.headers.get('etag'), `${file} needs an ETag`);
  const cache = response.headers.get('cache-control') || '';
  assert.ok(file.startsWith('_static/') ? cache.includes('immutable') : cache.includes('must-revalidate'), `unexpected cache policy for ${file}`);
  const etag = response.headers.get('etag');
  await response.arrayBuffer();
  const conditional = await request(route, { headers: { 'If-None-Match': etag } });
  assert.equal(conditional.status, 304, `${file} should support revalidation`);
  checks += 4;
}
const home = await request('/');
assert.equal(home.status, 200, 'home should render');
assert.ok((home.headers.get('content-type') || '').includes('text/html'));
await home.arrayBuffer();
checks += 2;
const index = await request('/index.html');
assert.equal(index.status, 307, 'Workers canonicalizes index.html to the root');
assert.equal(new URL(index.headers.get('location'), base).pathname, '/');
await index.arrayBuffer();
checks += 2;
const photo = report.files.find((file) => /\.jpg$/.test(file));
if (photo) {
  const response = await request(`/${photo}?v=parity-check`);
  assert.equal(response.status, 200, 'existing publisher cache-busting query must work');
  await response.arrayBuffer();
  checks += 1;
}
for (const file of ['/automation/visitor-watcher.mjs', '/supabase/functions/submit-drop-verified/index.ts', '/package.json', '/.env', '/.git/config', '/DOMAIN-MIGRATION.md', '/missing-page']) {
  const response = await request(file);
  assert.equal(response.status, 404, `private source or missing page must not be served: ${file}`);
  await response.arrayBuffer();
  checks += 1;
}
const head = await request('/', { method: 'HEAD' });
assert.equal(head.status, 200);
assert.equal((await head.arrayBuffer()).byteLength, 0);
checks += 2;
console.log(JSON.stringify({ ok: true, checks, publicFiles: report.files.length, liveWrites: 0 }));
