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
