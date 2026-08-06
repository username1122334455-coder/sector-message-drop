# Bot Verification Setup

This project uses Cloudflare Turnstile on the page and a Supabase Edge Function for server-side verification. A successful gate check creates a short-lived, server-signed session so the visitor can use the message form without repeating the CAPTCHA after every submission.

## 1. Create a Turnstile widget

1. Open Cloudflare Dashboard.
2. Go to **Turnstile**.
3. Create a widget for the live hostname.
4. Copy the **site key** and **secret key**.

## 2. Add the site key to the website

In `index.html`, replace:

```js
const TURNSTILE_SITE_KEY = "PASTE_CLOUDFLARE_TURNSTILE_SITE_KEY_HERE";
```

with your real Cloudflare Turnstile site key.

## 3. Deploy the verified submit Edge Function

From this project folder:

```sh
supabase link --project-ref hrsrjfpygekjyuwibsia
supabase secrets set TURNSTILE_SECRET_KEY="YOUR_TURNSTILE_SECRET_KEY"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="YOUR_SUPABASE_SERVICE_ROLE_KEY"
supabase functions deploy submit-drop-verified
```

If the function reports that `SUPABASE_URL` is missing, also run:

```sh
supabase secrets set SUPABASE_URL="https://hrsrjfpygekjyuwibsia.supabase.co"
```

## 4. Lock down direct browser submits

After the Edge Function is deployed and working, run the full contents of:

```text
supabase-turnstile-lockdown.sql
```

in the Supabase SQL Editor.

That makes `submit_drop` and `record_visit` callable by the server-side function only, so unverified direct browser RPC calls cannot submit messages or trigger visitor rotation.

## 5. Verify

1. Open the live site.
2. Confirm the verification panel appears before the message/calculator UI can be used.
3. Complete both checks and confirm the website unlocks.
4. Confirm one verified visit lands in `public.visits` and advances the next prepared folder.
5. Submit a reply and confirm it lands in `public.drops` without showing the gate again.
6. Confirm direct anonymous calls to `submit_drop` and `record_visit` return `401` or `403`.

Local previews use Cloudflare's test widget and never write messages or visits to production.
