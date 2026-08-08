-- Stage 3: install service-role-only compatibility adapters after the updated
-- Edge Function is live. They preserve a safe rollback path without restoring
-- second-hop proxy-header parsing; rolled-back code records NULL IP values.

drop function if exists public.record_visit(uuid, text);

create or replace function public.record_visit(
  p_client_id uuid,
  p_path text default '/',
  p_user_agent text default null,
  p_timezone text default null,
  p_screen_size text default null,
  p_platform text default null,
  p_referrer text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
  return public.record_visit_v2(
    p_client_id,
    p_path,
    p_user_agent,
    p_timezone,
    p_screen_size,
    p_platform,
    p_referrer,
    null,
    null
  );
end;
$function$;

create or replace function public.submit_drop(
  p_message text,
  p_client_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
  return public.submit_drop_v2(
    p_message,
    p_client_id,
    null,
    null
  );
end;
$function$;

revoke execute on function public.record_visit(uuid, text, text, text, text, text, text) from public;
revoke execute on function public.record_visit(uuid, text, text, text, text, text, text) from anon;
revoke execute on function public.record_visit(uuid, text, text, text, text, text, text) from authenticated;
grant execute on function public.record_visit(uuid, text, text, text, text, text, text) to service_role;

revoke execute on function public.submit_drop(text, uuid) from public;
revoke execute on function public.submit_drop(text, uuid) from anon;
revoke execute on function public.submit_drop(text, uuid) from authenticated;
grant execute on function public.submit_drop(text, uuid) to service_role;

notify pgrst, 'reload schema';
