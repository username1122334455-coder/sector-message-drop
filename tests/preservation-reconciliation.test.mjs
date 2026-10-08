import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadReleaseManifest, normalizeBulletin, runPreservationCheck, sha256 } from '../scripts/check-preservation.mjs';
import { runRuntimeParityCheck } from '../scripts/check-runtime-parity.mjs';

const git = (root, args) => execFileSync('git', args, {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
}).trim();

const page = ({ entry, bulletin, version }) => `<!doctype html>
<html><head><style>body { color: #123; }</style></head><body>
<main><h1>${entry}</h1>
<!-- BULLETIN_MEDIA_START -->
<div class="bulletin-board__media"><img src="assets/bulletin-photo-1.jpg?v=${version}" alt="Bulletin"></div>
<!-- BULLETIN_MEDIA_END -->
<p class="bulletin-board__message">${bulletin}</p>
</main><script>const application = true;</script></body></html>
`;

const commitAll = (root, message) => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
};

async function createFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'dropmmssgg-preservation-'));
  const root = path.join(parent, 'candidate');
  const runtimeRoot = path.join(parent, 'runtime');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'automation'), { recursive: true });
  git(parent, ['init', '-q', root]);
  git(root, ['config', 'user.name', 'Preservation Test']);
  git(root, ['config', 'user.email', 'preservation@example.invalid']);

  await writeFile(path.join(root, '.gitignore'), 'dist/\n');
  await writeFile(path.join(root, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  await writeFile(path.join(root, 'index.html'), page({ entry: 'Original entry', bulletin: 'First bulletin', version: 'one' }));
  await writeFile(path.join(root, 'assets', 'bulletin-photo-1.jpg'), 'first-photo');
  await writeFile(path.join(root, 'assets', 'favicon.svg'), '<svg></svg>');
  await writeFile(path.join(root, 'automation', 'publisher.mjs'), 'export const version = 1;\n');
  const baseline = commitAll(root, 'baseline');

  await writeFile(path.join(root, 'index.html'), page({ entry: 'Verify to enter', bulletin: 'First bulletin', version: 'one' }));
  const entryCommit = commitAll(root, 'approved entry');

  await writeFile(path.join(root, 'index.html'), page({ entry: 'Verify to enter', bulletin: 'Current bulletin', version: 'two' }));
  await writeFile(path.join(root, 'assets', 'bulletin-photo-1.jpg'), 'current-photo');
  const productionCommit = commitAll(root, 'production bulletin');
  git(root, ['worktree', 'add', '--detach', runtimeRoot, productionCommit]);

  const basePublisher = await readFile(path.join(root, 'automation', 'publisher.mjs'));
  const approvedPublisher = Buffer.from('export const version = 2;\n');
  const approvedHelper = Buffer.from('export const helper = true;\n');
  await writeFile(path.join(root, 'automation', 'publisher.mjs'), approvedPublisher);
  await writeFile(path.join(root, 'automation', 'safe-helper.mjs'), approvedHelper);

  const manifest = {
    schemaVersion: 1,
    productionCommit,
    automationChanges: {
      'automation/publisher.mjs': {
        baseSha256: sha256(basePublisher),
        approvedSha256: sha256(approvedPublisher),
      },
      'automation/safe-helper.mjs': {
        baseSha256: null,
        approvedSha256: sha256(approvedHelper),
      },
    },
  };

  return { parent, root, runtimeRoot, baseline, entryCommit, productionCommit, manifest };
}

const preservationOptions = (fixture, manifest = fixture.manifest) => ({
  root: fixture.root,
  baseline: fixture.baseline,
  entryCommit: fixture.entryCommit,
  manifest,
});

test('staged reconciliation preserves production content and reports automation as pending', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));

  const preservation = await runPreservationCheck(preservationOptions(fixture));
  assert.equal(preservation.ok, true);
  assert.equal(preservation.releasePhase, 'staged');
  assert.deepEqual(preservation.automation.reviewed, [
    'automation/publisher.mjs',
    'automation/safe-helper.mjs',
  ]);

  const parity = await runRuntimeParityCheck({
    ...preservationOptions(fixture),
    runtimeRoot: fixture.runtimeRoot,
  });
  assert.equal(parity.ok, true);
  assert.equal(parity.phase, 'staged');
  assert.equal(parity.sourceContent.index, 'exact');
  assert.equal(parity.automation.status, 'pending-publication');
  assert.equal(parity.automation.exact, false);
  assert.deepEqual(parity.automation.pending, [
    'automation/publisher.mjs',
    'automation/safe-helper.mjs',
  ]);
});

test('finalized reconciliation keeps reviewed automation provenance after publication', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));

  const runtimeCommit = commitAll(fixture.root, 'publish reviewed automation');
  git(fixture.runtimeRoot, ['checkout', '--detach', runtimeCommit]);
  const manifest = { ...fixture.manifest, runtimeCommit };

  const preservation = await runPreservationCheck(preservationOptions(fixture, manifest));
  assert.equal(preservation.releasePhase, 'finalized');
  assert.equal(preservation.runtimeCommit, runtimeCommit);

  const parity = await runRuntimeParityCheck({
    ...preservationOptions(fixture, manifest),
    runtimeRoot: fixture.runtimeRoot,
  });
  assert.equal(parity.phase, 'published');
  assert.equal(parity.automation.status, 'published-approved');
  assert.equal(parity.automation.exact, true);
  assert.deepEqual(parity.automation.approved, [
    'automation/publisher.mjs',
    'automation/safe-helper.mjs',
  ]);
});

test('preservation rejects stale content, structural drift, and unreviewed automation', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const indexPath = path.join(fixture.root, 'index.html');
  const photoPath = path.join(fixture.root, 'assets', 'bulletin-photo-1.jpg');
  const originalIndex = await readFile(indexPath);
  const originalPhoto = await readFile(photoPath);

  await writeFile(indexPath, originalIndex.toString('utf8').replace('Verify to enter', 'Changed outside bulletin'));
  await assert.rejects(runPreservationCheck(preservationOptions(fixture)), /outside the approved bulletin regions/);
  await writeFile(indexPath, originalIndex);

  await writeFile(photoPath, 'stale-photo');
  await assert.rejects(runPreservationCheck(preservationOptions(fixture)), /does not match the reviewed runtime commit/);
  await writeFile(photoPath, originalPhoto);

  await writeFile(path.join(fixture.root, 'automation', 'unreviewed.mjs'), 'export default true;\n');
  await assert.rejects(runPreservationCheck(preservationOptions(fixture)), /lacks reviewed hashes/);
});

test('runtime parity fails when production advances beyond candidate history', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));

  await writeFile(
    path.join(fixture.runtimeRoot, 'index.html'),
    page({ entry: 'Verify to enter', bulletin: 'Newer bulletin', version: 'three' }),
  );
  await writeFile(path.join(fixture.runtimeRoot, 'assets', 'bulletin-photo-1.jpg'), 'newer-photo');
  const newerRuntime = commitAll(fixture.runtimeRoot, 'newer runtime bulletin');
  assert.notEqual(newerRuntime, fixture.productionCommit);

  await assert.rejects(
    runRuntimeParityCheck({
      ...preservationOptions(fixture),
      runtimeRoot: fixture.runtimeRoot,
    }),
    /candidate history does not include current runtime HEAD/,
  );
});

test('runtime parity rejects a mixed partial automation publication', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));

  const runtimeCommit = commitAll(fixture.root, 'publish reviewed automation');
  const manifest = { ...fixture.manifest, runtimeCommit };
  git(fixture.runtimeRoot, ['checkout', '--detach', runtimeCommit]);

  await writeFile(
    path.join(fixture.runtimeRoot, 'automation', 'publisher.mjs'),
    'export const version = 1;\n',
  );
  const mixedRuntimeCommit = commitAll(fixture.runtimeRoot, 'partial automation rollback');

  git(fixture.root, ['merge', '--ff-only', mixedRuntimeCommit]);
  await writeFile(
    path.join(fixture.root, 'automation', 'publisher.mjs'),
    'export const version = 2;\n',
  );
  commitAll(fixture.root, 'restore approved candidate automation');

  await assert.rejects(
    runRuntimeParityCheck({
      ...preservationOptions(fixture, manifest),
      runtimeRoot: fixture.runtimeRoot,
    }),
    /partial publication; refusing mixed reviewed states/,
  );
});

const uiPatch = '/* REFINED_UI_START */\nbutton:focus-visible { outline: 3px solid teal; }\n/* REFINED_UI_END */';
const polishedPage = (source) => source
  .replace('</style>', `${uiPatch}</style>`)
  .replace('const application = true;', 'const application = true; const clock = "hour12";');

async function approveUi(fixture, manifest = fixture.manifest) {
  const indexPath = path.join(fixture.root, 'index.html');
  const original = await readFile(indexPath, 'utf8');
  const approved = polishedPage(original);
  // Preserve all bytes, including the final newline, in the review digest.
  const baseSource = execFileSync('git', ['show', `${fixture.entryCommit}:index.html`], { cwd: fixture.root }).toString('utf8');
  const uiRevision = {
    baseSha256: sha256(normalizeBulletin(baseSource, 'fixture entry')),
    approvedSha256: sha256(normalizeBulletin(approved, 'fixture approved UI')),
  };
  await writeFile(indexPath, approved);
  return { original, approved, manifest: { ...manifest, uiRevision } };
}

test('reviewed UI stages independently of already published automation', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const runtimeCommit = commitAll(fixture.root, 'publish automation first');
  git(fixture.runtimeRoot, ['checkout', '--detach', runtimeCommit]);
  const { manifest } = await approveUi(fixture, { ...fixture.manifest, runtimeCommit });

  const preservation = await runPreservationCheck(preservationOptions(fixture, manifest));
  assert.equal(preservation.releasePhase, 'staged');
  assert.equal(preservation.runtimeContent.index, 'reviewed-ui-staged');
  assert.deepEqual(preservation.ui, { status: 'pending-publication', exact: false });
  const parity = await runRuntimeParityCheck({ ...preservationOptions(fixture, manifest), runtimeRoot: fixture.runtimeRoot });
  assert.equal(parity.phase, 'staged');
  assert.equal(parity.automation.status, 'published-approved');
  assert.equal(parity.sourceContent.index, 'reviewed-ui-staged');
  assert.deepEqual(parity.ui, { status: 'pending-publication', exact: false });
});

test('reviewed UI and automation can stage together without a runtimeCommit', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const { manifest } = await approveUi(fixture);
  const parity = await runRuntimeParityCheck({ ...preservationOptions(fixture, manifest), runtimeRoot: fixture.runtimeRoot });
  assert.equal(parity.ui.status, 'pending-publication');
  assert.equal(parity.automation.status, 'pending-publication');
});

test('finalized UI requires exact reviewed runtime bytes and keeps review provenance', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const approvedUi = await approveUi(fixture);
  const runtimeCommit = commitAll(fixture.root, 'publish reviewed UI and automation');
  git(fixture.runtimeRoot, ['checkout', '--detach', runtimeCommit]);
  const manifest = { ...approvedUi.manifest, runtimeCommit };
  const preservation = await runPreservationCheck(preservationOptions(fixture, manifest));
  assert.equal(preservation.runtimeContent.index, 'exact');
  assert.deepEqual(preservation.ui, { status: 'published-approved', exact: true });
  const parity = await runRuntimeParityCheck({ ...preservationOptions(fixture, manifest), runtimeRoot: fixture.runtimeRoot });
  assert.equal(parity.phase, 'published');
  assert.equal(parity.sourceContent.index, 'exact');

  await writeFile(path.join(fixture.root, 'index.html'), approvedUi.approved.replace('Current bulletin', 'Different bulletin'));
  await assert.rejects(runPreservationCheck(preservationOptions(fixture, manifest)), /stale relative to the reviewed production snapshot/);
});

test('UI approval rejects changed, missing, duplicate, and moved polish plus unrelated document drift', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const { original, approved, manifest } = await approveUi(fixture);
  const variants = [
    original,
    approved.replace('3px solid teal', '4px solid teal'),
    approved.replace(uiPatch, ''),
    approved.replace(uiPatch, `${uiPatch}${uiPatch}`),
    approved.replace(uiPatch, '').replace('<style>', `<style>${uiPatch}`),
    approved.replace('const clock = "hour12"', 'const clock = "hour24"'),
    approved.replace('<main>', '<main class="drift">'),
    approved.replace('REFINED_UI_START', 'UNREVIEWED_UI_START'),
  ];
  for (const source of variants) {
    await writeFile(path.join(fixture.root, 'index.html'), source);
    await assert.rejects(runPreservationCheck(preservationOptions(fixture, manifest)), /missing the reviewed UI revision|outside the approved bulletin regions/);
  }
  await writeFile(path.join(fixture.root, 'index.html'), approved);
  await assert.rejects(runPreservationCheck(preservationOptions(fixture)), /outside the approved bulletin regions/);
});

test('UI approval never allows stale or ambiguous rotating bulletin content', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const { approved, manifest } = await approveUi(fixture);
  const indexPath = path.join(fixture.root, 'index.html');
  for (const source of [approved.replace('Current bulletin', 'Stale bulletin'), approved.replace('?v=two', '?v=old')]) {
    await writeFile(indexPath, source);
    await assert.rejects(runPreservationCheck(preservationOptions(fixture, manifest)), /candidate bulletin is stale/);
  }
  await writeFile(indexPath, approved.replace('</main>', '<p class="bulletin-board__message">Duplicate</p></main>'));
  await assert.rejects(runPreservationCheck(preservationOptions(fixture, manifest)), /exactly one bulletin message region/);
});

test('UI revision is strictly shaped and anchored to the approved entry release', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const { manifest } = await approveUi(fixture);
  for (const uiRevision of [
    null,
    { ...manifest.uiRevision, extra: true },
    { ...manifest.uiRevision, baseSha256: 'not-a-hash' },
    { ...manifest.uiRevision, approvedSha256: 'not-a-hash' },
    { ...manifest.uiRevision, approvedSha256: manifest.uiRevision.baseSha256 },
  ]) {
    await assert.rejects(loadReleaseManifest({ manifest: { ...manifest, uiRevision } }), /uiRevision|redundant UI/);
  }
  await assert.rejects(runPreservationCheck(preservationOptions(fixture, {
    ...manifest,
    uiRevision: { ...manifest.uiRevision, baseSha256: 'a'.repeat(64) },
  })), /base hash does not match the approved entry commit/);
});

test('runtime UI publication requires explicit manifest finalization', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const automationCommit = commitAll(fixture.root, 'publish automation first');
  const { manifest } = await approveUi(fixture, { ...fixture.manifest, runtimeCommit: automationCommit });
  const uiCommit = commitAll(fixture.root, 'publish UI');
  git(fixture.runtimeRoot, ['checkout', '--detach', uiCommit]);
  await assert.rejects(runRuntimeParityCheck({
    ...preservationOptions(fixture, manifest), runtimeRoot: fixture.runtimeRoot,
  }), /UI is published but runtimeCommit is not finalized/);
});

test('runtime cannot roll back the UI after the reviewed release is finalized', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const { original, approved, manifest: stagedManifest } = await approveUi(fixture);
  const runtimeCommit = commitAll(fixture.root, 'publish UI and automation');
  const manifest = { ...stagedManifest, runtimeCommit };
  git(fixture.runtimeRoot, ['checkout', '--detach', runtimeCommit]);
  await writeFile(path.join(fixture.runtimeRoot, 'index.html'), original);
  const rollbackCommit = commitAll(fixture.runtimeRoot, 'rollback UI');
  git(fixture.root, ['merge', '--ff-only', rollbackCommit]);
  await writeFile(path.join(fixture.root, 'index.html'), approved);
  commitAll(fixture.root, 'restore approved candidate UI');

  await assert.rejects(runRuntimeParityCheck({
    ...preservationOptions(fixture, manifest), runtimeRoot: fixture.runtimeRoot,
  }), /runtime UI predates the finalized reviewed UI revision/);
});
