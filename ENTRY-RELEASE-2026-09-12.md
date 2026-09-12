# Entry cleanup: published

Verified public URL: https://dropmmssgg.uk/

At 2026-09-12 22:02:59 UTC the live page returned HTTP 200 and its entire main element, stylesheet, and application script matched the released source. Last-Modified advanced to 2026-09-12 22:02:33 UTC. A subsequent browser reload visibly confirmed the simplified entry and absence of the redundant details.

## What changed

- Entry retains the brand, "Verify to enter", verification widget, and accessible status/error messages.
- Removed repeated domain, explanatory copy, verification eyebrow, and three information badges from the entry markup.
- Send button reads "Send message". Existing compact calculator keys now have descriptive accessible labels.
- No JavaScript, stylesheet, integration, bulletin/media, credential, DNS, or hosting-configuration changes were published.

## Release and preservation

- Previous production commit: `2b67df51c0b82e06a8f99a02f7b54590f35f0a75`.
- Candidate presentation commit: `c17bdf6`.
- Published main commit: `30bf1a0ce3d29863a260711322e62e410b8192d9`.
- Only `index.html` changed on main; pushed without force using the existing GitHub-to-Render connection.
- Original source remains in Git history. Pre-edit backup: `../../dropmmssgg-master-backups/20260912-entry-ZdMvPl/before-entry-cleanup-11606ee.tar.gz`.
- Backup SHA-256: `9b91de9f8c723f99186104b9ae221ff20096f043b97f2bb9840958fe70cb662c`.
- The candidate preservation check matches 15 original files byte-for-byte, preserves original ignore rules, and permits only the exact SHA-256 of this authorized entry edit. It does not ignore arbitrary index changes.

## Validation

- Final source passed 24 automated tests twice and 46 local serving checks twice.
- Regression checks confirm original application and stylesheet bytes remain identical and verification control/accessibility contracts are intact.
- Local entry verified at 1280, 390, and 320 pixels without horizontal overflow; viewport override reset.
- Public browser confirms the new entry. Protected live submission was not performed; automated behavior tests use isolated local mocks with no live writes. Turnstile does not complete in the automated browser, as previously observed, so this is not a claim of production end-to-end verification.
- Exact visitor watcher LaunchAgent was running, PID 1423, at 22:02:49 UTC. It was not restarted or modified.

## Hosting boundary

This release uses existing Render hosting behind Cloudflare and preserves future visitor-triggered bulletin updates. The separately prepared Workers Static Assets performance migration is not active. No new Cloudflare token was created, and no account permissions changed. Earlier reports remain as historical records; this document supersedes their entry-source preservation count and public-release status for this presentation change only.
