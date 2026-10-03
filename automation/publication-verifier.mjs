import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const failure = (code) => Object.assign(new Error(`Publication verification failed (${code}); response content suppressed`), { code });
const section = (html, pattern) => {
  const matches = [...html.matchAll(pattern)];
  if (matches.length !== 1) throw failure("INVALID_BULLETIN_STRUCTURE");
  return matches[0][0];
};
const galleryPattern = /<!-- BULLETIN_MEDIA_START -->[\s\S]*?<!-- BULLETIN_MEDIA_END -->/g;
const messagePattern = /<p class="bulletin-board__message">[\s\S]*?<\/p>/g;

async function expectedPublication(projectRoot) {
  const html = await readFile(path.join(projectRoot, "index.html"), "utf8");
  const gallery = section(html, galleryPattern);
  const message = section(html, messagePattern);
  const assetsPath = path.join(projectRoot, "assets");
  const assetsInfo = await lstat(assetsPath);
  if (!assetsInfo.isDirectory() || assetsInfo.isSymbolicLink()) throw failure("INVALID_LOCAL_MEDIA");
  const assetsRoot = await realpath(assetsPath);
  const references = [...gallery.matchAll(/\b(?:src|data)=["']([^"']+)["']/g)].map((match) => match[1]);
  const assets = [];
  for (const reference of new Set(references)) {
    if (!/^assets\/[^#]+$/.test(reference)) throw failure("INVALID_MEDIA_REFERENCE");
    const url = new URL(reference, "https://expected.invalid/");
    if (!url.pathname.startsWith("/assets/")) throw failure("INVALID_MEDIA_REFERENCE");
    const relative = decodeURIComponent(url.pathname).slice("/assets/".length);
    if (!relative || relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) throw failure("INVALID_MEDIA_REFERENCE");
    const filename = path.join(assetsRoot, relative);
    const resolved = await realpath(filename);
    const info = await lstat(filename);
    if (!resolved.startsWith(assetsRoot + path.sep) || info.isSymbolicLink() || !info.isFile() || info.size > 25 * 1024 * 1024) {
      throw failure("INVALID_LOCAL_MEDIA");
    }
    assets.push({ reference, bytes: await readFile(filename) });
  }
  const digest = createHash("sha256").update(gallery).update(message);
  for (const asset of assets) digest.update(asset.reference).update(asset.bytes);
  return { gallery, message, assets, digest: digest.digest("hex") };
}

async function readResponse(url, { signal, timeoutMs, maxBytes }) {
  const response = await fetch(url, {
    redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))]),
    headers: { "Cache-Control": "no-cache, no-store", "Pragma": "no-cache" },
  });
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw failure("HTTP_NOT_READY"); }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { await reader.cancel(); throw failure("RESPONSE_LIMIT"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

// A GET only retrieves static bytes; this never executes JS, submits a visit,
// answers Turnstile, or contacts a link contained in the bulletin message.
export async function verifyPublication({
  projectRoot, baseUrl = "https://dropmmssgg.uk/", timeoutMs = 180000,
  pollMs = 5000, requestTimeoutMs = 10000, signal,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180000 || !Number.isFinite(pollMs) || pollMs < 1 || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw failure("INVALID_LIMIT");
  let base;
  try { base = new URL(baseUrl); }
  catch { throw failure("INVALID_PUBLIC_URL"); }
  if (base.username || base.password || !(base.protocol === "https:" || (base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))) throw failure("INVALID_PUBLIC_URL");
  if (signal?.aborted) throw failure("ABORTED");
  let expected;
  try { expected = await expectedPublication(projectRoot); }
  catch { throw failure("INVALID_LOCAL_PUBLICATION"); }
  const end = Date.now() + timeoutMs;
  const deadline = AbortSignal.timeout(Math.ceil(timeoutMs));
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let attempts = 0;
  while (Date.now() < end && !combined.aborted) {
    attempts += 1;
    try {
      const url = new URL(base);
      url.searchParams.set("_publication_check", `${expected.digest.slice(0, 16)}-${attempts}-${Date.now()}`);
      const live = (await readResponse(url, { signal: combined, timeoutMs: Math.min(requestTimeoutMs, end - Date.now()), maxBytes: 2 * 1024 * 1024 })).toString("utf8");
      if (section(live, galleryPattern) !== expected.gallery || section(live, messagePattern) !== expected.message) throw failure("CONTENT_NOT_READY");
      for (const asset of expected.assets) {
        // Keep the publisher's existing media version query; it is part of the
        // public page contract and prevents stale reused-filename responses.
        const mediaUrl = new URL(asset.reference, base);
        if (mediaUrl.origin !== base.origin) throw failure("INVALID_MEDIA_REFERENCE");
        const bytes = await readResponse(mediaUrl, { signal: combined, timeoutMs: Math.min(requestTimeoutMs, end - Date.now()), maxBytes: asset.bytes.length + 1 });
        if (!bytes.equals(asset.bytes)) throw failure("MEDIA_NOT_READY");
      }
      return { ok: true, checkedAt: new Date().toISOString(), attempts, mediaCount: expected.assets.length, sourceDigest: expected.digest };
    } catch {
      if (signal?.aborted) throw failure("ABORTED");
      if (Date.now() >= end || combined.aborted) break;
      try { await delay(Math.min(pollMs, end - Date.now()), undefined, { signal: combined }); }
      catch { break; }
    }
  }
  throw failure(signal?.aborted ? "ABORTED" : "PUBLICATION_TIMEOUT");
}
