-- Run this after deploying the submit-drop-verified Edge Function.
-- This blocks direct browser calls to submit_drop so submissions must pass
-- server-side Cloudflare Turnstile verification first.

revoke execute on function public.submit_drop(text, uuid) from anon;
revoke execute on function public.submit_drop(text, uuid) from authenticated;
grant execute on function public.submit_drop(text, uuid) to service_role;

notify pgrst, 'reload schema';
