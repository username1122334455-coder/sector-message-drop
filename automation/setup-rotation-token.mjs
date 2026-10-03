import { open, chmod } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { readRotationToken } from './rotation-io.mjs';

const file = path.join(homedir(), 'Library', 'Application Support', 'SectorMessageDrop', 'rotation-queue-token');
try {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(randomBytes(32).toString('hex') + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await chmod(file, 0o600);
} catch (error) { if (error.code !== 'EEXIST') throw error; }
const token = await readRotationToken(file);
// Only the irreversible hash is used to configure the private database guard.
console.log(JSON.stringify({ file, tokenSha256: createHash('sha256').update(token).digest('hex') }));
