drop function if exists public.record_eth_payment_receipt(text, text, text, numeric, numeric, numeric, numeric, numeric, text, boolean, timestamptz);
drop function if exists public.get_eth_payment_records(text);
drop table if exists public.eth_payment_receipts;
drop function if exists public.record_admin_media_submission(text);
drop function if exists public.get_admin_media_submission_count();
drop table if exists public.admin_media_submissions;
drop policy if exists "Admin files can be uploaded" on storage.objects;
drop policy if exists "Admin files can be listed" on storage.objects;
drop policy if exists "Admin files can be read" on storage.objects;
delete from storage.objects where bucket_id = 'drop-admin-files';
delete from storage.buckets where id = 'drop-admin-files';

create table if not exists public.drops (
  id bigint generated always as identity primary key,
  message text not null,
  client_hash text not null,
  ip_hash text,
  created_at timestamptz not null default now(),
  constraint drops_message_format check (
    char_length(message) between 1 and 500
  )
);

alter table public.drops
  add column if not exists ip_hash text;

alter table public.drops
  drop constraint if exists drops_message_format;

alter table public.drops
  add constraint drops_message_format check (
    char_length(message) between 1 and 500
  );

create index if not exists drops_client_hash_created_at_idx
  on public.drops (client_hash, created_at desc);

create index if not exists drops_ip_hash_created_at_idx
  on public.drops (ip_hash, created_at desc);

create table if not exists public.visits (
  id bigint generated always as identity primary key,
  client_hash text not null,
  ip_hash text,
  path text,
  created_at timestamptz not null default now()
);

alter table public.visits
  add column if not exists ip_hash text;

alter table public.visits
  add column if not exists path text;

create index if not exists visits_created_at_idx
  on public.visits (created_at desc);

create index if not exists visits_client_hash_created_at_idx
  on public.visits (client_hash, created_at desc);

create index if not exists visits_ip_hash_created_at_idx
  on public.visits (ip_hash, created_at desc);

alter table public.drops enable row level security;
alter table public.visits enable row level security;

drop policy if exists "No public reads" on public.drops;
drop policy if exists "No public writes" on public.drops;
drop policy if exists "No public reads" on public.visits;
drop policy if exists "No public writes" on public.visits;

drop function if exists public.record_visit(uuid, text);

create or replace function public.record_visit(
  p_client_id uuid,
  p_path text default '/'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_headers jsonb;
  v_ip text;
  v_denver_hour int;
  v_denver_date date;
  v_curfew_override_date date := date '2026-05-20';
begin
  v_denver_date := timezone('America/Denver', now())::date;
  v_denver_hour := extract(hour from timezone('America/Denver', now()))::int;

  if v_denver_date <> v_curfew_override_date and (v_denver_hour >= 23 or v_denver_hour < 9) then
    return jsonb_build_object('ok', false, 'message', 'Visit ignored during curfew.');
  end if;

  v_headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_ip := coalesce(
    v_headers ->> 'cf-connecting-ip',
    split_part(v_headers ->> 'x-forwarded-for', ',', 1),
    v_headers ->> 'x-real-ip',
    'unknown'
  );

  insert into public.visits (client_hash, ip_hash, path)
  values (
    md5(p_client_id::text),
    md5(trim(v_ip)),
    left(coalesce(nullif(trim(p_path), ''), '/'), 160)
  );

  return jsonb_build_object('ok', true);
end;
$$;

drop function if exists public.submit_drop(text, uuid);

create or replace function public.submit_drop(
  p_message text,
  p_client_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_headers jsonb;
  v_client_hash text;
  v_ip text;
  v_ip_hash text;
  v_device_count int;
  v_ip_count int;
  v_global_count int;
  v_device_remaining int;
  v_reset_seconds int;
  v_device_limit int := 2;
  v_ip_limit int := 2;
  v_global_limit int := 20;
  v_window interval := interval '1 hour';
  v_reset_at timestamptz;
  v_denver_hour int;
  v_denver_date date;
  v_curfew_override_date date := date '2026-05-20';
begin
  p_message := trim(p_message);

  if p_message is null
    or char_length(p_message) = 0
    or char_length(p_message) > 500
  then
    return jsonb_build_object(
      'ok', false,
      'message', 'Message must be 1-500 characters.',
      'device_remaining', 0,
      'reset_seconds', 0
    );
  end if;

  v_denver_date := timezone('America/Denver', now())::date;
  v_denver_hour := extract(hour from timezone('America/Denver', now()))::int;

  if v_denver_date <> v_curfew_override_date and (v_denver_hour >= 23 or v_denver_hour < 9) then
    return jsonb_build_object(
      'ok', false,
      'message', 'DROP CHANNEL OFFLINE. RETURNS AT 09:00.',
      'device_remaining', 0,
      'reset_seconds', 0
    );
  end if;

  v_headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_client_hash := md5(p_client_id::text);
  v_ip := coalesce(
    v_headers ->> 'cf-connecting-ip',
    split_part(v_headers ->> 'x-forwarded-for', ',', 1),
    v_headers ->> 'x-real-ip',
    'unknown'
  );
  v_ip_hash := md5(trim(v_ip));

  select count(*)
    into v_device_count
    from public.drops
   where client_hash = v_client_hash
     and created_at >= now() - v_window;

  select count(*)
    into v_ip_count
    from public.drops
   where ip_hash = v_ip_hash
     and created_at >= now() - v_window;

  select count(*)
    into v_global_count
    from public.drops
   where created_at >= now() - v_window;

  select min(created_at + v_window)
    into v_reset_at
    from public.drops
   where (client_hash = v_client_hash or ip_hash = v_ip_hash or v_global_count >= v_global_limit)
     and created_at >= now() - v_window;

  v_reset_seconds := greatest(ceil(extract(epoch from (coalesce(v_reset_at, now() + v_window) - now())))::int, 0);

  if v_device_count >= v_device_limit or v_ip_count >= v_ip_limit or v_global_count >= v_global_limit then
    return jsonb_build_object(
      'ok', false,
      'message', 'DEVICE/IP WINDOW CLOSED. 2 ENTRIES PER HOUR. RESETS IN ' || floor(v_reset_seconds / 60) || 'M ' || mod(v_reset_seconds, 60) || 'S.',
      'device_remaining', 0,
      'reset_seconds', v_reset_seconds
    );
  end if;

  insert into public.drops (message, client_hash, ip_hash)
  values (p_message, v_client_hash, v_ip_hash);

  v_device_remaining := greatest(v_device_limit - v_device_count - 1, 0);

  return jsonb_build_object(
    'ok', true,
    'message', 'Drop received.',
    'device_remaining', v_device_remaining,
    'reset_seconds', v_reset_seconds
  );
end;
$$;

revoke all on public.drops from anon, authenticated;
revoke all on public.visits from anon, authenticated;
grant execute on function public.record_visit(uuid, text) to anon;
grant execute on function public.record_visit(uuid, text) to authenticated;
grant execute on function public.submit_drop(text, uuid) to anon;
grant execute on function public.submit_drop(text, uuid) to authenticated;

drop function if exists public.get_admin_stats();

create or replace function public.get_admin_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_denver_now timestamp;
  v_today_start_local timestamp;
  v_today_end_local timestamp;
  v_today_start timestamptz;
  v_today_end timestamptz;
  v_visits_today int;
  v_total_visits int;
  v_unique_devices_today int;
  v_unique_ips_today int;
  v_drops_today int;
  v_total_drops int;
begin
  v_denver_now := timezone('America/Denver', now());
  v_today_start_local := date_trunc('day', v_denver_now);
  v_today_end_local := v_today_start_local + interval '1 day';
  v_today_start := v_today_start_local at time zone 'America/Denver';
  v_today_end := v_today_end_local at time zone 'America/Denver';

  select count(*) into v_visits_today
    from public.visits
   where created_at >= v_today_start
     and created_at < v_today_end;

  select count(*) into v_total_visits
    from public.visits;

  select count(distinct client_hash) into v_unique_devices_today
    from public.visits
   where created_at >= v_today_start
     and created_at < v_today_end;

  select count(distinct ip_hash) into v_unique_ips_today
    from public.visits
   where created_at >= v_today_start
     and created_at < v_today_end;

  select count(*) into v_drops_today
    from public.drops
   where created_at >= v_today_start
     and created_at < v_today_end;

  select count(*) into v_total_drops
    from public.drops;

  return jsonb_build_object(
    'visits_today', v_visits_today,
    'total_visits', v_total_visits,
    'unique_devices_today', v_unique_devices_today,
    'unique_ips_today', v_unique_ips_today,
    'drops_today', v_drops_today,
    'total_drops', v_total_drops,
    'window_start', v_today_start,
    'window_end', v_today_end
  );
end;
$$;

grant execute on function public.get_admin_stats() to anon;
grant execute on function public.get_admin_stats() to authenticated;

create or replace function public.get_drop_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_drops_received int;
  v_denver_now timestamp;
  v_window_start_local timestamp;
  v_window_end_local timestamp;
  v_window_start timestamptz;
  v_window_end timestamptz;
begin
  v_denver_now := timezone('America/Denver', now());
  v_window_start_local := date_trunc('day', v_denver_now) + interval '8 hours';

  if v_denver_now < v_window_start_local then
    v_window_start_local := v_window_start_local - interval '1 day';
  end if;

  v_window_end_local := v_window_start_local + interval '1 day';
  v_window_start := v_window_start_local at time zone 'America/Denver';
  v_window_end := v_window_end_local at time zone 'America/Denver';

  select count(*)
    into v_drops_received
    from public.drops
   where created_at >= v_window_start
     and created_at < v_window_end;

  return jsonb_build_object(
    'drops_today', v_drops_received,
    'drops_received', v_drops_received,
    'window_start', v_window_start,
    'window_end', v_window_end
  );
end;
$$;

grant execute on function public.get_drop_stats() to anon;
grant execute on function public.get_drop_stats() to authenticated;

create extension if not exists pgcrypto;

create table if not exists public.reward_codes (
  id bigserial primary key,
  user_number text not null unique,
  code_salt text not null,
  code_hash text not null,
  backup_code_salt text,
  backup_code_hash text,
  redeemed_at timestamptz,
  redeemed_with text,
  redeemed_client_hash text,
  redeemed_ip_hash text,
  redemption_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reward_codes_redeemed_with_check check (
    redeemed_with is null or redeemed_with in ('primary', 'backup')
  )
);

create table if not exists public.reward_redemption_attempts (
  id bigserial primary key,
  user_number text,
  client_hash text,
  ip_hash text,
  ok boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists reward_redemption_attempts_client_created_at_idx
  on public.reward_redemption_attempts (client_hash, created_at desc);

create index if not exists reward_redemption_attempts_ip_created_at_idx
  on public.reward_redemption_attempts (ip_hash, created_at desc);

alter table public.reward_codes enable row level security;
alter table public.reward_redemption_attempts enable row level security;

revoke all on public.reward_codes from anon, authenticated;
revoke all on public.reward_redemption_attempts from anon, authenticated;

drop function if exists public.reward_code_hash(text, text, text);
drop function if exists public.upsert_reward_code(text, text, text, boolean);
drop function if exists public.verify_reward_code(text, text, uuid);

create or replace function public.reward_code_hash(
  p_user_number text,
  p_code text,
  p_salt text
)
returns text
language sql
security definer
set search_path = public
as $$
  select encode(
    digest(trim(p_salt) || ':' || trim(p_user_number) || ':' || trim(p_code), 'sha256'),
    'hex'
  );
$$;

create or replace function public.upsert_reward_code(
  p_user_number text,
  p_reward_code text,
  p_backup_code text default null,
  p_reset_redemption boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_salt text := encode(gen_random_bytes(16), 'hex');
  v_backup_salt text := case
    when nullif(trim(coalesce(p_backup_code, '')), '') is null then null
    else encode(gen_random_bytes(16), 'hex')
  end;
begin
  if trim(p_user_number) !~ '^\d{1,10}$' then
    raise exception 'Invalid user number.';
  end if;

  if trim(p_reward_code) !~ '^\d{8,16}$' then
    raise exception 'Invalid primary reward code.';
  end if;

  if nullif(trim(coalesce(p_backup_code, '')), '') is not null
    and trim(p_backup_code) !~ '^\d{8,16}$'
  then
    raise exception 'Invalid backup reward code.';
  end if;

  insert into public.reward_codes (
    user_number,
    code_salt,
    code_hash,
    backup_code_salt,
    backup_code_hash
  )
  values (
    trim(p_user_number),
    v_code_salt,
    public.reward_code_hash(p_user_number, p_reward_code, v_code_salt),
    v_backup_salt,
    case
      when v_backup_salt is null then null
      else public.reward_code_hash(p_user_number, p_backup_code, v_backup_salt)
    end
  )
  on conflict (user_number) do update
  set
    code_salt = excluded.code_salt,
    code_hash = excluded.code_hash,
    backup_code_salt = excluded.backup_code_salt,
    backup_code_hash = excluded.backup_code_hash,
    redeemed_at = case when p_reset_redemption then null else public.reward_codes.redeemed_at end,
    redeemed_with = case when p_reset_redemption then null else public.reward_codes.redeemed_with end,
    redeemed_client_hash = case when p_reset_redemption then null else public.reward_codes.redeemed_client_hash end,
    redeemed_ip_hash = case when p_reset_redemption then null else public.reward_codes.redeemed_ip_hash end,
    redemption_id = case when p_reset_redemption then null else public.reward_codes.redemption_id end,
    updated_at = now();

  return jsonb_build_object('ok', true, 'user_number', trim(p_user_number));
end;
$$;

create or replace function public.verify_reward_code(
  p_user_number text,
  p_reward_code text,
  p_client_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_headers jsonb;
  v_ip text;
  v_ip_hash text;
  v_client_hash text;
  v_failed_attempts int;
  v_code public.reward_codes%rowtype;
  v_used text;
  v_redemption_id uuid := gen_random_uuid();
begin
  if trim(p_user_number) !~ '^\d{1,10}$' or trim(p_reward_code) !~ '^\d{8,16}$' then
    return jsonb_build_object('ok', false, 'message', 'Invalid reward credentials.');
  end if;

  v_headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_ip := coalesce(
    v_headers ->> 'cf-connecting-ip',
    split_part(v_headers ->> 'x-forwarded-for', ',', 1),
    v_headers ->> 'x-real-ip',
    'unknown'
  );
  v_ip_hash := md5(trim(v_ip));
  v_client_hash := md5(p_client_id::text);

  select count(*)
    into v_failed_attempts
    from public.reward_redemption_attempts
   where ok = false
     and created_at >= now() - interval '15 minutes'
     and (client_hash = v_client_hash or ip_hash = v_ip_hash);

  if v_failed_attempts >= 8 then
    return jsonb_build_object(
      'ok', false,
      'message', 'Reward verification paused. Try again later.'
    );
  end if;

  select *
    into v_code
    from public.reward_codes
   where user_number = trim(p_user_number)
   for update;

  if not found then
    insert into public.reward_redemption_attempts (user_number, client_hash, ip_hash, ok)
    values (trim(p_user_number), v_client_hash, v_ip_hash, false);

    return jsonb_build_object('ok', false, 'message', 'Invalid reward credentials.');
  end if;

  if v_code.redeemed_at is not null then
    insert into public.reward_redemption_attempts (user_number, client_hash, ip_hash, ok)
    values (trim(p_user_number), v_client_hash, v_ip_hash, false);

    return jsonb_build_object('ok', false, 'message', 'Reward token already redeemed.');
  end if;

  if public.reward_code_hash(p_user_number, p_reward_code, v_code.code_salt) = v_code.code_hash then
    v_used := 'primary';
  elsif v_code.backup_code_salt is not null
    and public.reward_code_hash(p_user_number, p_reward_code, v_code.backup_code_salt) = v_code.backup_code_hash
  then
    v_used := 'backup';
  else
    insert into public.reward_redemption_attempts (user_number, client_hash, ip_hash, ok)
    values (trim(p_user_number), v_client_hash, v_ip_hash, false);

    return jsonb_build_object('ok', false, 'message', 'Invalid reward credentials.');
  end if;

  update public.reward_codes
     set redeemed_at = now(),
         redeemed_with = v_used,
         redeemed_client_hash = v_client_hash,
         redeemed_ip_hash = v_ip_hash,
         redemption_id = v_redemption_id,
         updated_at = now()
   where id = v_code.id;

  insert into public.reward_redemption_attempts (user_number, client_hash, ip_hash, ok)
  values (trim(p_user_number), v_client_hash, v_ip_hash, true);

  return jsonb_build_object(
    'ok', true,
    'message', 'Reward code verified.',
    'user_number', trim(p_user_number),
    'redemption_id', v_redemption_id,
    'verified_with', v_used,
    'verified_at', now()
  );
end;
$$;

revoke all on function public.reward_code_hash(text, text, text) from public, anon, authenticated;
revoke all on function public.upsert_reward_code(text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.verify_reward_code(text, text, uuid) from public;
grant execute on function public.verify_reward_code(text, text, uuid) to anon;
grant execute on function public.verify_reward_code(text, text, uuid) to authenticated;

notify pgrst, 'reload schema';
