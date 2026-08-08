-- Stage 1: install explicit, canonical IP storage functions before deploying
-- the Edge Function that calls them. The existing service-role-only functions
-- remain available until supabase-ip-flow-v2-cleanup.sql is applied.

-- The Edge Function also requires a dedicated IP_HASH_SECRET. It canonicalizes
-- the trusted first-hop Cloudflare address and supplies both values explicitly;
-- these functions never derive a visitor address from second-hop HTTP headers.

create table if not exists public.visits (
  id bigint generated always as identity primary key,
  client_hash text not null,
  ip_hash text,
  ip_hash_version text,
  ip_address text,
  path text,
  user_agent text,
  timezone text,
  screen_size text,
  platform text,
  referrer text,
  created_at timestamptz not null default now()
);

create table if not exists public.drops (
  id bigint generated always as identity primary key,
  message text not null,
  client_hash text not null,
  ip_hash text,
  ip_hash_version text,
  created_at timestamptz not null default now()
);

alter table public.visits
  add column if not exists ip_address text,
  add column if not exists user_agent text,
  add column if not exists timezone text,
  add column if not exists screen_size text,
  add column if not exists platform text,
  add column if not exists referrer text;

alter table public.drops
  add column if not exists ip_hash text;

alter table public.visits
  add column if not exists ip_hash_version text;

alter table public.drops
  add column if not exists ip_hash_version text;

alter table public.visits enable row level security;
alter table public.drops enable row level security;

revoke all on public.visits from public, anon, authenticated;
revoke all on public.drops from public, anon, authenticated;
revoke all on sequence public.visits_id_seq from public, anon, authenticated;
revoke all on sequence public.drops_id_seq from public, anon, authenticated;

update public.visits
set ip_hash_version = 'md5-v1'
where ip_hash is not null
  and ip_hash_version is null;

update public.drops
set ip_hash_version = 'md5-v1'
where ip_hash is not null
  and ip_hash_version is null;

update public.visits
set ip_hash_version = 'hmac-sha256-v1-key1'
where ip_hash_version = 'hmac-sha256-v1';

update public.drops
set ip_hash_version = 'hmac-sha256-v1-key1'
where ip_hash_version = 'hmac-sha256-v1';

create or replace function public.record_visit_v2(
  p_client_id uuid,
  p_path text default '/',
  p_user_agent text default null,
  p_timezone text default null,
  p_screen_size text default null,
  p_platform text default null,
  p_referrer text default null,
  p_ip_address text default null,
  p_ip_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_client_hash text;
  v_ip_address text;
  v_db_canonical_ip text;
  v_ip_hash text;
  v_path text;
begin
  v_client_hash := md5(p_client_id::text);
  v_ip_address := nullif(lower(trim(coalesce(p_ip_address, ''))), '');

  if v_ip_address is not null then
    begin
      v_db_canonical_ip := host(v_ip_address::inet);
      if v_db_canonical_ip <> v_ip_address then
        v_ip_address := null;
      end if;
    exception
      when invalid_text_representation then
        v_ip_address := null;
    end;
  end if;

  if v_ip_address is not null
    and lower(trim(coalesce(p_ip_hash, ''))) ~ '^[0-9a-f]{64}$'
  then
    v_ip_hash := lower(trim(p_ip_hash));
  else
    v_ip_hash := null;
  end if;

  v_path := coalesce(nullif(trim(p_path), ''), '/');

  insert into public.visits (
    client_hash,
    ip_hash,
    ip_hash_version,
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
    case when v_ip_hash is null then null else 'hmac-sha256-v1-key1' end,
    v_ip_address,
    v_path,
    nullif(left(trim(coalesce(p_user_agent, '')), 1000), ''),
    nullif(left(trim(coalesce(p_timezone, '')), 100), ''),
    nullif(left(trim(coalesce(p_screen_size, '')), 64), ''),
    nullif(left(trim(coalesce(p_platform, '')), 120), ''),
    nullif(left(trim(coalesce(p_referrer, '')), 2048), '')
  );

  return jsonb_build_object(
    'ok', true,
    'path', v_path,
    'ip_collected', v_ip_address is not null
  );
end;
$function$;

create or replace function public.submit_drop_v2(
  p_message text,
  p_client_id uuid,
  p_ip_address text default null,
  p_ip_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_client_hash text;
  v_ip_address text;
  v_db_canonical_ip text;
  v_ip_hash text;
begin
  p_message := trim(p_message);

  if p_message is null
    or char_length(p_message) = 0
    or char_length(p_message) > 500
  then
    return jsonb_build_object(
      'ok', false,
      'message', 'Reply must be 1-500 characters.'
    );
  end if;

  v_client_hash := md5(p_client_id::text);
  v_ip_address := nullif(lower(trim(coalesce(p_ip_address, ''))), '');

  if v_ip_address is not null then
    begin
      v_db_canonical_ip := host(v_ip_address::inet);
      if v_db_canonical_ip <> v_ip_address then
        v_ip_address := null;
      end if;
    exception
      when invalid_text_representation then
        v_ip_address := null;
    end;
  end if;

  if v_ip_address is not null
    and lower(trim(coalesce(p_ip_hash, ''))) ~ '^[0-9a-f]{64}$'
  then
    v_ip_hash := lower(trim(p_ip_hash));
  else
    v_ip_hash := null;
  end if;

  insert into public.drops (
    message,
    client_hash,
    ip_hash,
    ip_hash_version
  )
  values (
    p_message,
    v_client_hash,
    v_ip_hash,
    case when v_ip_hash is null then null else 'hmac-sha256-v1-key1' end
  );

  return jsonb_build_object(
    'ok', true,
    'message', 'Reply captured.'
  );
end;
$function$;

revoke execute on function public.record_visit_v2(uuid, text, text, text, text, text, text, text, text) from public;
revoke execute on function public.record_visit_v2(uuid, text, text, text, text, text, text, text, text) from anon;
revoke execute on function public.record_visit_v2(uuid, text, text, text, text, text, text, text, text) from authenticated;
grant execute on function public.record_visit_v2(uuid, text, text, text, text, text, text, text, text) to service_role;

revoke execute on function public.submit_drop_v2(text, uuid, text, text) from public;
revoke execute on function public.submit_drop_v2(text, uuid, text, text) from anon;
revoke execute on function public.submit_drop_v2(text, uuid, text, text) from authenticated;
grant execute on function public.submit_drop_v2(text, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
