# Bot Verification Setup

This project uses Cloudflare Turnstile on the page and a Supabase Edge Function for server-side verification.

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

That makes `submit_drop` callable by the server-side function only, so unverified direct browser RPC calls are rejected.

## 5. Verify

1. Open the live site.
2. Confirm the verification panel appears before the message/calculator UI can be used.
3. Complete the Turnstile check.
4. Submit a reply.
5. Confirm the reply lands in `public.drops`.
