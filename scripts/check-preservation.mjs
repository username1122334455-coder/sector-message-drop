import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const historicalBaseline = '2b67df51c0b82e06a8f99a02f7b54590f35f0a75';
export const approvedEntryCommit = '30bf1a0ce3d29863a260711322e62e410b8192d9';
export const defaultManifestName = 'release-integrity-manifest.json';

// The tracked manifest is deliberately handwritten after review; this module
// never generates or updates it. During staging, runtimeCommit is omitted and
// automationChanges records each base-to-approved hash pair. After publication,
// runtimeCommit is added while those pairs remain as durable review evidence.

const commitPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
export const dynamicBulletinAsset = /^assets\/bulletin-photo(?:-\d+)?\.(?:png|jpe?g|webp|gif|pdf)$/i;
const mediaBlockPattern = /<!-- BULLETIN_MEDIA_START -->[\s\S]*?<!-- BULLETIN_MEDIA_END -->/g;
const messageBlockPattern = /<p class="bulletin-board__message">[\s\S]*?<\/p>/g;

const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const git = (root, args, options = {}) => execFileSync('git', args, {
  cwd: root,
  maxBuffer: 64 * 1024 * 1024,
  ...options,
});

export const resolveCommit = (root, commit, label = 'commit') => {
  requireCondition(commitPattern.test(commit), `${label} must be a full lowercase 40-character Git commit ID`);
  let resolved;
  try {
    resolved = git(root, ['rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`${label} is not available in this repository`);
  }
  requireCondition(resolved === commit, `${label} did not resolve to its exact declared commit`);
  return resolved;
};

export const isAncestor = (root, ancestor, descendant) => {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error('Git could not verify release ancestry');
};

const validateManifestPath = (file) => {
  requireCondition(typeof file === 'string' && file.length > 0, 'manifest file paths must be non-empty strings');
  requireCondition(file === file.replaceAll('\\', '/'), `manifest path is not POSIX-normalized: ${file}`);
  requireCondition(path.posix.normalize(file) === file && !path.posix.isAbsolute(file), `manifest path is unsafe: ${file}`);
  requireCondition(file.startsWith('automation/'), `manifest path is outside automation/: ${file}`);
};

export async function loadReleaseManifest({
  root = projectRoot,
  manifest,
  manifestPath = path.join(root, defaultManifestName),
} = {}) {
  let parsed = manifest;
  if (parsed === undefined) {
    try {
      parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`${defaultManifestName} is missing; reviewed release hashes are required`);
      }
      throw new Error(`${defaultManifestName} is not valid JSON`);
    }
  }

  requireCondition(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'release integrity manifest must be an object');
  const allowedKeys = new Set(['schemaVersion', 'productionCommit', 'runtimeCommit', 'automationChanges']);
  const unexpectedKeys = Object.keys(parsed).filter((key) => !allowedKeys.has(key));
  requireCondition(unexpectedKeys.length === 0, `release integrity manifest has unsupported fields: ${unexpectedKeys.join(', ')}`);
  requireCondition(parsed.schemaVersion === 1, 'release integrity manifest schemaVersion must be 1');
  requireCondition(commitPattern.test(parsed.productionCommit || ''), 'release integrity manifest needs a full productionCommit');
  requireCondition(
    parsed.runtimeCommit === undefined || parsed.runtimeCommit === null || commitPattern.test(parsed.runtimeCommit),
    'runtimeCommit must be omitted for a staged release or be a full commit ID',
  );
  requireCondition(
    parsed.automationChanges && typeof parsed.automationChanges === 'object' && !Array.isArray(parsed.automationChanges),
    'release integrity manifest automationChanges must be an object',
  );

  const automationChanges = new Map();
  for (const [file, entry] of Object.entries(parsed.automationChanges)) {
    validateManifestPath(file);
    requireCondition(entry && typeof entry === 'object' && !Array.isArray(entry), `automation manifest entry must be an object: ${file}`);
    const entryKeys = Object.keys(entry).sort();
    requireCondition(
      JSON.stringify(entryKeys) === JSON.stringify(['approvedSha256', 'baseSha256']),
      `automation manifest entry has unexpected fields: ${file}`,
    );
    requireCondition(digestPattern.test(entry.approvedSha256 || ''), `approvedSha256 is invalid for ${file}`);
    requireCondition(
      entry.baseSha256 === null || digestPattern.test(entry.baseSha256 || ''),
      `baseSha256 is invalid for ${file}`,
    );
    requireCondition(entry.baseSha256 !== entry.approvedSha256, `redundant automation authorization is not allowed: ${file}`);
    automationChanges.set(file, {
      baseSha256: entry.baseSha256,
      approvedSha256: entry.approvedSha256,
    });
  }

  return {
    schemaVersion: 1,
    productionCommit: parsed.productionCommit,
    runtimeCommit: parsed.runtimeCommit || null,
    automationChanges,
  };
}

export const gitFile = (root, commit, file) => {
  try {
    return git(root, ['show', `${commit}:${file}`]);
  } catch {
    throw new Error(`required file is missing from ${commit.slice(0, 12)}: ${file}`);
  }
};

export const gitTreeFiles = (root, commit, directory) => {
  const output = git(root, ['ls-tree', '-r', '-z', commit, '--', directory]);
  const result = new Map();
  for (const record of output.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/);
    requireCondition(match, `Git returned an unreadable tree record under ${directory}`);
    const [, mode, type, object, file] = match;
    requireCondition(type === 'blob' && mode !== '120000', `non-regular Git entry rejected: ${file}`);
    result.set(file, { mode, object });
  }
  return result;
};

export async function readWorkingFile(root, file) {
  const resolved = path.join(root, ...file.split('/'));
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  requireCondition(info.isFile() && !info.isSymbolicLink(), `non-regular working-tree entry rejected: ${file}`);
  return readFile(resolved);
}

export async function workingTreeFiles(root, directory) {
  const result = new Map();
  const walk = async (relative) => {
    const resolved = path.join(root, ...relative.split('/'));
    let entries;
    try {
      entries = await readdir(resolved, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' && relative === directory) return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const file = `${relative}/${entry.name}`;
      requireCondition(!entry.isSymbolicLink(), `symbolic link rejected: ${file}`);
      if (entry.isDirectory()) {
        await walk(file);
      } else {
        requireCondition(entry.isFile(), `non-regular working-tree entry rejected: ${file}`);
        result.set(file, await readFile(path.join(root, ...file.split('/'))));
      }
    }
  };
  await walk(directory);
  return result;
}

export const normalizeBulletin = (source, label) => {
  const mediaMatches = [...source.matchAll(mediaBlockPattern)];
  const messageMatches = [...source.matchAll(messageBlockPattern)];
  requireCondition(mediaMatches.length === 1, `${label} must contain exactly one bulletin media region`);
  requireCondition(messageMatches.length === 1, `${label} must contain exactly one bulletin message region`);
  return source
    .replace(mediaBlockPattern, '<!-- BULLETIN_MEDIA_REVIEWED_SLOT -->')
    .replace(messageBlockPattern, '<p class="bulletin-board__message">[REVIEWED_BULLETIN_SLOT]</p>');
};

export async function compareWorkingDirectoryToCommit(root, commit, directory) {
  const expected = gitTreeFiles(root, commit, directory);
  const current = await workingTreeFiles(root, directory);
  const expectedNames = [...expected.keys()].sort();
  const currentNames = [...current.keys()].sort();
  requireCondition(
    JSON.stringify(currentNames) === JSON.stringify(expectedNames),
    `${directory} inventory does not match the reviewed runtime commit`,
  );
  for (const file of expectedNames) {
    requireCondition(current.get(file).equals(gitFile(root, commit, file)), `${file} does not match the reviewed runtime commit`);
  }
  return expectedNames.length;
}

const automationBuffersAtCommit = (root, commit) => {
  const tree = gitTreeFiles(root, commit, 'automation');
  return new Map([...tree.keys()].map((file) => [file, gitFile(root, commit, file)]));
};

export function compareAutomationSnapshots({ base, approved, candidate, automationChanges }) {
  const files = [...new Set([...base.keys(), ...approved.keys(), ...candidate.keys(), ...automationChanges.keys()])].sort();
  const reviewed = [];
  let unchanged = 0;

  for (const file of files) {
    const baseBuffer = base.get(file) || null;
    const approvedBuffer = approved.get(file) || null;
    const candidateBuffer = candidate.get(file) || null;
    const authorization = automationChanges.get(file);
    const approvedMatchesBase = Boolean(baseBuffer && approvedBuffer && baseBuffer.equals(approvedBuffer));

    if (approvedMatchesBase) {
      requireCondition(candidateBuffer?.equals(approvedBuffer), `candidate automation differs without approval: ${file}`);
      requireCondition(!authorization, `manifest contains unchanged automation: ${file}`);
      unchanged += 1;
      continue;
    }

    requireCondition(approvedBuffer, `reviewed release may not remove automation: ${file}`);
    requireCondition(candidateBuffer?.equals(approvedBuffer), `candidate automation is not the reviewed release version: ${file}`);
    requireCondition(authorization, `automation change lacks reviewed hashes: ${file}`);
    requireCondition(authorization.baseSha256 === (baseBuffer ? sha256(baseBuffer) : null), `reviewed base hash does not match ${file}`);
    requireCondition(authorization.approvedSha256 === sha256(approvedBuffer), `reviewed release hash does not match ${file}`);
    reviewed.push(file);
  }

  for (const file of automationChanges.keys()) {
    requireCondition(reviewed.includes(file), `manifest entry does not describe a real reviewed automation change: ${file}`);
  }
  return { unchanged, reviewed };
}

const verifyReleaseLineage = (root, release, baseline, entryCommit) => {
  resolveCommit(root, baseline, 'historical baseline');
  resolveCommit(root, entryCommit, 'approved entry commit');
  resolveCommit(root, release.productionCommit, 'production base commit');
  requireCondition(isAncestor(root, baseline, entryCommit), 'approved entry commit is not descended from the historical baseline');
  requireCondition(isAncestor(root, entryCommit, release.productionCommit), 'production base is not descended from the approved entry release');

  const allowedAutomation = new Set(release.automationChanges.keys());
  const changedFromEntry = git(root, ['diff', '--name-only', '-z', entryCommit, release.productionCommit])
    .toString('utf8').split('\0').filter(Boolean);
  const unexpectedBaseChanges = changedFromEntry.filter((file) => file !== 'index.html' && !dynamicBulletinAsset.test(file));
  requireCondition(unexpectedBaseChanges.length === 0, `production base changes non-bulletin paths: ${unexpectedBaseChanges.join(', ')}`);

  const approvedIndex = gitFile(root, entryCommit, 'index.html').toString('utf8');
  const indexCommits = [['production base index', release.productionCommit]];
  if (release.runtimeCommit) {
    resolveCommit(root, release.runtimeCommit, 'reviewed runtime commit');
    requireCondition(isAncestor(root, release.productionCommit, release.runtimeCommit), 'reviewed runtime commit is not descended from the production base');
    const releaseChanges = git(root, ['diff', '--name-only', '-z', release.productionCommit, release.runtimeCommit])
      .toString('utf8').split('\0').filter(Boolean);
    const unexpectedReleaseChanges = releaseChanges.filter((file) =>
      file !== 'index.html' && !dynamicBulletinAsset.test(file) && !allowedAutomation.has(file)
    );
    requireCondition(unexpectedReleaseChanges.length === 0, `reviewed runtime commit has out-of-scope changes: ${unexpectedReleaseChanges.join(', ')}`);
    indexCommits.push(['reviewed runtime index', release.runtimeCommit]);
  }
  for (const [label, commit] of indexCommits) {
    const source = gitFile(root, commit, 'index.html').toString('utf8');
    requireCondition(
      normalizeBulletin(source, label) === normalizeBulletin(approvedIndex, 'approved entry index'),
      `${label} changes structure outside the approved bulletin regions`,
    );
  }
};

export async function runPreservationCheck({
  root = projectRoot,
  manifest,
  manifestPath,
  baseline = historicalBaseline,
  entryCommit = approvedEntryCommit,
} = {}) {
  const release = await loadReleaseManifest({ root, manifest, manifestPath });
  verifyReleaseLineage(root, release, baseline, entryCommit);

  const snapshotCommit = release.runtimeCommit || release.productionCommit;
  const head = git(root, ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
  requireCondition(isAncestor(root, snapshotCommit, head), 'candidate history does not contain the reviewed production snapshot');

  const approvedIndex = gitFile(root, entryCommit, 'index.html').toString('utf8');
  const currentIndexBuffer = await readWorkingFile(root, 'index.html');
  requireCondition(currentIndexBuffer, 'candidate index.html is missing');
  requireCondition(
    normalizeBulletin(currentIndexBuffer.toString('utf8'), 'candidate index') === normalizeBulletin(approvedIndex, 'approved entry index'),
    'candidate index changes structure outside the approved bulletin regions',
  );
  requireCondition(
    currentIndexBuffer.equals(gitFile(root, snapshotCommit, 'index.html')),
    'candidate index.html is stale relative to the reviewed production snapshot',
  );

  const assetCount = await compareWorkingDirectoryToCommit(root, snapshotCommit, 'assets');
  const candidateAutomation = await workingTreeFiles(root, 'automation');
  const automation = compareAutomationSnapshots({
    base: automationBuffersAtCommit(root, release.productionCommit),
    approved: release.runtimeCommit ? automationBuffersAtCommit(root, release.runtimeCommit) : candidateAutomation,
    candidate: candidateAutomation,
    automationChanges: release.automationChanges,
  });

  const baselineFiles = [...gitTreeFiles(root, baseline, '.').keys()].sort();
  const changedOriginalFiles = [];
  let immutableOriginalFilesUnchanged = 0;
  for (const file of baselineFiles) {
    if (file === 'index.html' || file.startsWith('automation/') || dynamicBulletinAsset.test(file)) continue;
    const original = gitFile(root, baseline, file);
    const current = await readWorkingFile(root, file);
    if (file === '.gitignore' && current?.toString('utf8').startsWith(original.toString('utf8'))) {
      immutableOriginalFilesUnchanged += 1;
    } else if (current?.equals(original)) {
      immutableOriginalFilesUnchanged += 1;
    } else {
      changedOriginalFiles.push(file);
    }
  }
  requireCondition(changedOriginalFiles.length === 0, `immutable historical files changed: ${changedOriginalFiles.join(', ')}`);

  return {
    ok: true,
    historicalBaseline: baseline,
    approvedEntryCommit: entryCommit,
    productionCommit: release.productionCommit,
    runtimeCommit: release.runtimeCommit,
    releasePhase: release.runtimeCommit ? 'finalized' : 'staged',
    immutableOriginalFilesUnchanged,
    entryStructure: 'approved outside exact bulletin slots',
    runtimeContent: { index: 'exact', assets: assetCount },
    automation,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runPreservationCheck()));
  } catch (error) {
    console.error(`PRESERVATION CHECK FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
