# Sector Message Drop

Anonymous Supabase-backed message drop website.

## What it does

- Stores messages in Supabase instead of browser-only local storage.
- Allows anonymous users to send messages without accounts.
- Limits each anonymous browser/device token to 2 drops per active Mountain-time window.
- Limits each IP address to 1 drop per active Mountain-time window.
- Accepts drops only during 10am-2pm, 2pm-6pm, and 6pm-10pm Mountain Time; drops are blocked from 10pm until 10am.
- After a successful drop, the page shows the remaining device count and the Mountain-time window end.
- Each message must be 1-15 characters with no spaces.

Browser websites cannot read a real device MAC address, so the app uses an anonymous browser/device token plus the request IP hash for rate limiting.

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

Only the message, hashed anonymous browser token, hashed IP, and timestamp are stored.
