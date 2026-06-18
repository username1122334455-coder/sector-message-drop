create table if not exists public.visits (
  id bigint generated always as identity primary key,
  client_hash text not null,
  ip_hash text,
  path text,
  created_at timestamptz not null default now()
);

alter table public.visits
  add column if not exists ip_address text,
  add column if not exists user_agent text,
  add column if not exists timezone text,
  add column if not exists screen_size text,
  add column if not exists platform text,
  add column if not exists referrer text;

alter table public.visits enable row level security;

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
declare
  v_headers jsonb;
  v_client_hash text;
  v_ip text;
  v_ip_hash text;
  v_path text;
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
  v_path := coalesce(nullif(trim(p_path), ''), '/');

  insert into public.visits (
    client_hash,
    ip_hash,
    ip_address,
    path,
    user_agent,
    timezone,
    screen_size,
    platform,
    referrer
  )
  values (
    v_client_hash,
    v_ip_hash,
    trim(v_ip),
    v_path,
    nullif(left(trim(coalesce(p_user_agent, v_headers ->> 'user-agent', '')), 1000), ''),
    nullif(left(trim(coalesce(p_timezone, '')), 100), ''),
    nullif(left(trim(coalesce(p_screen_size, '')), 64), ''),
    nullif(left(trim(coalesce(p_platform, '')), 120), ''),
    nullif(left(trim(coalesce(p_referrer, '')), 2048), '')
  );

  return jsonb_build_object(
    'ok', true,
    'path', v_path
  );
end;
$function$;

revoke all on function public.record_visit(uuid, text, text, text, text, text, text) from public;
grant execute on function public.record_visit(uuid, text, text, text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
