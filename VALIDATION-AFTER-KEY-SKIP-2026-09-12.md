# Validation after skipping publishing-key setup

September 12, 2026, approximately 21:40 UTC.

This additive record updates the connection and validation status in
`PUBLICATION-STATUS-2026-09-12.md`. It does not replace either earlier report.

## Owner direction and preservation

- The owner asked to skip the new publishing key and resume the remaining work.
- The unsaved custom-token draft was cancelled in Cloudflare. No token was
  created, and no existing token or credential was deleted or changed.
- The earlier, owner-approved GitHub app reinstall successfully restored the
  GitHub account/repository chooser in Cloudflare. GitHub reconnection is no
  longer the blocker. The Worker-specific build connection was not submitted.
- The owner clarified that DropMMSSGG has no wallet functionality.
- No existing application, media, backend, automation, DNS, Render, or visitor
  watcher configuration was edited during this validation pass.

## Fresh validation results

The tested application/build candidate remains commit `825fa8e` on
`perf/workers-static-assets`; this record is an additional documentation change.

| Check | Result |
| --- | --- |
| Automated regression run 1 | 21 passed; no failures or skips |
| Automated regression run 2 | 21 passed; no failures or skips |
| Original-file preservation | All 16 original files byte-identical to `2b67df5`; original `.gitignore` prefix retained |
| Local Workers HTTP run 1 | 46 checks passed; 8 public files; no live writes |
| Local Workers HTTP run 2 | 46 checks passed; 8 public files; no live writes |
| Deployment dry run | Passed with Wrangler 4.131.1; no bindings; no remote upload |
| Git whitespace validation | Passed |

The existing localhost preview on port 8788 was reused. Normal generated build
outputs and archived build history were refreshed by the existing build scripts;
original source files were not overwritten.

The exact LaunchAgent `uk.dropmmssgg.visitor-watcher` was checked read-only and
was running with PID 1423. No restart, service change, log inspection, or visitor
database mutation was performed. This process check does not establish a fresh
visitor count or prove an end-to-end bulletin deployment.

Fresh remote-ref inspection found:

- `main`: `2b67df51c0b82e06a8f99a02f7b54590f35f0a75`
- `perf/workers-static-assets`: `825fa8e424f49f1b448f86dbb5f1a6dfed55ecd1`

No GitHub push or live-hosting mutation was performed in this validation pass.

## Browser and performance limits

- The verification-gate layout was inspected at 1280-pixel desktop and
  390-pixel mobile widths without horizontal overflow. Local day/night query
  URLs were inspected; this is not a claim of full protected-interface testing.
- The local Cloudflare challenge reported warning `300030`. Verification was
  not completed or bypassed. Protected browser actions remain unverified;
  their isolated regression tests are not a substitute for a live end-to-end run.
- The temporary mobile viewport was reset after inspection.
- The web-perf skill requires Chrome DevTools MCP trace tools, which are not
  available. Its trace audit was not run; no Lighthouse or Core Web Vitals
  result is claimed.
- Artifact measurements remain 87,121 to 63,652 raw first-party text bytes;
  gzip 17,565 to 16,494; Brotli 14,886 to 14,169. Media and third-party resources
  are unchanged. These are payload savings, not measured faster page loading.

## Publication remains pending, not failed or completed

The uploaded Worker version recorded earlier is not a verified public cutover.
No new deployment credential was created after the owner chose to skip it.

Keep the current hosting and visitor-triggered Git publishing workflow intact.
Do not switch traffic to a one-off static upload: later bulletins would otherwise
continue updating GitHub/Render while the Worker became stale.

If the owner later resumes automatic Cloudflare publishing, resolve its approved
credential path first. Initially connect the tested release branch
`perf/workers-static-assets`, because current `main` lacks the added build
configuration. Validate a successful build, reconcile and promote to `main`
without rewriting history, switch the production build branch to `main`, and
verify another Git-triggered deployment before any public cutover. Preserve
existing redirects, integrations, and rollback hosting throughout.

Local preview: <http://127.0.0.1:8788/?theme=day>.
