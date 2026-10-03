import { chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600); created = true;
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
    await chmod(file, 0o600);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (created) await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function readRotationToken(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
    throw new Error('Rotation credential must be an owner-only regular file');
  }
  const token = (await readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid rotation credential');
  return token;
}

export function makeRotationRpc({ url, publishableKey, token, signal }) {
  return async (method, args = {}) => {
    const response = await fetch(`${url}/rest/v1/rpc/${method}`, {
      method: 'POST',
      headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...args, p_token: token }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
    // Response bodies and request arguments can include secrets. Never log them.
    if (!response.ok) throw new Error(`Rotation RPC ${method} returned HTTP ${response.status}`);
    return response.json();
  };
}
