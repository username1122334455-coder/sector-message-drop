import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireWatcherLock, releaseWatcherLock } from '../automation/watcher-lock.mjs';

const owner = process.getuid();

test('simultaneous stale-lock recovery elects exactly one watcher', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drop-watcher-lock-'));
  const file = path.join(dir, 'watcher.lock');
  await writeFile(file, JSON.stringify({ pid: 999999, nonce: '0'.repeat(32) }), { mode: 0o600 });
  const options = pid => ({ pid, uid: owner, nonce: String(pid).padStart(32, '0'), processAlive: candidate => candidate === 1001 || candidate === 1002 });
  const results = await Promise.allSettled([
    acquireWatcherLock(file, options(1001)),
    acquireWatcherLock(file, options(1002)),
  ]);
  const winners = results.filter(result => result.status === 'fulfilled');
  const losers = results.filter(result => result.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.match(losers[0].reason.message, /already owns|recovery already in progress/);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.pid, winners[0].value.pid);
  assert.equal(await releaseWatcherLock(winners[0].value, { uid: owner }), true);
  assert.deepEqual(await readdir(dir), []);
});

test('a live lock cannot be reclaimed or released by another owner', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drop-watcher-live-'));
  const file = path.join(dir, 'watcher.lock');
  const lease = await acquireWatcherLock(file, { pid: 2001, uid: owner, nonce: 'a'.repeat(32), processAlive: pid => pid === 2001 });
  await assert.rejects(
    acquireWatcherLock(file, { pid: 2002, uid: owner, nonce: 'b'.repeat(32), processAlive: pid => pid === 2001 || pid === 2002 }),
    /already owns/,
  );
  assert.equal(await releaseWatcherLock({ ...lease, nonce: 'c'.repeat(32) }, { uid: owner }), false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, 2001);
  assert.equal(await releaseWatcherLock(lease, { uid: owner }), true);
});

test('an active recovery guard fails closed without deleting the stale primary', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drop-watcher-guard-'));
  const file = path.join(dir, 'watcher.lock');
  const stale = { pid: 3001, nonce: 'd'.repeat(32) };
  await writeFile(file, JSON.stringify(stale), { mode: 0o600 });
  await writeFile(`${file}.recovery`, JSON.stringify({ pid: 3002, nonce: 'e'.repeat(32) }), { mode: 0o600 });
  await assert.rejects(
    acquireWatcherLock(file, { pid: 3003, uid: owner, nonce: 'f'.repeat(32), processAlive: pid => pid === 3002 }),
    /recovery already in progress/,
  );
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), stale);
});

test('a dead recovery guard also fails closed for manual reconciliation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drop-watcher-dead-guard-'));
  const file = path.join(dir, 'watcher.lock');
  const stale = { pid: 4001, nonce: '1'.repeat(32) };
  await writeFile(file, JSON.stringify(stale), { mode: 0o600 });
  await writeFile(`${file}.recovery`, JSON.stringify({ pid: 4002, nonce: '2'.repeat(32) }), { mode: 0o600 });
  await assert.rejects(
    acquireWatcherLock(file, { pid: 4003, uid: owner, nonce: '3'.repeat(32), processAlive: () => false }),
    /manual reconciliation required if stale/,
  );
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), stale);
});
