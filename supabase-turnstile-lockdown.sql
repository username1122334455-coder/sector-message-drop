-- Run this after deploying the submit-drop-verified Edge Function.
-- This blocks direct browser calls to submit_drop so submissions must pass
-- server-side Cloudflare Turnstile verification first.

revoke execute on function public.submit_drop(text, uuid) from public;
revoke execute on function public.submit_drop(text, uuid) from anon;
revoke execute on function public.submit_drop(text, uuid) from authenticated;
grant execute on function public.submit_drop(text, uuid) to service_role;

-- A recognized visitor is written only after the Edge Function validates the
-- Turnstile token. Direct browser calls must not be able to trigger rotation.
revoke execute on function public.record_visit(uuid, text, text, text, text, text, text) from public;
revoke execute on function public.record_visit(uuid, text, text, text, text, text, text) from anon;
revoke execute on function public.record_visit(uuid, text, text, text, text, text, text) from authenticated;
grant execute on function public.record_visit(uuid, text, text, text, text, text, text) to service_role;

notify pgrst, 'reload schema';
