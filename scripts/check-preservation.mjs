import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = '2b67df51c0b82e06a8f99a02f7b54590f35f0a75';
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
const files = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', baseline], { cwd: root }).toString().split('\0').filter(Boolean);
const changed = [];
const authorizedPresentationChanges = [];
// Exact snapshot of the user-requested 2026-09-12 entry cleanup. This is not
// a blanket exception for index.html: any further byte change still fails.
const approvedEntryDigest = 'efb34b39ea17398bc6974779ba3330d0838386a91df7e0ee98293c47ecf1e845';
let matched = 0;
for (const file of files) {
  const original = execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const current = await readFile(path.join(root, file));
  if (file === '.gitignore' && current.toString().startsWith(original.toString())) continue;
  if (file === 'index.html' && digest(current) === approvedEntryDigest) {
    authorizedPresentationChanges.push(file);
    continue;
  }
  if (digest(original) !== digest(current)) changed.push(file);
  else matched += 1;
}
if (changed.length) {
  console.error(JSON.stringify({ ok: false, changedOriginalFiles: changed }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, baseline, originalFilesUnchanged: matched, authorizedPresentationChanges, gitignore: 'original preserved with appended generated-file exclusions' }));
}
