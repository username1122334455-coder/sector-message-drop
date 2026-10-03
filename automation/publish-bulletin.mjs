import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, processError } from "./process-runner.mjs";
import { verifyPublication } from "./publication-verifier.mjs";

const automationDir = path.dirname(fileURLToPath(import.meta.url));
const defaultUpdateDir = path.join(
  homedir(),
  "Documents",
  "DropMMSSGG Website Updates",
  "Folder1",
);
export function normalizeEventId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw processError("INVALID_EVENT_ID", "Publisher");
  return BigInt(value).toString();
}

export async function publishBulletin(options) {
  try { return await publishBulletinInternal(options); }
  catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code : "PUBLISH_FAILED";
    throw processError(code, "Publisher");
  }
}

async function publishBulletinInternal({
  projectRoot = path.resolve(automationDir, ".."), updateDir = defaultUpdateDir,
  eventId, remote = "git@github.com:username1122334455-coder/sector-message-drop.git",
  baseUrl = "https://dropmmssgg.uk/", commandTimeoutMs = 45000,
  verification = {}, signal, pushEnvironment: suppliedPushEnvironment, checkOnly = false,
  operationTimeoutMs = 270000,
} = {}) {
eventId = normalizeEventId(eventId);
if (!Number.isFinite(operationTimeoutMs) || operationTimeoutMs <= 0 || operationTimeoutMs > 270000) throw processError("INVALID_PROCESS_LIMIT", "Publisher");
const deadlineSignal = AbortSignal.timeout(Math.ceil(operationTimeoutMs));
signal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
const assetsDir = path.join(projectRoot, "assets");
const indexPath = path.join(projectRoot, "index.html");
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const mediaExtensions = new Set([...imageExtensions, ".pdf"]);
const clickHereUrl = "https://www.jessikaprivateprofile.com";
const automationRemote = remote;
const deployKey = path.join(
  homedir(),
  "Library",
  "Application Support",
  "SectorMessageDrop",
  "git",
  "github-deploy-key",
);
const pushEnvironment = suppliedPushEnvironment || (existsSync(deployKey)
  ? {
      ...process.env,
      GIT_SSH_COMMAND: `/usr/bin/ssh -i "${deployKey}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    }
  : process.env);
const transparentPixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

const blankPdf = () => {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];

  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += object;
  }

  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return body;
};

const run = async (command, args, options = {}) => {
  const result = await runProcess(command, args, {
    cwd: projectRoot, timeoutMs: commandTimeoutMs, signal,
    killGraceMs: 250, label: "Publisher command", ...options,
  });
  return result.stdout.trim();
};
const git = (args, options) => run("/usr/bin/git", args, options);
const fail = (code) => { throw processError(code, "Publisher"); };
const isAncestor = async (older, newer) => (await runProcess("/usr/bin/git", ["merge-base", "--is-ancestor", older, newer], {
  cwd: projectRoot, timeoutMs: commandTimeoutMs, signal, killGraceMs: 250,
  label: "Publisher ancestry check", allowedExitCodes: [0, 1],
})).code === 0;
const assertClean = async () => {
  if (await git(["status", "--porcelain=v1", "--untracked-files=all"])) fail("WORKTREE_NOT_CLEAN");
};
const fetchRemote = () => git(["fetch", "--no-tags", automationRemote, "main"], { env: pushEnvironment });
const verify = () => verifyPublication({ projectRoot, baseUrl, ...verification, signal });
const confirmRemote = async (revision) => {
  await fetchRemote();
  if (!await isAncestor(revision, "FETCH_HEAD")) fail("REMOTE_COMMIT_UNCONFIRMED");
  if (await git(["diff", "--name-only", revision, "FETCH_HEAD", "--", "index.html", "assets"])) fail("EVENT_SUPERSEDED");
};

if (!checkOnly) {
  await assertClean();
  await fetchRemote();
  if (eventId !== null) {
    // Inspect both reachable histories before opening the source folder. A
    // verification timeout must not reinterpret a later edit as the same event.
    const history = (await git(["log", "HEAD", "FETCH_HEAD", "--format=%H%x00%B%x00"])).split("\0");
    const matching = new Set();
    for (let index = 0; index + 1 < history.length; index += 2) {
      const revision = history[index].trim();
      if (/^[a-f0-9]{40,64}$/.test(revision) && history[index + 1].split(/\r?\n/).includes(`DropMMSSGG-Rotation-Event: ${eventId}`)) matching.add(revision);
    }
    if (matching.size > 1) fail("AMBIGUOUS_EVENT_HISTORY");
    if (matching.size === 1) {
      const [revision] = matching;
      if (await isAncestor(revision, "FETCH_HEAD")) {
        if (await git(["diff", "--name-only", revision, "FETCH_HEAD", "--", "index.html", "assets"])) fail("EVENT_SUPERSEDED");
        await git(["merge", "--ff-only", "FETCH_HEAD"]);
      } else {
        if (await git(["rev-parse", "HEAD"]) !== revision || !await isAncestor("FETCH_HEAD", revision)) fail("EVENT_RECOVERY_DIVERGED");
        await git(["push", automationRemote, `${revision}:refs/heads/main`], { env: pushEnvironment });
      }
      if (await git(["diff", "--name-only", revision, "HEAD", "--", "index.html", "assets"])) fail("EVENT_LOCAL_CONTENT_CHANGED");
      await confirmRemote(revision);
      const publication = await verify();
      return { ok: true, recovered: true, changed: false, eventId, revision, remoteConfirmed: true, publication };
    }
  }
  // Fast-forward and check authorization before touching public source files.
  await git(["merge", "--ff-only", "FETCH_HEAD"]);
  await assertClean();
  await git(["push", "--dry-run", automationRemote, "HEAD:main"], { env: pushEnvironment });
}

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const files = (await readdir(updateDir))
  .filter((name) => !name.startsWith("."))
  .sort();

const newestMatchingFile = async (predicate) => {
  const matches = files.filter(predicate);
  const candidates = await Promise.all(matches.map(async (name) => ({
    name,
    modifiedAt: (await stat(path.join(updateDir, name))).mtimeMs,
  })));
  candidates.sort((left, right) =>
    right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name),
  );
  return candidates[0]?.name;
};

const isMessageFile = (name) =>
  /^message.*\.(rtf|txt)$/i.test(name) ||
  /^written-?messages?(?:\.(rtf|txt))?$/i.test(name);

const mediaNames = (await Promise.all(
  files
    .filter((name) => {
      const extension = path.extname(name).toLowerCase();
      return mediaExtensions.has(extension) && name.toLowerCase() !== "clickhere.pdf";
    })
    .map(async (name) => ({
      name,
      modifiedAt: (await stat(path.join(updateDir, name))).mtimeMs,
    })),
))
  .sort((left, right) =>
    right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name),
  )
  .map(({ name }) => name);
const messageName = await newestMatchingFile(
  isMessageFile,
);
const isEmptyUpdate = files.length === 0;

if (!isEmptyUpdate && (!mediaNames.length || !messageName)) {
  fail("SOURCE_FOLDER_INCOMPLETE");
}

const messagePath = messageName ? path.join(updateDir, messageName) : null;
const extensionByMime = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};
const mediaItems = await Promise.all(mediaNames.map(async (name, index) => {
  const sourcePath = path.join(updateDir, name);
  const mimeType = await run("/usr/bin/file", ["--mime-type", "-b", sourcePath]);
  const extension = extensionByMime[mimeType];
  if (!extension) fail("UNSUPPORTED_MEDIA_TYPE");
  return {
    name,
    sourcePath,
    mimeType,
    isPdf: mimeType === "application/pdf",
    targetName: `bulletin-photo-${index + 1}${extension}`,
  };
}));

let message = isEmptyUpdate
  ? ""
  : path.extname(messageName).toLowerCase() === ".rtf"
  ? await run("/usr/bin/textutil", ["-convert", "txt", "-stdout", messagePath], { cwd: updateDir })
  : (await readFile(messagePath, "utf8")).trim();

message = message
  .replace(
    /\s*\(\s*click\s*here(?:\s*(?:[-–—:]\s*)?(?:put|add|goes?)\s+here)?\s*!?\s*\)\s*$/i,
    "",
  )
  .trim();

const contentDigest = createHash("sha256").update(message);
for (const media of mediaItems) {
  contentDigest.update(await readFile(media.sourcePath));
}
if (isEmptyUpdate) {
  contentDigest.update("empty-bulletin");
}
const digest = contentDigest.digest("hex");
const cacheKey = digest.slice(0, 14);

if (checkOnly) {
  return {
    ok: true,
    empty: isEmptyUpdate,
    media: mediaItems.map(({ name, mimeType }) => ({ name, mediaType: mimeType })),
    message,
    link: clickHereUrl,
    source: updateDir,
  };
}

// Fail before media writes if upstream HTML no longer follows the publisher's
// replacement contract; never silently create a partial update.
const originalHtml = await readFile(indexPath, "utf8");
if ([...originalHtml.matchAll(/<!-- BULLETIN_MEDIA_START -->[\s\S]*?<!-- BULLETIN_MEDIA_END -->/g)].length !== 1 || [...originalHtml.matchAll(/<p class="bulletin-board__message">[\s\S]*?<\/p>/g)].length !== 1) fail("INVALID_BULLETIN_STRUCTURE");
await assertClean();

for (const media of mediaItems) {
  await copyFile(media.sourcePath, path.join(assetsDir, media.targetName));
}
if (isEmptyUpdate) {
  await writeFile(path.join(assetsDir, "bulletin-photo-1.png"), transparentPixelPng);
}

for (const assetName of await readdir(assetsDir)) {
  const isBulletinMedia = /^bulletin-photo(?:-\d+)?\.(png|jpe?g|webp|gif|pdf)$/i.test(assetName);
  const isCurrentMedia = mediaItems.some(({ targetName }) => targetName === assetName);
  const isBulletinPdf = assetName === "clickhere.pdf";
  const keepEmptyAsset = isEmptyUpdate && ["bulletin-photo-1.png", "clickhere.pdf"].includes(assetName);
  if (!keepEmptyAsset && ((isBulletinMedia && !isCurrentMedia) || (isEmptyUpdate && isBulletinPdf))) {
    await unlink(path.join(assetsDir, assetName));
  }
}

const escapedMessage = escapeHtml(message);
const photos = mediaItems.map(({ targetName, isPdf }, index) => {
  const activeClass = index === 0 ? " is-active" : "";
  const hiddenAttribute = index === 0 ? "" : ' aria-hidden="true"';
  const source = `assets/${targetName}?v=photo-${cacheKey}`;
  if (isPdf) {
    return `            <object class="bulletin-board__photo${activeClass}" data="${source}" type="application/pdf" aria-label="Bulletin PDF ${index + 1} of ${mediaItems.length}"${hiddenAttribute}></object>`;
  }
  return `            <img class="bulletin-board__photo${activeClass}" src="${source}" alt="Bulletin portrait ${index + 1} of ${mediaItems.length}"${hiddenAttribute} />`;
}).join("\n");
const controls = mediaItems.length > 1
  ? `
            <div class="bulletin-board__controls" aria-label="Bulletin photos">
              <button class="bulletin-board__nav" type="button" data-bulletin-prev aria-label="Previous photo">‹</button>
              <span class="bulletin-board__counter" data-bulletin-counter>1 / ${mediaItems.length}</span>
              <button class="bulletin-board__nav" type="button" data-bulletin-next aria-label="Next photo">›</button>
            </div>`
  : "";
const gallery = `<!-- BULLETIN_MEDIA_START -->
          <div class="bulletin-board__media" data-bulletin-gallery>
${photos}${controls}
          </div>
          <!-- BULLETIN_MEDIA_END -->`;
const messageHtml = isEmptyUpdate
  ? `<p class="bulletin-board__message"></p>`
  : `<p class="bulletin-board__message">${escapedMessage} (<a class="bulletin-board__link" id="privateMessageLink" href="${clickHereUrl}" rel="noopener noreferrer" aria-label="Open linked page">CLICK HERE</a>)</p>`;

let html = originalHtml;
html = html.replace(
  /<!-- BULLETIN_MEDIA_START -->[\s\S]*?<!-- BULLETIN_MEDIA_END -->/,
  gallery,
);
html = html.replace(
  /<p class="bulletin-board__message">[\s\S]*?<\/p>/,
  messageHtml,
);
await writeFile(indexPath, html, "utf8");

await run(process.execPath, [
  "-e",
  `const fs=require("fs");const h=fs.readFileSync(${JSON.stringify(indexPath)},"utf8");for(const m of h.matchAll(/<script[^>]*>([\\s\\S]*?)<\\/script>/gi)){if(!m[1].includes("cdn.jsdelivr"))new Function(m[1]);}`,
]);

// Reject unrelated changes introduced while preparing the bulletin as well.
const unrelated = (await git(["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude)index.html", ":(exclude)assets"]));
if (unrelated) fail("WORKTREE_NOT_CLEAN");
if (await git(["diff", "--cached", "--name-only"])) fail("INDEX_NOT_CLEAN");
await git(["add", "index.html", "assets"]);
const staged = await git(["diff", "--cached", "--name-only"]);
let changed = false;

if (staged || eventId !== null) {
  const commitMessage = "Auto-update bulletin after visitor" + (eventId !== null ? `\n\nDropMMSSGG-Rotation-Event: ${eventId}` : "");
  await git(["commit", "--allow-empty", "-m", commitMessage]);
  changed = Boolean(staged);
}

// Always push. A previous run may have committed successfully but lost its
// network or credential connection before the push completed.
await git(["push", automationRemote, "HEAD:main"], {
  env: pushEnvironment,
});

const revision = await git(["rev-parse", "HEAD"]);
await confirmRemote(revision);
const publication = await verify();
return {
  ok: true,
  changed,
  empty: isEmptyUpdate,
  mediaCount: mediaItems.length,
  link: clickHereUrl,
  digest,
  cacheKey,
  eventId,
  revision,
  remoteConfirmed: true,
  publication,
};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  const option = (name) => {
    const index = process.argv.indexOf(name);
    if (index < 0) return undefined;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw processError("INVALID_ARGUMENT", "Publisher");
    return value;
  };
  try {
    const source = option("--source");
    const result = await publishBulletin({
      updateDir: source ? path.resolve(source) : defaultUpdateDir,
      eventId: option("--event-id"), checkOnly: process.argv.includes("--check"), signal: controller.signal,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    // Filesystem errors can contain private source paths; keep CLI diagnostics
    // categorical even for errors not produced by the process/verifier helpers.
    const code = typeof error?.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code : "PUBLISH_FAILED";
    console.error(`Publisher failed (${code}); details suppressed`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}
