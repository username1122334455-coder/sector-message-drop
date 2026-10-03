import { lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeState, processNextEvent } from './rotation-controller.mjs';
import { atomicJson, makeRotationRpc, readRotationToken } from './rotation-io.mjs';
import { runProcess } from './process-runner.mjs';

const automationDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.resolve(automationDir, '..');
const dataDir = path.join(homedir(), 'Library', 'Application Support', 'SectorMessageDrop');
const updateRoot = path.join(homedir(), 'Documents', 'DropMMSSGG Website Updates');
const statePath = path.join(dataDir, 'visitor-watcher-state.json');
const healthPath = path.join(dataDir, 'visitor-watcher-health.json');
const lockPath = path.join(dataDir, 'visitor-watcher.lock');
const publisher = path.join(automationDir, 'publish-bulletin.mjs');
const supabaseUrl = 'https://hrsrjfpygekjyuwibsia.supabase.co';
const publishableKey = 'sb_publishable_Sl962RuGBx2L5aWFmeeCUQ_t-p0YEHW';
const stop = new AbortController();
const lockNonce = randomBytes(16).toString('hex');
const log = message => console.log(`${new Date().toISOString()} ${message}`);
const folderPath = number => {
  const current = path.join(updateRoot, `Folder${number}`);
  return existsSync(current) ? current : path.join(updateRoot, `FOLDER${number}`);
};

async function folderStatus(number) {
  try {
    const entries = (await readdir(folderPath(number), { withFileTypes: true })).filter(e => !e.name.startsWith('.'));
    if (entries.length === 0) return { ok: true, empty: true };
    if (entries.some(e => !e.isFile())) return { ok: false };
    const files = entries.map(e => e.name);
    const media = files.some(name => /\.(png|jpe?g|webp|gif|pdf)$/i.test(name) && name.toLowerCase() !== 'clickhere.pdf');
    const message = files.some(name => /^message.*\.(rtf|txt)$/i.test(name) || /^written-?messages?(?:\.(rtf|txt))?$/i.test(name));
    return { ok: media && message, empty: false };
  } catch { return { ok: false }; }
}

async function acquireLock() {
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: lockNonce })); await handle.sync(); }
    finally { await handle.close(); }
    return;
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(lockPath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error('Unsafe watcher lock');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (!Number.isSafeInteger(lock.pid) || lock.pid < 2) throw new Error('Invalid watcher lock; reconciliation required');
  try { process.kill(lock.pid, 0); throw new Error('Another watcher already owns the rotation lock'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const stillStale = JSON.parse(await readFile(lockPath, 'utf8'));
  if (stillStale.pid !== lock.pid || stillStale.nonce !== lock.nonce) throw new Error('Watcher lock changed during recovery');
  await unlink(lockPath);
  return acquireLock();
}

async function main() {
  await acquireLock();
  let phase = 'starting'; let lastError = null; let lastQueueCheck = null; let state;
  let healthWrites = Promise.resolve();
  const heartbeat = () => {
    healthWrites = healthWrites.catch(() => {}).then(() => atomicJson(healthPath, {
      version: 5, pid: process.pid, checkedAt: new Date().toISOString(), phase, lastError, lastQueueCheck,
      currentFolder: state?.currentFolder ?? null, pendingEvent: state?.pending?.event?.event_id ?? null,
      lastSuccessfulPublication: state?.lastSuccessfulPublication ?? null,
    }));
    return healthWrites;
  };
  let interval;
  try {
    const token = await readRotationToken(path.join(dataDir, 'rotation-queue-token'));
    const rpc = makeRotationRpc({ url: supabaseUrl, publishableKey, token, signal: stop.signal });
    state = normalizeState(JSON.parse(await readFile(statePath, 'utf8')));
    await atomicJson(statePath, state);
    await heartbeat();
    interval = setInterval(() => { void heartbeat().catch(() => { log('heartbeat write failed'); }); }, 10000);
    log(`visitor queue rotation started; FOLDER${state.currentFolder} is live`);
    while (!stop.signal.aborted) {
      let pause = 10000;
      try {
        phase = 'checking';
        const result = await processNextEvent(state, {
          events: async () => {
            const events = await rpc('dropmmssgg_rotation_pending');
            lastQueueCheck = new Date().toISOString();
            return events;
          },
          ready: folderStatus,
          publish: async pending => {
            phase = 'publishing'; await heartbeat();
            const result = await runProcess(process.execPath, [publisher, '--source', folderPath(pending.folder), '--event-id', pending.event.event_id], {
              cwd: runtimeDir, timeoutMs: 300000, signal: stop.signal, label: 'bulletin publisher', maxBuffer: 1024 * 1024,
            });
            let receipt;
            try { receipt = JSON.parse(result.stdout.trim().split('\n').at(-1)); }
            catch { throw new Error('Publisher returned no valid confirmation'); }
            if (receipt?.ok !== true) throw new Error('Publication not confirmed');
            return receipt;
          },
          acknowledge: eventId => rpc('dropmmssgg_rotation_ack', { p_event_id: eventId }),
          save: value => atomicJson(statePath, value),
        });
        lastError = null;
        phase = result.processed ? 'idle' : result.reason === 'idle' ? 'idle' : 'waiting-folder';
        if (result.processed) {
          log(`FOLDER${result.folder} publish complete: event ${result.eventId}; public delivery verified`);
          pause = 0;
        }
      } catch (error) {
        if (stop.signal.aborted) break;
        phase = 'waiting-retry';
        lastError = { at: new Date().toISOString(), message: String(error.message).slice(0, 220) };
        log(`watcher waiting: ${lastError.message}`);
        pause = 60000;
      }
      await heartbeat();
      await delay(pause, undefined, { signal: stop.signal }).catch(error => { if (!stop.signal.aborted) throw error; });
    }
  } finally {
    clearInterval(interval);
    phase = 'stopped';
    await heartbeat().catch(() => {});
    const owned = JSON.parse(await readFile(lockPath, 'utf8'));
    if (owned.pid === process.pid && owned.nonce === lockNonce) await unlink(lockPath);
  }
}

process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
main().catch(error => { console.error(`Watcher stopped safely: ${String(error.message).slice(0, 220)}`); process.exitCode = 1; });
