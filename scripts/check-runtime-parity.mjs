import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approvedEntryCommit,
  dynamicBulletinAsset,
  git,
  gitFile,
  gitTreeFiles,
  historicalBaseline,
  isAncestor,
  loadReleaseManifest,
  normalizeBulletin,
  projectRoot,
  readWorkingFile,
  resolveCommit,
  runPreservationCheck,
  sha256,
  workingTreeFiles,
} from './check-preservation.mjs';

const defaultRuntimeRoot = path.join(
  homedir(),
  'Library',
  'Application Support',
  'SectorMessageDrop',
  'rotation-runtime',
);

const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const gitStatus = (root) => git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);

const assertRuntimeRepository = async (runtimeRoot) => {
  let resolvedRoot;
  try {
    resolvedRoot = await realpath(runtimeRoot);
  } catch {
    throw new Error('runtime root is unavailable');
  }
  let repositoryRoot;
  try {
    repositoryRoot = git(resolvedRoot, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('runtime root is not a Git worktree');
  }
  requireCondition(await realpath(repositoryRoot) === resolvedRoot, 'runtime path is not the root of its Git worktree');
  return resolvedRoot;
};

const compareDirectories = async (leftRoot, rightRoot, directory) => {
  const [left, right] = await Promise.all([
    workingTreeFiles(leftRoot, directory),
    workingTreeFiles(rightRoot, directory),
  ]);
  const leftNames = [...left.keys()].sort();
  const rightNames = [...right.keys()].sort();
  requireCondition(
    JSON.stringify(leftNames) === JSON.stringify(rightNames),
    `${directory} inventory differs between candidate and runtime`,
  );
  for (const file of leftNames) {
    requireCondition(left.get(file).equals(right.get(file)), `${file} differs between candidate and runtime`);
  }
  return leftNames.length;
};

const automationAtCommit = (root, commit) => {
  const tree = gitTreeFiles(root, commit, 'automation');
  return new Map([...tree.keys()].map((file) => [file, gitFile(root, commit, file)]));
};

const compareRuntimeAutomation = ({ base, candidate, runtime, automationChanges, runtimeCommitDeclared }) => {
  const files = [...new Set([...base.keys(), ...candidate.keys(), ...runtime.keys(), ...automationChanges.keys()])].sort();
  const pending = [];
  const approved = [];
  let unchanged = 0;

  for (const file of files) {
    const baseBuffer = base.get(file) || null;
    const candidateBuffer = candidate.get(file) || null;
    const runtimeBuffer = runtime.get(file) || null;
    const authorization = automationChanges.get(file);

    if (!authorization) {
      requireCondition(baseBuffer && candidateBuffer && runtimeBuffer, `unreviewed automation inventory change: ${file}`);
      requireCondition(candidateBuffer.equals(baseBuffer), `candidate automation differs without reviewed hashes: ${file}`);
      requireCondition(runtimeBuffer.equals(baseBuffer), `runtime automation differs without reviewed hashes: ${file}`);
      unchanged += 1;
      continue;
    }

    requireCondition(candidateBuffer, `reviewed candidate automation file is missing: ${file}`);
    requireCondition(authorization.baseSha256 === (baseBuffer ? sha256(baseBuffer) : null), `reviewed base hash does not match ${file}`);
    requireCondition(authorization.approvedSha256 === sha256(candidateBuffer), `reviewed candidate hash does not match ${file}`);

    const runtimeDigest = runtimeBuffer ? sha256(runtimeBuffer) : null;
    if (runtimeDigest === authorization.baseSha256) {
      pending.push(file);
    } else if (runtimeDigest === authorization.approvedSha256) {
      approved.push(file);
    } else {
      throw new Error(`runtime automation matches neither reviewed state: ${file}`);
    }
  }

  requireCondition(!(pending.length && approved.length), 'runtime automation is a partial publication; refusing mixed reviewed states');
  if (runtimeCommitDeclared) {
    requireCondition(pending.length === 0, 'runtimeCommit is finalized but reviewed automation is still pending publication');
  } else {
    requireCondition(approved.length === 0, 'reviewed automation is published but runtimeCommit is not finalized in the manifest');
  }

  const status = automationChanges.size === 0
    ? 'exact-unchanged'
    : pending.length
    ? 'pending-publication'
    : 'published-approved';
  return { status, exact: status !== 'pending-publication', unchanged, pending, approved };
};

const changedPaths = (root, from, to) => git(root, ['diff', '--name-only', '-z', from, to])
  .toString('utf8').split('\0').filter(Boolean);

export async function runRuntimeParityCheck({
  root = projectRoot,
  runtimeRoot = defaultRuntimeRoot,
  manifest,
  manifestPath,
  baseline = historicalBaseline,
  entryCommit = approvedEntryCommit,
} = {}) {
  const release = await loadReleaseManifest({ root, manifest, manifestPath });
  await runPreservationCheck({ root, manifest: {
    schemaVersion: release.schemaVersion,
    productionCommit: release.productionCommit,
    ...(release.runtimeCommit ? { runtimeCommit: release.runtimeCommit } : {}),
    automationChanges: Object.fromEntries(release.automationChanges),
  }, baseline, entryCommit });

  const liveRoot = await assertRuntimeRepository(runtimeRoot);
  requireCondition(gitStatus(liveRoot).length === 0, 'runtime worktree is not clean; parity is indeterminate');
  const runtimeHead = git(liveRoot, ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
  resolveCommit(root, runtimeHead, 'runtime HEAD');
  requireCondition(isAncestor(root, release.productionCommit, runtimeHead), 'runtime HEAD is not descended from the reviewed production base');
  if (release.runtimeCommit) {
    requireCondition(isAncestor(root, release.runtimeCommit, runtimeHead), 'runtime HEAD predates or diverges from the finalized runtime commit');
  }

  const candidateHead = git(root, ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
  requireCondition(isAncestor(root, runtimeHead, candidateHead), 'candidate history does not include current runtime HEAD');

  const allowedAutomation = release.runtimeCommit
    ? new Set(release.automationChanges.keys())
    : new Set();
  const unexpected = changedPaths(root, release.productionCommit, runtimeHead).filter((file) =>
    file !== 'index.html' && !dynamicBulletinAsset.test(file) && !allowedAutomation.has(file)
  );
  requireCondition(unexpected.length === 0, `runtime history has out-of-scope changes: ${unexpected.join(', ')}`);

  const runtimeIndex = await readWorkingFile(liveRoot, 'index.html');
  const candidateIndex = await readWorkingFile(root, 'index.html');
  requireCondition(runtimeIndex && candidateIndex, 'candidate or runtime index.html is missing');
  requireCondition(candidateIndex.equals(runtimeIndex), 'candidate index.html is stale relative to runtime');
  const approvedIndex = gitFile(root, entryCommit, 'index.html').toString('utf8');
  requireCondition(
    normalizeBulletin(runtimeIndex.toString('utf8'), 'runtime index') === normalizeBulletin(approvedIndex, 'approved entry index'),
    'runtime index changes structure outside the approved bulletin regions',
  );
  const assetCount = await compareDirectories(root, liveRoot, 'assets');

  const automation = compareRuntimeAutomation({
    base: automationAtCommit(root, release.productionCommit),
    candidate: await workingTreeFiles(root, 'automation'),
    runtime: await workingTreeFiles(liveRoot, 'automation'),
    automationChanges: release.automationChanges,
    runtimeCommitDeclared: Boolean(release.runtimeCommit),
  });

  const endingHead = git(liveRoot, ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
  requireCondition(endingHead === runtimeHead, 'runtime HEAD changed during parity validation; rerun the check');
  requireCondition(gitStatus(liveRoot).length === 0, 'runtime worktree changed during parity validation; rerun the check');

  return {
    ok: true,
    phase: release.runtimeCommit ? 'published' : 'staged',
    productionCommit: release.productionCommit,
    runtimeCommit: release.runtimeCommit,
    runtimeHead,
    sourceContent: { index: 'exact', assets: assetCount },
    automation,
  };
}

const parseArguments = (argv) => {
  let runtimeRoot = defaultRuntimeRoot;
  let manifestPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--runtime-root') {
      runtimeRoot = argv[++index];
      requireCondition(runtimeRoot, '--runtime-root requires a path');
    } else if (argument === '--manifest') {
      manifestPath = argv[++index];
      requireCondition(manifestPath, '--manifest requires a path');
    } else {
      throw new Error(`unsupported argument: ${argument}`);
    }
  }
  return { runtimeRoot, manifestPath };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    console.log(JSON.stringify(await runRuntimeParityCheck({
      runtimeRoot: options.runtimeRoot,
      manifestPath: options.manifestPath,
    })));
  } catch (error) {
    console.error(`RUNTIME PARITY CHECK FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
