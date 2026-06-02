# Sector Message Drop

Supabase-backed message drop website.

## Message Drop

- Stores submitted entries in Supabase.
- Uses an anonymous browser/device token plus request IP hash for storage metadata.
- Does not limit message attempts.
- Captures submitted text, then shows the password-required prompt on the page.
- Stored entries must be 1-500 characters.
- Browser websites cannot read a real device MAC address.

## Supabase Setup

1. Create a Supabase project.
2. Open the Supabase SQL editor.
3. Run `supabase-schema.sql`.
4. Deploy the static site.

Messages are available in Supabase Table Editor > `drops`.

Private message link clicks are tracked in Supabase Table Editor > `visits`
with `path` set to `click:private-msg`.

`CLICK HERE` records click data in Supabase and stays on the page. The file
upload portal code is kept separate from that link.

If PDF upload returns `MIME type application/pdf is not supported`, run
`supabase-storage-upload-fix.sql` in the Supabase SQL Editor.

If message submissions return `DROP CHANNEL OFFLINE`, run
`supabase-submit-drop-fix.sql` in the Supabase SQL Editor.
