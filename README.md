# Sector Message Drop

Supabase-backed message drop website.

## Message Drop

- Stores submitted entries in Supabase.
- Uses an anonymous browser/device token plus request IP hash for rate limiting.
- Limits each recognizable device/IP window to 2 entries per hour.
- Each message must be 1-26 characters with no spaces.
- Browser websites cannot read a real device MAC address.

## Supabase Setup

1. Create a Supabase project.
2. Open the Supabase SQL editor.
3. Run `supabase-schema.sql`.
4. Deploy the static site.

Messages are available in Supabase Table Editor > `drops`.
