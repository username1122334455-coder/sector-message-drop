create table if not exists public.drops (
  id bigint generated always as identity primary key,
  message text not null,
  client_hash text not null,
  ip_hash text,
  created_at timestamptz not null default now(),
  constraint drops_message_format check (
    char_length(message) between 1 and 26
    and message !~ '\s'
  )
);

alter table public.drops
  add column if not exists ip_hash text;

alter table public.drops
  drop constraint if exists drops_message_format;

alter table public.drops
  add constraint drops_message_format check (
    char_length(message) between 1 and 26
    and message !~ '\s'
  );

create index if not exists drops_client_hash_created_at_idx
  on public.drops (client_hash, created_at desc);

create index if not exists drops_ip_hash_created_at_idx
  on public.drops (ip_hash, created_at desc);

alter table public.drops enable row level security;

drop policy if exists "No public reads" on public.drops;
drop policy if exists "No public writes" on public.drops;

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
begin
  p_message := upper(trim(p_message));

  if p_message is null
    or char_length(p_message) = 0
    or char_length(p_message) > 26
    or p_message ~ '\s'
  then
    return jsonb_build_object(
      'ok', false,
      'message', 'Message must be 1-26 characters with no spaces.',
      'device_remaining', 0,
      'reset_seconds', 0
    );
  end if;

  v_denver_hour := extract(hour from timezone('America/Denver', now()))::int;

  if v_denver_hour >= 22 or v_denver_hour < 8 then
    return jsonb_build_object(
      'ok', false,
      'message', 'DROP CHANNEL OFFLINE. RETURNS AT 08:00 MST.',
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
      'message', 'DEVICE/IP WINDOW CLOSED. 2 MESSAGES PER HOUR. RESETS IN ' || floor(v_reset_seconds / 60) || 'M ' || mod(v_reset_seconds, 60) || 'S.',
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
grant execute on function public.submit_drop(text, uuid) to anon;
grant execute on function public.submit_drop(text, uuid) to authenticated;

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

notify pgrst, 'reload schema';
