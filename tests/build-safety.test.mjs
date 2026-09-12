import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertPublicText, build, collectPublicAssets, optimizeDocument } from '../scripts/build-static.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(path.join(root, 'index.html'), 'utf8');

test('build is deterministic and reduces first-party text payload without new browser dependencies', async () => {
  const first = await optimizeDocument(source);
  const second = await optimizeDocument(source);
  assert.equal(first.html === second.html, true, 'HTML must be deterministic');
  assert.deepEqual([...first.generated.keys()], [...second.generated.keys()]);
  const before = Buffer.byteLength(source);
  const after = Buffer.byteLength(first.html) + [...first.generated.values()].reduce((n, v) => n + Buffer.byteLength(v), 0);
  assert.ok(after < before, 'combined generated text should be smaller than source HTML');
});

test('unexpected inline structures fail closed rather than silently dropping behavior', async () => {
  await assert.rejects(optimizeDocument(source + '<style>p{color:red}</style>'), /exactly one/);
  await assert.rejects(optimizeDocument(source.replace('<style>', '<style>@import "extra.css";')), /dependencies/);
});

test('privileged credential shapes are rejected with redacted diagnostics', () => {
  assert.throws(() => assertPublicText('-----BEGIN PRIVATE KEY-----', 'fixture'), /values suppressed/);
  assert.throws(() => assertPublicText('sb_secret_fake_test_value', 'fixture'), /values suppressed/);
  assert.doesNotThrow(() => assertPublicText('sb_publishable_public_test_value', 'fixture'));
});

test('public asset collector rejects scripts and symbolic links', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dropmmssgg-asset-test-'));
  await mkdir(path.join(temp, 'assets'));
  await writeFile(path.join(temp, 'assets', 'unexpected.js'), '/* harmless fixture */');
  await assert.rejects(collectPublicAssets(temp), /Non-media file rejected/);
  const linked = await mkdtemp(path.join(os.tmpdir(), 'dropmmssgg-link-test-'));
  await mkdir(path.join(linked, 'assets'));
  await symlink(path.join(temp, 'assets', 'unexpected.js'), path.join(linked, 'assets', 'picture.jpg'));
  await assert.rejects(collectPublicAssets(linked), /Symlink rejected/);
});

test('deployment output has only public files and safe cache scope', async () => {
  const report = JSON.parse(await readFile(path.join(root, '.performance', 'last-build.json'), 'utf8'));
  assert.ok(report.files.every((file) => file === 'index.html' || file === 'robots.txt' || file.startsWith('assets/') || /^_static\/(site|app)\.[a-f0-9]{16}\.(css|js)$/.test(file)));
  const headers = await readFile(path.join(root, 'dist', '_headers'), 'utf8');
  assert.equal(headers, '/_static/*\n  Cache-Control: public, max-age=31536000, immutable\n');
  assert.equal(report.files.some((file) => /(?:automation|supabase|\.sql|\.env|\.git|\.md)/i.test(file)), false);
});

test('overlapping builds serialize safely and preserve their source', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dropmmssgg-build-test-'));
  await mkdir(path.join(temp, 'assets'));
  const fixture = '<!doctype html><style>p { color: red; }</style><p>Preserved</p><script>const value = 1;</script>';
  await writeFile(path.join(temp, 'index.html'), fixture);
  await writeFile(path.join(temp, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  await Promise.all([build(temp), build(temp)]);
  assert.equal(await readFile(path.join(temp, 'index.html'), 'utf8'), fixture);
  assert.ok((await readFile(path.join(temp, 'dist', 'index.html'), 'utf8')).includes('<p>Preserved</p>'));
});
