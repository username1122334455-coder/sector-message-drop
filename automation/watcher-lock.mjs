import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const ownerOnly = info => info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0;

function defaultProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function readLock(file, expectedUid) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!ownerOnly(info) || info.uid !== expectedUid) throw new Error('Unsafe watcher lock');
    const value = JSON.parse(await handle.readFile('utf8'));
    if (!Number.isSafeInteger(value.pid) || value.pid < 2 ||
        (value.nonce !== undefined && (typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(value.nonce)))) {
      throw new Error('Invalid watcher lock; reconciliation required');
    }
    return { ...value, path: file, device: info.dev, inode: info.ino };
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error('Unsafe watcher lock');
    throw error;
  } finally {
    await handle?.close();
  }
}

async function createLock(file, owner) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: owner.pid, nonce: owner.nonce }));
    await handle.sync();
    const info = await handle.stat();
    return { path: file, pid: owner.pid, nonce: owner.nonce, device: info.dev, inode: info.ino };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function removeOwnedLock(lease, expectedUid) {
  let current;
  try { current = await readLock(lease.path, expectedUid); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (current.pid !== lease.pid || current.nonce !== lease.nonce ||
      current.device !== lease.device || current.inode !== lease.inode) return false;
  await unlink(lease.path);
  return true;
}

async function clearAbandonedRecoveryGuard(recoveryPath, uid, processAlive) {
  let guard;
  try { guard = await readLock(recoveryPath, uid); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!processAlive(guard.pid)) await removeOwnedLock(guard, uid);
}

export async function acquireWatcherLock(lockPath, {
  pid = process.pid,
  uid = process.getuid(),
  nonce = randomBytes(16).toString('hex'),
  processAlive = defaultProcessAlive,
} = {}) {
  const owner = { pid, nonce };
  const recoveryPath = `${lockPath}.recovery`;
  try {
    const lease = await createLock(lockPath, owner);
    // A reclaimer can die after removing the primary lock. If this process won
    // the new primary lock, it is safe to remove only a dead guard by identity.
    try { await clearAbandonedRecoveryGuard(recoveryPath, uid, processAlive); }
    catch (error) { await removeOwnedLock(lease, uid); throw error; }
    return lease;
  }
  catch (error) { if (error.code !== 'EEXIST') throw error; }

  let existing;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { existing = await readLock(lockPath, uid); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        const lease = await createLock(lockPath, owner);
        try { await clearAbandonedRecoveryGuard(recoveryPath, uid, processAlive); }
        catch (cleanupError) { await removeOwnedLock(lease, uid); throw cleanupError; }
        return lease;
      } catch (createError) {
        if (createError.code !== 'EEXIST') throw createError;
      }
    }
  }
  if (!existing) throw new Error('Watcher lock changed during acquisition');
  if (processAlive(existing.pid)) throw new Error('Another watcher already owns the rotation lock');

  // Serialize stale-lock reclamation. A contender that cannot acquire this
  // guard fails closed instead of check-then-unlinking another process's lock.
  let recovery;
  try { recovery = await createLock(recoveryPath, owner); }
  catch (error) {
    // Never recursively reclaim this guard: that would recreate the same
    // check/unlink race. A guard left by a crash therefore requires a bounded
    // manual reconciliation instead of risking two live watchers.
    if (error.code === 'EEXIST') throw new Error('Watcher lock recovery already in progress; manual reconciliation required if stale');
    throw error;
  }

  try {
    let stale;
    try { stale = await readLock(lockPath, uid); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { return await createLock(lockPath, owner); }
      catch (createError) {
        if (createError.code === 'EEXIST') throw new Error('Another watcher already owns the rotation lock');
        throw createError;
      }
    }
    if (processAlive(stale.pid)) throw new Error('Another watcher already owns the rotation lock');
    await unlink(lockPath);
    try { return await createLock(lockPath, owner); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Another watcher already owns the rotation lock');
      throw error;
    }
  } finally {
    await removeOwnedLock(recovery, uid);
  }
}

export async function releaseWatcherLock(lease, { uid = process.getuid() } = {}) {
  return removeOwnedLock(lease, uid);
}
