# DropMMSSGG targeted performance build

Prepared September 12, 2026. This is a version-controlled candidate, not a live
deployment. No DNS, Render settings, GitHub publishing, Supabase configuration,
visitor watcher, wallet data, credentials, content, or application logic changed.

## Baseline and preservation

The live-matching baseline is commit
`2b67df51c0b82e06a8f99a02f7b54590f35f0a75`, from the clean `rotation-runtime`
worktree. This candidate is the separate branch `perf/workers-static-assets`.
The earlier recovery `source/` and redesigned `golden-build/` were not used as the
application baseline.

All 16 original application, asset, automation, backend and documentation files
remain byte-for-byte unchanged. The original `.gitignore` was preserved and
extended with generated-file exclusions. New build scripts, tests, package files
and Workers configuration are additive. The original commit remains in Git.

`npm run check:preservation` verifies this baseline. It is a one-time release
preservation check, not a check to run forever after intentional bulletin edits.

## Targeted changes

- The build extracts the existing inline stylesheet and classic application script
  into content-hashed files. The source HTML remains untouched for the publisher.
- CSS formatting whitespace is reduced without changing selectors, declaration
  values, ordering or comments. JavaScript formatting is reduced without variable
  renaming or code compression; strict syntax-tree parity is tested.
- The original HTML outside those two extraction tags remains exactly identical.
  Supabase's pinned SDK still runs first, followed by the classic application,
  followed by the original asynchronous Turnstile tag. No async/defer race is added.
- Content-hashed CSS/JS receive immutable caching. HTML and existing media keep
  Workers' default revalidation policy, preserving current bulletin freshness and
  the publisher's query-string cache busting.
- A public-file allowlist keeps SQL, automation, Git files, environment files,
  reports and dependencies out of the deployment. Generated builds are archived
  locally under `.performance/build-history/`; original files are never replaced.
- Overlapping local builds serialize through a lock, avoiding the output-directory
  race found and fixed during preview testing.

The Inter font, colors, greeting GIF, bulletin media/text/links, typing sound and
caret, terminal effects, visible calculator, message rules, mission reply behavior,
verification gate, two-hour session, live count and visitor tracking are retained.

## Measured artifact sizes

These are bytes measured locally, not network timings or Core Web Vitals. Media
and third-party dependencies are unchanged and are not included in this table.

| First-party text | Original | Optimized |
| --- | ---: | ---: |
| HTML | 87,121 | 7,692 |
| Separate CSS | included above | 31,764 |
| Separate application JS | included above | 24,196 |
| Combined raw bytes | 87,121 | 63,652 |
| Combined gzip bytes | 17,565 | 16,494 |
| Combined Brotli bytes | 14,886 | 14,169 |

Raw first-party text is 26.9% smaller; compressed savings are about 6.1% gzip or
4.8% Brotli. The HTML document itself is 91.2% smaller, while the extracted CSS/JS
can be reused from browser cache. There are two extra first-load requests; do not
interpret byte savings as a measured improvement in first-paint latency.

## Verification

- 21 automated tests pass: exact HTML preservation, strict JavaScript and CSS
  semantic parity, comments, media bytes, asset hashes, publisher image/PDF/empty
  fixtures, ordering, gate, message limit/keyboard behavior, calculator, public
  output restrictions, secret-shape rejection and concurrent builds.
- 46 HTTP checks pass against local Workers: all eight public files, cache headers,
  ETags and 304s, root page, HEAD, query strings, missing routes and private-file
  404s. Workers canonicalizes `/index.html` to `/` with a 307; confirm this behavior
  against the existing origin's routing during migration review.
- Wrangler 4.131.1 dry-run and type generation pass. No remote upload occurred.
- npm dependency audit reported zero vulnerabilities at installation.
- Browser inspection confirmed the retained verification screen and matching
  390-pixel mobile layout with no horizontal overflow. Browser verification could
  not finish because the external challenge did not load in the local preview;
  the unchanged source had the same limitation. Protected interactions were tested
  in isolated VM tests, not claimed as a complete live end-to-end browser pass.
- The web-perf skill could not run its Chrome DevTools trace because that MCP tool
  is unavailable. No Lighthouse score, LCP, INP or CLS result is claimed.

## Current hosting and compatibility

The website is plain HTML/CSS/JavaScript with Supabase Edge Functions, database and
Realtime, plus Cloudflare Turnstile. Cloudflare proxying is visible live. Render is
recorded as the origin host in `DOMAIN-MIGRATION.md`; its account settings were not
independently accessible during this audit.

The running macOS LaunchAgent is `uk.dropmmssgg.visitor-watcher` (PID 1423 at the
initial check), using Node.js and the existing `rotation-runtime` checkout. It
detects a verified visit, generates the next bulletin, commits `index.html` and
`assets/`, and pushes GitHub `username1122334455-coder/sector-message-drop`, branch
`main`. That workflow was not stopped, replaced or edited.

Workers Static Assets is compatible with the public frontend. No Worker handler,
new API, database migration or secret is needed. Current Cloudflare guidance
supports [static-only Workers without a script](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
The configured directory is `dist`, never the repository root. See the current
[Static Assets documentation](https://developers.cloudflare.com/workers/static-assets/)
and [cache/header behavior](https://developers.cloudflare.com/workers/static-assets/headers/).

## Local commands

```sh
npm ci
npm test
npm run check:preservation
npm run check:deploy
npm run preview
# In another terminal, while preview is running:
npm run test:http
# Optional unchanged-source comparison on port 8789:
npm run preview:baseline
```

Wrangler's custom build command runs `npm run build` for previews and deployment.
The preview binds only to localhost port 8788. Never use `file://` to test this
source: its local-preview safeguards are keyed to localhost hostnames.

## Live promotion remains a separate decision

Do not copy `dist` into the active runtime or switch DNS after a one-off deploy.
Without a Git-connected build pipeline, future visitor-triggered bulletins would
continue updating GitHub/Render but not the new Worker.

After the owner approves live publication and host migration:

1. Confirm the latest live branch has no new functional changes; merge this
   additive branch without force-pushing or rewriting bulletin history.
2. Inspect and preserve Render's existing redirects/headers/custom domains and
   Cloudflare rules. Keep Render available for rollback.
3. Connect Workers Builds to the same GitHub repository and `main` branch. Keep
   access scoped to that repository; the owner must approve any new permissions.
   Use `npm ci && npm test` as build validation and `npx wrangler deploy` as deploy;
   Wrangler also runs the configured build before serving/uploading assets.
   See [Workers Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/).
4. Verify a Git push produces a new successful Workers deployment before moving
   traffic. Keep the publisher's markup, file paths and branch contract intact.
5. Attach the existing approved domain(s) only after checking Turnstile hostnames,
   Supabase origin checks, CSP/Cloudflare settings and routing parity. The current
   config intentionally declares no DNS routes and disables workers.dev previews.
6. Test a real verification, message, calculator save, live count, and subsequent
   visitor-triggered bulletin deployment. Label test traffic. Completing a browser
   CAPTCHA requires fresh user confirmation; do not bypass it.
7. If validation fails, keep or restore traffic to the preserved Render origin;
   do not revert wallet/backend data or use a destructive Git reset.

The current candidate has not been pushed, connected to Workers Builds, uploaded,
or assigned to any live domain.
