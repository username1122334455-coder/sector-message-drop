import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { publishBulletin, normalizeEventId } from "../automation/publish-bulletin.mjs";
import { runProcess } from "../automation/process-runner.mjs";
import { verifyPublication } from "../automation/publication-verifier.mjs";

// All publication tests use disposable local Git repositories and loopback HTTP.
// No production source, remote, website, database or credential is accessed.
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
const template = (text = "initial") => `<!doctype html><style>body{color:black}</style><main><p class="bulletin-board__message">${text}</p><!-- BULLETIN_MEDIA_START --><div><img src="assets/bulletin-photo-1.png?v=initial"></div><!-- BULLETIN_MEDIA_END --></main><script>const safe = true;</script>`;
const git = async (cwd, args) => (await runProcess("/usr/bin/git", args, { cwd, timeoutMs: 10000, label: "Fixture Git" })).stdout.trim();

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "dropmmssgg-publish-fixture-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  await mkdir(path.join(repo, "assets"), { recursive: true });
  await mkdir(source);
  await writeFile(path.join(repo, "index.html"), template());
  await writeFile(path.join(repo, "assets", "bulletin-photo-1.png"), pixel);
  await writeFile(path.join(source, "photo.png"), pixel);
  await writeFile(path.join(source, "message.txt"), "fixture next (click here)");
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Publication Test"]);
  await git(repo, ["config", "user.email", "publication-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture baseline"]);
  await git(root, ["init", "--bare", "remote.git"]);
  await git(repo, ["push", remote, "HEAD:main"]);
  let liveMode = "current";
  let htmlOverride;
  let mediaOverride;
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    try {
      if (liveMode === "hang") return;
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname === "/") {
        res.setHeader("Content-Type", "text/html");
        res.end(htmlOverride ?? (liveMode === "stale" ? template("stale") : await readFile(path.join(repo, "index.html"))));
      } else if (pathname.startsWith("/assets/") && !pathname.includes("..")) {
        res.end(mediaOverride ?? await readFile(path.join(repo, pathname)));
      } else { res.writeHead(404); res.end(); }
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    projectRoot: repo, updateDir: source, remote, baseUrl,
    pushEnvironment: { ...process.env, GIT_SSH_COMMAND: "/usr/bin/false" },
    commandTimeoutMs: 10000, verification: { timeoutMs: 1000, pollMs: 20, requestTimeoutMs: 200 },
  };
  return { root, repo, source, remote, baseUrl, options,
    setLiveMode: (value) => { liveMode = value; },
    setHTML: (value) => { htmlOverride = value; },
    setMedia: (value) => { mediaOverride = value; },
    get requests() { return requests; } };
}

test("publisher creates one event commit, confirms remote and exact static publication", async (t) => {
  const f = await fixture(t);
  const result = await publishBulletin({ ...f.options, eventId: "00041" });
  assert.equal(result.ok, true);
  assert.equal(result.eventId, "41");
  assert.equal(result.remoteConfirmed, true);
  assert.equal(result.publication.mediaCount, 1);
  assert.match(await git(f.repo, ["log", "-1", "--format=%B"]), /^DropMMSSGG-Rotation-Event: 41$/m);
  assert.equal(await git(f.repo, ["rev-list", "--count", "HEAD"]), "2");
  assert.equal(await git(f.repo, ["status", "--porcelain"]), "");
  assert.equal(await git(f.remote, ["rev-parse", "refs/heads/main"]), result.revision);
});

test("verification timeout retries the same pushed event without rereading changed source or another commit", async (t) => {
  const f = await fixture(t);
  f.setLiveMode("stale");
  await assert.rejects(publishBulletin({ ...f.options, eventId: "42", verification: { timeoutMs: 80, pollMs: 10, requestTimeoutMs: 50 } }), { code: "PUBLICATION_TIMEOUT" });
  const revision = await git(f.repo, ["rev-parse", "HEAD"]);
  const expected = await readFile(path.join(f.repo, "index.html"));
  await rm(f.source, { recursive: true });
  f.setLiveMode("current");
  const recovered = await publishBulletin({ ...f.options, eventId: "42" });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.revision, revision);
  assert.equal(await git(f.repo, ["rev-list", "--count", "HEAD"]), "2");
  assert.ok(expected.equals(await readFile(path.join(f.repo, "index.html"))));
});

test("committed but unpushed event pushes that exact commit without rendering again", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, "index.html"), template("committed event"));
  await git(f.repo, ["add", "index.html"]);
  await git(f.repo, ["commit", "-m", "Auto-update bulletin after visitor\n\nDropMMSSGG-Rotation-Event: 43"]);
  const revision = await git(f.repo, ["rev-parse", "HEAD"]);
  await rm(f.source, { recursive: true });
  const result = await publishBulletin({ ...f.options, eventId: "43" });
  assert.equal(result.recovered, true);
  assert.equal(result.revision, revision);
  assert.equal(await git(f.remote, ["rev-parse", "refs/heads/main"]), revision);
  assert.equal(await git(f.repo, ["rev-list", "--count", "HEAD"]), "2");
});

test("an already published event with newer different content is not replayed", async (t) => {
  const f = await fixture(t);
  await publishBulletin({ ...f.options, eventId: "44" });
  await writeFile(path.join(f.repo, "index.html"), template("a later bulletin"));
  await git(f.repo, ["add", "index.html"]);
  await git(f.repo, ["commit", "-m", "later bulletin"]);
  await git(f.repo, ["push", f.remote, "HEAD:main"]);
  const revision = await git(f.repo, ["rev-parse", "HEAD"]);
  await assert.rejects(publishBulletin({ ...f.options, eventId: "44" }), { code: "EVENT_SUPERSEDED" });
  assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), revision);
});

test("unrelated staged, unstaged and untracked work each prevent publication", async (t) => {
  const f = await fixture(t);
  const before = await git(f.repo, ["rev-parse", "HEAD"]);
  await writeFile(path.join(f.repo, "unrelated.txt"), "fixture");
  await assert.rejects(publishBulletin({ ...f.options, eventId: "45" }), { code: "WORKTREE_NOT_CLEAN" });
  await git(f.repo, ["add", "unrelated.txt"]);
  await assert.rejects(publishBulletin({ ...f.options, eventId: "45" }), { code: "WORKTREE_NOT_CLEAN" });
  await git(f.repo, ["commit", "-m", "unrelated baseline"]);
  await writeFile(path.join(f.repo, "unrelated.txt"), "changed fixture");
  await assert.rejects(publishBulletin({ ...f.options, eventId: "45" }), { code: "WORKTREE_NOT_CLEAN" });
  assert.equal(await git(f.remote, ["rev-parse", "refs/heads/main"]), before);
  assert.equal(f.requests, 0);
});

test("same bulletin on a new event has one empty event commit and remains retry-idempotent", async (t) => {
  const f = await fixture(t);
  await publishBulletin({ ...f.options, eventId: "46" });
  const result = await publishBulletin({ ...f.options, eventId: "47" });
  assert.equal(result.changed, false);
  assert.equal(await git(f.repo, ["rev-list", "--count", "HEAD"]), "3");
  await publishBulletin({ ...f.options, eventId: "47" });
  assert.equal(await git(f.repo, ["rev-list", "--count", "HEAD"]), "3");
});

test("original newest message and media selection plus source content remain intact", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "message-new.txt"), "newest chosen (click here)");
  await utimes(path.join(f.source, "message.txt"), new Date(1000), new Date(1000));
  await writeFile(path.join(f.source, "other.png"), pixel);
  await utimes(path.join(f.source, "photo.png"), new Date(1000), new Date(1000));
  const original = await readFile(path.join(f.source, "message-new.txt"));
  const checked = await publishBulletin({ ...f.options, checkOnly: true });
  assert.equal(checked.message, "newest chosen");
  assert.equal(checked.media[0].name, "other.png");
  assert.equal(f.requests, 0);
  await publishBulletin({ ...f.options, eventId: "48" });
  assert.ok(original.equals(await readFile(path.join(f.source, "message-new.txt"))));
  assert.equal((await readdir(path.join(f.repo, "assets"))).filter(x => /^bulletin-photo/.test(x)).length, 2);
});

test("check-only mode never accesses even an invalid remote or public URL", async (t) => {
  const f = await fixture(t);
  const before = await git(f.repo, ["rev-parse", "HEAD"]);
  const result = await publishBulletin({ ...f.options, checkOnly: true, remote: path.join(f.root, "missing.git"), baseUrl: "not-a-url" });
  assert.equal(result.ok, true);
  assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(f.requests, 0);
});

test("empty source folder retains the original empty bulletin behavior", async (t) => {
  const f = await fixture(t);
  for (const name of await readdir(f.source)) await rm(path.join(f.source, name));
  const result = await publishBulletin({ ...f.options, eventId: "49" });
  assert.equal(result.empty, true);
  assert.equal(result.mediaCount, 0);
  assert.equal(result.publication.mediaCount, 0);
  assert.match(await readFile(path.join(f.repo, "index.html"), "utf8"), /<p class="bulletin-board__message"><\/p>/);
});

test("missing source and remote errors never reveal private diagnostic strings", async (t) => {
  const f = await fixture(t);
  const marker = "SYNTHETIC-PRIVATE-FIXTURE";
  await assert.rejects(publishBulletin({ ...f.options, remote: path.join(f.root, marker) }), (error) => error.code === "COMMAND_FAILED" && !error.message.includes(marker));
  await assert.rejects(publishBulletin({ ...f.options, updateDir: path.join(f.root, marker), checkOnly: true }), (error) => error.code === "ENOENT" && !error.message.includes(marker));
  await assert.rejects(verifyPublication({ projectRoot: path.join(f.root, marker), baseUrl: f.baseUrl }), (error) => error.code === "INVALID_LOCAL_PUBLICATION" && !error.message.includes(marker));
});

test("static verifier tolerates edge script injection but requires exact media bytes and message", async (t) => {
  const f = await fixture(t);
  f.setHTML(template() + '<script>/* edge-injected harmless fixture */</script>');
  assert.equal((await verifyPublication({ ...f.options, timeoutMs: 400, pollMs: 10 })).ok, true);
  f.setMedia(Buffer.from("not the same media"));
  await assert.rejects(verifyPublication({ ...f.options, timeoutMs: 80, pollMs: 10 }), { code: "PUBLICATION_TIMEOUT" });
  f.setMedia(undefined);
  f.setHTML(template("wrong message"));
  await assert.rejects(verifyPublication({ ...f.options, timeoutMs: 80, pollMs: 10 }), { code: "PUBLICATION_TIMEOUT" });
});

test("verification total deadline and external cancellation bound hung HTTP requests", async (t) => {
  const f = await fixture(t);
  f.setLiveMode("hang");
  const start = Date.now();
  await assert.rejects(verifyPublication({ ...f.options, timeoutMs: 100, pollMs: 10, requestTimeoutMs: 10000 }), { code: "PUBLICATION_TIMEOUT" });
  assert.ok(Date.now() - start < 1000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(verifyPublication({ ...f.options, timeoutMs: 1000, pollMs: 10, signal: controller.signal }), { code: "ABORTED" });
});

test("process runner redacts failures, limits output and supports abort", async () => {
  const synthetic = "SYNTHETIC-DO-NOT-PRINT";
  await assert.rejects(runProcess(process.execPath, ["-e", `console.error('${synthetic}');process.exit(2)`]), (error) => error.code === "COMMAND_FAILED" && !error.message.includes(synthetic));
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { maxBuffer: 128, killGraceMs: 10 }), { code: "OUTPUT_LIMIT" });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal, killGraceMs: 10 }), { code: "ABORTED" });
});

test("process timeout kills descendants even when the group leader exits on TERM", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process-group test");
  const root = await mkdtemp(path.join(tmpdir(), "dropmmssgg-process-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const heartbeat = path.join(root, "heartbeat");
  const childCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),10);`;
  const code = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  await assert.rejects(runProcess(process.execPath, ["-e", code], { timeoutMs: 250, killGraceMs: 50 }), { code: "TIMEOUT" });
  const first = (await stat(heartbeat)).mtimeMs;
  await delay(120);
  assert.equal((await stat(heartbeat)).mtimeMs, first);
});

test("event IDs reject text injection and canonicalize decimal strings", () => {
  assert.equal(normalizeEventId("000123"), "123");
  for (const value of ["1\nsecret", "1:main", "-1", "1e2", 42, ""]) assert.throws(() => normalizeEventId(value), { code: "INVALID_EVENT_ID" });
});
