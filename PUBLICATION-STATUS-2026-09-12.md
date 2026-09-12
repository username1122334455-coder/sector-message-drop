# Publication status — September 12, 2026

The owner approved publication. This record supersedes the publication-status
statements in `PERFORMANCE-RELEASE.md`; its preservation and test results still
apply.

## Completed

- Refetched GitHub `main`: it matches the preserved baseline `2b67df5`.
- Rechecked the candidate: 21 tests passed, all 16 original files preserved,
  clean tracked worktree and no whitespace errors.
- Pushed release commit `8e7125f` to GitHub branch
  `perf/workers-static-assets` in `username1122334455-coder/sector-message-drop`.
- Uploaded all eight allowlisted public files to Cloudflare Worker
  `dropmmssgg-static` using the existing authenticated publishing tool.
- Cloudflare confirmed version `11793d09-e859-46e9-960f-d2c72ee8ebbb`, with no
  public routes, workers.dev URL, or preview URL enabled.
- Existing source archives and their verified checksums remain available in
  the master-backups directory documented in the task.

## Not live yet

No changes were made to GitHub `main`, Render, DNS records, domain routing,
Supabase, visitor-watcher configuration, wallet data, or private keys. The
running visitor watcher was left running.

Both existing proxied CNAME records (`dropmmssgg.uk` and `www.dropmmssgg.uk`)
still point to `sector-message-drop.onrender.com`. Live checks found apex `/`
and `/index.html` returning 200, unknown paths returning 404, and `www`
redirecting to the apex with 301 while preserving the path.

The current Workers default canonicalizes `/index.html` to `/` with 307.
Both addresses still reach the same preserved page; this routing difference
must remain documented during the eventual live checks.

## Blocking connection

Cloudflare's dashboard GitHub connection returned to the installed GitHub
application's settings instead of offering the repository chooser. The GitHub
application is shown as installed. No installation permissions were edited.

The existing Wrangler authentication successfully uploads the Worker and reads
its metadata, but a read-only request to the Workers Builds token-list endpoint
returned HTTP 403 (authentication error). No new token was created or persisted,
and no credentials were displayed in the task.

The owner needs to complete the GitHub connection for this Worker in
Cloudflare Settings > Builds, selecting only this repository for the project,
and authorize its build/deployment credential if prompted. Do not paste tokens
or private keys into chat.

## Resume checklist

1. Verify the repository connection and production branch `main`.
2. Configure validation `npm ci && npm test` and deployment
   `npx wrangler deploy --no-autoconfig`. Do not add backend secrets.
3. Refetch `main` and safely merge the additive release without force-pushing or
   rewriting any visitor-generated bulletin commits.
4. Verify a Git push results in a successful new Workers deployment before
   moving public traffic. Keep Render and the original DNS settings for rollback.
5. Preserve the current `www` redirect, origin restrictions, and integration
   configuration. Attach only the existing approved domain(s).
6. Verify public assets, caching, private-file 404s and the browser behavior.
   Complete real Turnstile interaction only with fresh owner confirmation.
7. Confirm a subsequent visitor-generated bulletin reaches Workers through Git.

A one-off upload is not sufficient: switching traffic before the Git connection
works would leave future automatic bulletin changes on GitHub/Render only.
