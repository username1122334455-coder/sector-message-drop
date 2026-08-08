-- Run this after deploying the submit-drop-verified Edge Function.
-- The website uses the Edge Function for visits and message submissions while
-- direct browser calls to the database functions remain closed.

revoke execute on function public.submit_drop(text, uuid) from public;
revoke execute on function public.submit_drop(text, uuid) from anon;
revoke execute on function public.submit_drop(text, uuid) from authenticated;
grant execute on function public.submit_drop(text, uuid) to service_role;

revoke execute on function public.record_visit(uuid, text, text, text, text, text, text) from public;
revoke execute on function public.record_visit(uuid, text, text, text, text, text, text) from anon;
revoke execute on function public.record_visit(uuid, text, text, text, text, text, text) from authenticated;
grant execute on function public.record_visit(uuid, text, text, text, text, text, text) to service_role;

notify pgrst, 'reload schema';
