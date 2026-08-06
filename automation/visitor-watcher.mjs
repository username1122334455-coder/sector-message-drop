import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const automationDir = path.dirname(fileURLToPath(import.meta.url));
const updateRoot = path.join(
  homedir(),
  "Documents",
  "DropMMSSGG Website Updates",
);
const statePath = path.join(
  homedir(),
  "Library",
  "Application Support",
  "SectorMessageDrop",
  "visitor-watcher-state.json",
);
const publisher = path.join(automationDir, "publish-bulletin.mjs");
const supabaseUrl = "https://hrsrjfpygekjyuwibsia.supabase.co";
const publishableKey = "sb_publishable_Sl962RuGBx2L5aWFmeeCUQ_t-p0YEHW";
const pollMs = 10_000;
const rotationFolders = [1, 2, 3];

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isNewerVisit = (marker, baseline) => {
  if (!marker) return false;
  if (!baseline) return true;

  const markerTime = Date.parse(marker);
  const baselineTime = Date.parse(baseline);
  return Number.isFinite(markerTime) && Number.isFinite(baselineTime)
    ? markerTime > baselineTime
    : marker > baseline;
};

const folderPath = (number) => {
  const currentName = path.join(updateRoot, `Folder${number}`);
  const legacyName = path.join(updateRoot, `FOLDER${number}`);
  return existsSync(currentName) ? currentName : legacyName;
};
const availableFolders = async () => {
  await readdir(updateRoot, { withFileTypes: true });
  return rotationFolders.filter((number) => existsSync(folderPath(number)));
};

const nextFolderAfter = async (currentFolder) => {
  const folders = await availableFolders();
  if (!folders.length) {
    throw new Error(`${updateRoot} has no FOLDER directories`);
  }

  const currentIndex = folders.indexOf(Number(currentFolder));
  if (currentIndex >= 0) {
    return folders[(currentIndex + 1) % folders.length];
  }

  return folders.find((number) => number > Number(currentFolder)) || folders[0];
};

const isMessageFile = (name) =>
  /^message.*\.(rtf|txt)$/i.test(name) ||
  /^written-?messages?(?:\.(rtf|txt))?$/i.test(name);

const validateFolder = async (number) => {
  const files = (await readdir(folderPath(number)))
    .filter((name) => !name.startsWith("."));
  const hasMedia = files.some((name) =>
    /\.(png|jpe?g|webp|gif|pdf)$/i.test(name) &&
    name.toLowerCase() !== "clickhere.pdf"
  );
  const hasMessage = files.some(isMessageFile);

  if (!hasMedia || !hasMessage) {
    throw new Error(`FOLDER${number} needs at least one bulletin media file and one message file`);
  }
};

const folderStatus = async (number) => {
  try {
    const files = (await readdir(folderPath(number)))
      .filter((name) => !name.startsWith("."));
    if (files.length === 0) {
      return { ok: true, empty: true, message: "empty" };
    }

    await validateFolder(number);
    return { ok: true, empty: false, message: "ready" };
  } catch (error) {
    return { ok: false, empty: false, message: error.message };
  }
};

const latestVisit = async () => {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/latest_site_visit_marker`, {
        method: "POST",
        headers: {
          apikey: publishableKey,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(8_000),
      });

      if (!response.ok) {
        throw new Error(`visit RPC returned ${response.status}`);
      }

      return (await response.json()) || null;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 1_000);
    }
  }

  throw new Error(`visit RPC unavailable after 3 attempts: ${lastError?.message || "unknown error"}`);
};

for (const number of await availableFolders()) {
  const status = await folderStatus(number);
  if (status.empty) log(`FOLDER${number} empty: will publish empty state when selected`);
  if (!status.ok) log(`FOLDER${number} not ready: ${status.message}`);
}

let state;
try {
  state = JSON.parse(await readFile(statePath, "utf8"));
} catch {
  state = {};
}

if (state.version !== 3) {
  state = {
    version: 3,
    currentFolder: 1,
    lastProcessedVisit: await latestVisit(),
  };
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

log(`visitor folder rotation started; FOLDER${state.currentFolder} is live`);
log(`watching ${updateRoot}`);

let failedVisitMarker = null;
let retryAfter = 0;

while (true) {
  try {
    const marker = await latestVisit();

    const retryIsCoolingDown =
      marker === failedVisitMarker && Date.now() < retryAfter;

    if (isNewerVisit(marker, state.lastProcessedVisit) && !retryIsCoolingDown) {
      const nextFolder = await nextFolderAfter(state.currentFolder);
      const status = await folderStatus(nextFolder);

      if (!status.ok) {
        state.lastProcessedVisit = marker;
        await writeFile(statePath, JSON.stringify(state, null, 2));
        log(`new visitor detected; no update available; FOLDER${nextFolder} not ready; keeping FOLDER${state.currentFolder} live`);
        continue;
      }

      log(`new visitor detected; publishing ${status.empty ? "empty state from" : ""} FOLDER${nextFolder}`);

      const result = spawnSync(
        process.execPath,
        [publisher, "--source", folderPath(nextFolder)],
        { encoding: "utf8" },
      );

      if (result.status !== 0) {
        failedVisitMarker = marker;
        retryAfter = Date.now() + 60_000;
        throw new Error(
          result.error?.message ||
          result.stderr?.trim() ||
          result.stdout?.trim() ||
          `publisher exited with status ${result.status}`,
        );
      }

      failedVisitMarker = null;
      retryAfter = 0;
      state.currentFolder = nextFolder;
      state.lastProcessedVisit = marker;
      await writeFile(statePath, JSON.stringify(state, null, 2));
      log(`FOLDER${nextFolder} publish complete: ${result.stdout.trim()}`);
    }
  } catch (error) {
    log(`watcher waiting: ${error.message}`);
  }

  await sleep(pollMs);
}
