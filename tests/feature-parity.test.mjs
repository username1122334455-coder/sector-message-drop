import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, lstat } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import postcss from "postcss";
import { optimizeDocument } from "../scripts/build-static.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = await readFile(path.join(root, "index.html"), "utf8");
const built = await readFile(path.join(root, "dist/index.html"), "utf8");
const styleMatches = [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)];
const scriptMatches = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(styleMatches.length, 1, "baseline must contain one inline stylesheet");
assert.equal(scriptMatches.length, 1, "baseline must contain one inline classic application script");
const styleTag = styleMatches[0][0];
const scriptTag = scriptMatches[0][0];
const sourceCSS = styleMatches[0][1];
const sourceJS = scriptMatches[0][1];
const cssTags = [...built.matchAll(/<link rel="stylesheet" href="(\/_static\/site\.[0-9a-f]{16}\.css)">/g)];
const jsTags = [...built.matchAll(/<script src="(\/_static\/app\.[0-9a-f]{16}\.js)"><\/script>/g)];
assert.equal(cssTags.length, 1, "build must reference one content-versioned stylesheet");
assert.equal(jsTags.length, 1, "build must reference one content-versioned classic application script");
const builtCSS = await readFile(path.join(root, "dist", cssTags[0][1]), "utf8");
const builtJS = await readFile(path.join(root, "dist", jsTags[0][1]), "utf8");

// Compare boolean results, not entire trees: source literals must never be dumped
// into assertion diagnostics. Whitespace/location-only fields are excluded.
const canonical = (value, excluded) => {
  if (Array.isArray(value)) return value.map((item) => canonical(item, excluded));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !excluded.has(key))
      .map(([key, item]) => [key, canonical(item, excluded)]));
  }
  return value;
};
const semanticJS = (code) => canonical(
  parse(code, { ecmaVersion: "latest", sourceType: "script" }),
  new Set(["start", "end", "loc", "range", "raw"]),
);
const semanticCSS = (code) => canonical(
  postcss.parse(code).toJSON(), new Set(["source", "raws", "inputs"]),
);

test("HTML content, branding, attributes, and integrations change only at the two extraction tags", () => {
  const restored = built.replace(cssTags[0][0], () => styleTag)
    .replace(jsTags[0][0], () => scriptTag);
  assert.ok(restored === source, "built HTML has changes beyond stylesheet/script extraction");
});

test("CSS selectors, declarations, values, order, and comments retain their semantic AST", () => {
  assert.ok(JSON.stringify(semanticCSS(sourceCSS)) === JSON.stringify(semanticCSS(builtCSS)),
    "CSS semantic AST changed; whitespace-only packaging was expected");
});

test("classic JavaScript retains its complete semantic AST without compression or renaming", () => {
  assert.ok(JSON.stringify(semanticJS(sourceJS)) === JSON.stringify(semanticJS(builtJS)),
    "JavaScript semantic AST changed; formatting-only packaging was expected");
});

test("application comments remain intact during formatting", () => {
  const comments = (code) => {
    const result = [];
    parse(code, { ecmaVersion: "latest", sourceType: "script", onComment: result });
    return result.map(({ type, value }) => ({ type, value }));
  };
  assert.ok(JSON.stringify(comments(sourceJS)) === JSON.stringify(comments(builtJS)),
    "application comment text or ordering changed");
});

const bulletinPattern = /<!-- BULLETIN_MEDIA_START -->[\s\S]*?<!-- BULLETIN_MEDIA_END -->/;
for (const [label, gallery] of [
  ["mixed image and PDF slideshow", `<!-- BULLETIN_MEDIA_START -->
          <div class="bulletin-board__media" data-bulletin-gallery>
            <img class="bulletin-board__photo is-active" src="assets/bulletin-photo-1.jpg?v=fixture-image" alt="Bulletin portrait 1 of 2" />
            <object class="bulletin-board__photo" data="assets/bulletin-photo-2.pdf?v=fixture-pdf" type="application/pdf" aria-label="Bulletin PDF 2 of 2" aria-hidden="true"></object>
            <div class="bulletin-board__controls" aria-label="Bulletin photos">
              <button class="bulletin-board__nav" type="button" data-bulletin-prev aria-label="Previous photo">‹</button>
              <span class="bulletin-board__counter" data-bulletin-counter>1 / 2</span>
              <button class="bulletin-board__nav" type="button" data-bulletin-next aria-label="Next photo">›</button>
            </div>
          </div>
          <!-- BULLETIN_MEDIA_END -->`],
  ["empty bulletin media", `<!-- BULLETIN_MEDIA_START -->
          <div class="bulletin-board__media" data-bulletin-gallery></div>
          <!-- BULLETIN_MEDIA_END -->`],
]) {
  test(`publisher fixture: ${label} keeps exact markup and cache-busting references`, async () => {
    assert.ok(bulletinPattern.test(source), "publisher replacement markers missing from baseline");
    const fixture = source.replace(bulletinPattern, () => gallery);
    const optimized = await optimizeDocument(fixture);
    const restored = optimized.html
      .replace(/<link rel="stylesheet" href="\/_static\/site\.[0-9a-f]{16}\.css">/, () => styleTag)
      .replace(/<script src="\/_static\/app\.[0-9a-f]{16}\.js"><\/script>/, () => scriptTag);
    assert.ok(restored === fixture, "publisher fixture markup changed beyond the two extraction tags");
    assert.ok(optimized.html.includes(gallery), "publisher media markup was not preserved exactly");
  });
}

test("versioned asset names match their content", () => {
  for (const [reference, contents] of [[cssTags[0][1], builtCSS], [jsTags[0][1], builtJS]]) {
    const digest = createHash("sha256").update(contents).digest("hex").slice(0, 16);
    assert.ok(reference.includes(`.${digest}.`), "generated asset name does not match its content hash");
  }
});

test("Supabase, the classic application, and Turnstile keep their execution order", () => {
  const scripts = [...built.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((match) => match[0]);
  assert.equal(scripts.length, 3, "unexpected executable script count");
  assert.ok(scripts[0].includes("@supabase/supabase-js@2.45.4"), "pinned Supabase SDK must load first");
  assert.ok(!/\b(?:async|defer)(?:\s|=|>)/.test(scripts[0]), "SDK scheduling changed");
  assert.ok(scripts[1] === jsTags[0][0], "application must remain the second classic blocking script");
  assert.ok(scripts[2].includes("challenges.cloudflare.com/turnstile/v0/api.js"), "Turnstile must load last");
  assert.ok(scripts[2].includes("onload=onTurnstileLoaded"), "Turnstile callback contract changed");
  assert.ok(scripts[2].includes(" async defer>"), "Turnstile scheduling changed");
});

async function filesUnder(directory, relative = "") {
  const result = [];
  for (const name of await readdir(path.join(directory, relative))) {
    const item = path.join(relative, name);
    const info = await lstat(path.join(directory, item));
    assert.ok(!info.isSymbolicLink(), "public asset trees must not contain symlinks");
    if (info.isDirectory()) result.push(...await filesUnder(directory, item));
    else {
      assert.ok(info.isFile(), "public asset trees must contain only regular files");
      result.push(item);
    }
  }
  return result.sort();
}

test("existing images, greeting, favicon, and documents retain their exact bytes", async () => {
  const originalFiles = await filesUnder(path.join(root, "assets"));
  const outputFiles = await filesUnder(path.join(root, "dist/assets"));
  assert.ok(JSON.stringify(originalFiles) === JSON.stringify(outputFiles), "public asset inventory changed");
  for (const relative of originalFiles) {
    const [before, after] = await Promise.all([
      readFile(path.join(root, "assets", relative)),
      readFile(path.join(root, "dist/assets", relative)),
    ]);
    assert.ok(before.equals(after), "an original public asset changed bytes");
  }
});

function makeElement() {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  return {
    value: "", textContent: "", dataset: {}, disabled: false,
    scrollHeight: 40, offsetWidth: 400, selectionStart: 0, selectionEnd: 0,
    style: { setProperty() {} },
    classList: {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); },
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name),
    toggleAttribute(name, on) { if (on) attributes.set(name, ""); else attributes.delete(name); },
    hasAttribute: (name) => attributes.has(name),
    getBoundingClientRect: () => ({ width: 400, height: 300, top: 0, left: 0 }),
    addEventListener(name, listener) {
      listeners.set(name, [...(listeners.get(name) || []), listener]);
    },
    async dispatch(name, event = {}) {
      let prevented = false;
      for (const listener of listeners.get(name) || []) {
        await listener({ preventDefault() { prevented = true; }, ...event });
      }
      return prevented;
    },
  };
}

function makeStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

function boot(code) {
  const elements = new Map();
  const widgets = [];
  let networkCalls = 0;
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, makeElement());
    return elements.get(selector);
  };
  const context = createContext({
    console: { error() {}, warn() {}, log() {} }, crypto: webcrypto, URLSearchParams,
    localStorage: makeStorage(), sessionStorage: makeStorage(),
    navigator: { userAgent: "isolated-parity-test", platform: "test" },
    document: { body: makeElement(), referrer: "", querySelector: get, querySelectorAll: () => [] },
    getComputedStyle: () => ({ fontSize: "16", paddingLeft: "12" }),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: (callback) => callback(),
    window: {
      location: new URL("http://127.0.0.1:8788/?theme=day"), screen: { width: 390, height: 844 },
      matchMedia: () => ({ matches: true }), addEventListener() {},
      turnstile: { render(_target, options) { widgets.push(options); return "test-widget"; }, remove() {} },
      supabase: { createClient: () => ({
        functions: { async invoke() { networkCalls += 1; throw new Error("unexpected live-path invocation"); } },
        rpc() { networkCalls += 1; throw new Error("unexpected live-path invocation"); },
        channel() { networkCalls += 1; throw new Error("unexpected live-path invocation"); },
      }) },
    },
  });
  runInContext(code, context, { timeout: 2_000 });
  return { get, context, widgets, get networkCalls() { return networkCalls; },
    verify() { widgets[0].callback("isolated-test-verification"); } };
}

for (const [label, code] of [["baseline", sourceJS], ["packaged", builtJS]]) {
  test(`${label}: verification gate protects the same controls and local verification makes no live writes`, async () => {
    const page = boot(code);
    assert.equal(page.widgets.length, 1);
    assert.ok(page.get(".mission-grid").hasAttribute("inert"));
    assert.equal(page.get("#messageInput").disabled, true);
    assert.equal(page.get("#sendButton").disabled, true);
    await page.get("#messageForm").dispatch("submit");
    assert.equal(page.get("#feedback").textContent, "Complete verification first.");
    page.verify();
    assert.ok(!page.get(".mission-grid").hasAttribute("inert"));
    assert.equal(page.get("#messageInput").disabled, false);
    assert.equal(page.get("#sendButton").disabled, false);
    assert.equal(page.networkCalls, 0);
  });

  test(`${label}: current message limit, counter, and Enter behavior remain unchanged`, async () => {
    const page = boot(code);
    page.verify();
    page.get("#messageInput").value = "x".repeat(501);
    await page.get("#messageInput").dispatch("input");
    assert.equal(page.get("#messageInput").value.length, 500);
    assert.equal(page.get("#messageCount").textContent, "500 / 500");
    assert.equal(page.get("#messageCount").dataset.nearLimit, "true");
    assert.equal(await page.get("#messageInput").dispatch("keydown", { key: "Enter" }), true);
    page.get("#messageInput").value = "";
    await page.get("#messageForm").dispatch("submit");
    assert.equal(page.get("#feedback").textContent, "Enter a message.");
    assert.equal(page.networkCalls, 0);
  });

  test(`${label}: calculator verification, precedence, decimal math, clear, and delete work locally`, async () => {
    const page = boot(code);
    page.get("#keypadDisplay").dataset.expression = "7+8";
    await page.get("#keypadSubmit").dispatch("click");
    assert.equal(page.get("#keypadStatus").textContent, "Complete verification first.");
    page.verify();
    for (const [expression, expected] of [["7+8", "15"], ["2+3*4", "14"], ["(2+3)*4", "20"], ["0.5+0.25", "0.75"]]) {
      page.get("#keypadDisplay").dataset.expression = expression;
      await page.get("#keypadSubmit").dispatch("click");
      assert.equal(page.get("#keypadStatus").textContent, `= ${expected}`);
    }
    page.get("#keypadDisplay").dataset.expression = "8/0";
    await page.get("#keypadSubmit").dispatch("click");
    assert.ok(page.get("#keypadStatus").textContent.length > 0, "invalid math must report feedback");
    await page.get("#keypadClear").dispatch("click");
    assert.equal(page.get("#keypadDisplay").dataset.expression, "");
    page.get("#keypadDisplay").dataset.expression = "123";
    await page.get("#keypadDelete").dispatch("click");
    assert.equal(page.get("#keypadDisplay").dataset.expression, "12");
    assert.equal(page.networkCalls, 0);
  });
}
