import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import postcss from 'postcss';
import { minify } from 'terser';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const byteCounts = (value) => ({ bytes: Buffer.byteLength(value), gzip: gzipSync(value).length, brotli: brotliCompressSync(value).length });
const mediaExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.pdf', '.ico', '.woff', '.woff2', '.mp3', '.mp4', '.webm', '.ogg']);

export function assertPublicText(text, label) {
  // Fail without printing matched content. Publishable/anon keys already used by
  // the public frontend are not secrets; privileged credentials must never ship.
  const forbidden = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bsb_secret_[A-Za-z0-9_-]+/,
    /\b(?:ghp_|github_pat_|sk_live_)[A-Za-z0-9_]+/,
    /\b(?:private_key|privateKey|mnemonic|seed_phrase|service_role_key)\s*[:=]\s*["'][^"']+["']/i,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) throw new Error(`Credential-shaped content rejected in ${label}; values suppressed`);
  for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try {
      if (JSON.parse(Buffer.from(match[1], 'base64url').toString()).role === 'service_role') {
        throw new Error(`Privileged JWT rejected in ${label}; value suppressed`);
      }
    } catch (error) {
      if (error.message.startsWith('Privileged JWT')) throw error;
    }
  }
}

export async function optimizeDocument(source) {
  assertPublicText(source, 'index.html');
  const styles = [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (styles.length !== 1 || scripts.length !== 1) {
    throw new Error('Expected exactly one inline stylesheet and one classic application script; review source changes before building');
  }
  const css = styles[0][1];
  if (/\burl\s*\(|@import\b/i.test(css)) {
    throw new Error('Stylesheet now contains relative resource dependencies; extraction requires review');
  }
  const parsedCss = postcss.parse(css);
  parsedCss.raws.after = '';
  parsedCss.walk((node) => {
    node.raws.before = '';
    if (node.type === 'decl') node.raws.between = ':';
    if (node.type === 'rule' || node.type === 'atrule') {
      node.raws.between = '';
      node.raws.after = '';
    }
  });
  const minifiedCss = parsedCss.toString();
  const app = scripts[0][1];
  const result = await minify(app, {
    compress: false,
    mangle: false,
    format: { comments: 'all', ascii_only: false, ecma: 2022 },
  });
  if (!result.code) throw new Error('Application script minification produced no output');
  const cssPath = `_static/site.${hash(minifiedCss).slice(0, 16)}.css`;
  const appPath = `_static/app.${hash(result.code).slice(0, 16)}.js`;
  // Do not add async/defer: callback registration must still precede Turnstile.
  const html = source
    .replace(styles[0][0], `<link rel="stylesheet" href="/${cssPath}">`)
    .replace(scripts[0][0], `<script src="/${appPath}"></script>`);
  return {
    html,
    generated: new Map([[cssPath, minifiedCss], [appPath, result.code]]),
    measurements: {
      before: { html: byteCounts(source), css: byteCounts(css), application: byteCounts(app) },
      after: { html: byteCounts(html), css: byteCounts(minifiedCss), application: byteCounts(result.code) },
    },
  };
}

export async function collectPublicAssets(root) {
  const result = [];
  const walk = async (relative) => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink rejected in public assets: ${file}`);
      if (entry.name.startsWith('.')) throw new Error(`Hidden file rejected in public assets: ${file}`);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !mediaExtensions.has(path.extname(entry.name).toLowerCase())) {
        throw new Error(`Non-media file rejected in public assets: ${file}`);
      }
      const info = await lstat(path.join(root, file));
      if (info.size > 25 * 1024 * 1024) throw new Error(`Asset exceeds the Workers per-file limit: ${file}`);
      if (path.extname(file).toLowerCase() === '.svg') assertPublicText(await readFile(path.join(root, file), 'utf8'), file);
      result.push(file);
    }
  };
  const assetsInfo = await lstat(path.join(root, 'assets'));
  if (!assetsInfo.isDirectory() || assetsInfo.isSymbolicLink()) throw new Error('assets must be a real local directory');
  await walk('assets');
  return result;
}

async function buildUnlocked(root) {
  // Only public HTML, robots and allowlisted media enter dist. Source SQL,
  // automation, docs, Git history, environment files and manifests never do.
  const source = await readFile(path.join(root, 'index.html'), 'utf8');
  const robots = await readFile(path.join(root, 'robots.txt'), 'utf8');
  assertPublicText(robots, 'robots.txt');
  const optimized = await optimizeDocument(source);
  const media = await collectPublicAssets(root);
  const stage = await mkdtemp(path.join(root, '.build-'));
  await mkdir(path.join(stage, '_static'));
  await writeFile(path.join(stage, 'index.html'), optimized.html, { flag: 'wx' });
  await writeFile(path.join(stage, 'robots.txt'), robots, { flag: 'wx' });
  for (const [file, content] of optimized.generated) await writeFile(path.join(stage, file), content, { flag: 'wx' });
  for (const file of media) {
    await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(stage, file), constants.COPYFILE_EXCL);
  }
  // Existing media filenames can be reused by the publisher. Only content-hashed
  // compiled CSS/JS get immutable caching. Everything else revalidates by default.
  await writeFile(path.join(stage, '_headers'), '/_static/*\n  Cache-Control: public, max-age=31536000, immutable\n', { flag: 'wx' });
  await writeFile(path.join(stage, '.assetsignore'), '**/*.map\n**/.env*\n**/.dev.vars*\n**/.git/**\n', { flag: 'wx' });
  const output = path.join(root, 'dist');
  const history = path.join(root, '.performance', 'build-history');
  await mkdir(history, { recursive: true });
  try {
    const previous = await lstat(output);
    if (!previous.isDirectory() || previous.isSymbolicLink()) throw new Error('Refusing to replace a non-directory dist path');
    // Keep previous generated builds recoverable; never overwrite source files.
    await rename(output, path.join(history, path.basename(stage)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rename(stage, output);
  const report = {
    checkedAt: new Date().toISOString(),
    sourceSha256: hash(source),
    files: ['index.html', 'robots.txt', ...optimized.generated.keys(), ...media],
    generated: [...optimized.generated.keys()],
    measurements: optimized.measurements,
    note: 'Byte counts are local artifact measurements, not Core Web Vitals or network timing.',
  };
  await writeFile(path.join(root, '.performance', 'last-build.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

export async function build(root = projectRoot) {
  await mkdir(path.join(root, '.performance'), { recursive: true });
  const lockPath = path.join(root, '.performance', 'build.lock');
  const deadline = Date.now() + 15000;
  let lock;
  while (!lock) {
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Another build holds .performance/build.lock; wait for it to finish before retrying');
      await delay(50);
    }
  }
  try { return await buildUnlocked(root); }
  finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await build();
  console.log(JSON.stringify({ publicFiles: report.files.length, ...report.measurements, report: '.performance/last-build.json' }, null, 2));
}
