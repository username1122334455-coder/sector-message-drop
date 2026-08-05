import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const automationDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(automationDir, "..");
const defaultUpdateDir = path.join(
  homedir(),
  "Documents",
  "DropMMSSGG Website Updates",
  "Folder1",
);
const sourceIndex = process.argv.indexOf("--source");
const updateDir = sourceIndex >= 0
  ? path.resolve(process.argv[sourceIndex + 1] || "")
  : defaultUpdateDir;
const assetsDir = path.join(projectRoot, "assets");
const indexPath = path.join(projectRoot, "index.html");
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const mediaExtensions = new Set([...imageExtensions, ".pdf"]);
const clickHereUrl = "https://www.jessikaprivateprofile.com";
const automationRemote = "git@github.com:username1122334455-coder/sector-message-drop.git";
const deployKey = path.join(
  homedir(),
  "Library",
  "Application Support",
  "SectorMessageDrop",
  "git",
  "github-deploy-key",
);
const pushEnvironment = existsSync(deployKey)
  ? {
      ...process.env,
      GIT_SSH_COMMAND: `/usr/bin/ssh -i "${deployKey}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    }
  : process.env;
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

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
};

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
  throw new Error(`${updateDir} must contain at least one bulletin media file and a message file.`);
}

const messagePath = messageName ? path.join(updateDir, messageName) : null;
const extensionByMime = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};
const mediaItems = mediaNames.map((name, index) => {
  const sourcePath = path.join(updateDir, name);
  const mimeType = run("/usr/bin/file", ["--mime-type", "-b", sourcePath]);
  const extension = extensionByMime[mimeType];
  if (!extension) throw new Error(`Unsupported bulletin media type: ${mimeType}`);
  return {
    name,
    sourcePath,
    mimeType,
    isPdf: mimeType === "application/pdf",
    targetName: `bulletin-photo-${index + 1}${extension}`,
  };
});

let message = isEmptyUpdate
  ? ""
  : path.extname(messageName).toLowerCase() === ".rtf"
  ? run("/usr/bin/textutil", ["-convert", "txt", "-stdout", messagePath], { cwd: updateDir })
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

if (process.argv.includes("--check")) {
  console.log(JSON.stringify({
    ok: true,
    empty: isEmptyUpdate,
    media: mediaItems.map(({ name, mimeType }) => ({ name, mediaType: mimeType })),
    message,
    link: clickHereUrl,
    source: updateDir,
  }));
  process.exit(0);
}

const protectedWorkspaceChanges = run("/usr/bin/git", [
  "status",
  "--porcelain",
  "--",
  "index.html",
  "assets",
]);
if (protectedWorkspaceChanges) {
  throw new Error("index.html or assets has uncommitted changes; publish cancelled");
}

// Confirm authentication and fast-forward before touching the live workspace.
run("/usr/bin/git", ["fetch", automationRemote, "main"], {
  env: pushEnvironment,
});
run("/usr/bin/git", ["merge", "--ff-only", "FETCH_HEAD"]);
run("/usr/bin/git", ["push", "--dry-run", automationRemote, "main"], {
  env: pushEnvironment,
});

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

let html = await readFile(indexPath, "utf8");
html = html.replace(
  /<!-- BULLETIN_MEDIA_START -->[\s\S]*?<!-- BULLETIN_MEDIA_END -->/,
  gallery,
);
html = html.replace(
  /<p class="bulletin-board__message">[\s\S]*?<\/p>/,
  messageHtml,
);
await writeFile(indexPath, html, "utf8");

run(process.execPath, [
  "-e",
  `const fs=require("fs");const h=fs.readFileSync(${JSON.stringify(indexPath)},"utf8");for(const m of h.matchAll(/<script[^>]*>([\\s\\S]*?)<\\/script>/gi)){if(!m[1].includes("cdn.jsdelivr"))new Function(m[1]);}`,
]);

run("/usr/bin/git", ["add", "index.html", "assets"]);
const staged = run("/usr/bin/git", ["diff", "--cached", "--name-only"]);
let changed = false;

if (staged) {
  run("/usr/bin/git", ["commit", "-m", "Auto-update bulletin after visitor"]);
  changed = true;
}

// Always push. A previous run may have committed successfully but lost its
// network or credential connection before the push completed.
run("/usr/bin/git", ["push", automationRemote, "main"], {
  env: pushEnvironment,
});

console.log(JSON.stringify({
  ok: true,
  changed,
  empty: isEmptyUpdate,
  mediaCount: mediaItems.length,
  link: clickHereUrl,
  digest,
  cacheKey,
}));
