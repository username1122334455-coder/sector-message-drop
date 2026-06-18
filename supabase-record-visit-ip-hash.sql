create or replace function public.record_visit(
  p_client_id uuid,
  p_path text default '/'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_headers jsonb;
  v_client_hash text;
  v_ip text;
  v_ip_hash text;
begin
  v_headers := coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb,
    '{}'::jsonb
  );

  v_client_hash := md5(p_client_id::text);

  v_ip := coalesce(
    v_headers ->> 'cf-connecting-ip',
    split_part(v_headers ->> 'x-forwarded-for', ',', 1),
    v_headers ->> 'x-real-ip',
    'unknown'
  );

  v_ip_hash := md5(trim(v_ip));

  insert into public.visits (
    client_hash,
    ip_hash,
    path
  )
  values (
    v_client_hash,
    v_ip_hash,
    coalesce(nullif(trim(p_path), ''), '/')
  );

  return jsonb_build_object(
    'ok', true,
    'path', coalesce(nullif(trim(p_path), ''), '/')
  );
end;
$function$;

revoke all on function public.record_visit(uuid, text) from public;
grant execute on function public.record_visit(uuid, text) to anon, authenticated;
