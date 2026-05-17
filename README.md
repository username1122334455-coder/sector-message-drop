# Sector Message Drop

Anonymous Supabase-backed message drop website.

## What it does

- Stores messages in Supabase instead of browser-only local storage.
- Allows anonymous users to send messages without accounts.
- Limits each browser token to 2 drops per hour.
- Limits the whole site to 20 total drops per hour.
- Each message must be 1-15 characters with no spaces.

## Supabase setup

1. Create a Supabase project.
2. Open the Supabase SQL editor.
3. Run `supabase-schema.sql`.
4. In `index.html`, replace:
   - `PASTE_YOUR_SUPABASE_URL_HERE`
   - `PASTE_YOUR_SUPABASE_PUBLISHABLE_KEY_HERE`
5. Deploy or open the page.

## Checking messages

Open Supabase, then go to Table Editor > `drops`.

Only the message, hashed anonymous browser token, and timestamp are stored.
