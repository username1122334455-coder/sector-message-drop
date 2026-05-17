create table if not exists public.drops (
  id bigint generated always as identity primary key,
  message text not null,
  client_hash text not null,
  ip_hash text,
  created_at timestamptz not null default now(),
  constraint drops_message_format check (
    char_length(message) between 1 and 15
    and message !~ '\s'
  )
);

alter table public.drops
  add column if not exists ip_hash text;

create index if not exists drops_client_hash_created_at_idx
  on public.drops (client_hash, created_at desc);

create index if not exists drops_ip_hash_created_at_idx
  on public.drops (ip_hash, created_at desc);

alter table public.drops enable row level security;

drop policy if exists "No public reads" on public.drops;
drop policy if exists "No public writes" on public.drops;

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
  v_device_remaining int;
  v_ip_remaining int;
  v_local_now timestamp;
  v_window_start_local timestamp;
  v_window_end_local timestamp;
  v_window_start_at timestamptz;
  v_window_end_at timestamptz;
  v_local_hour int;
begin
  p_message := upper(trim(p_message));

  if p_message is null
    or char_length(p_message) = 0
    or char_length(p_message) > 15
    or p_message ~ '\s'
  then
    return jsonb_build_object(
      'ok', false,
      'message', 'Message must be 1-15 characters with no spaces.',
      'device_remaining', 0,
      'ip_remaining', 0
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
  v_local_now := timezone('America/Denver', now());
  v_local_hour := extract(hour from v_local_now)::int;

  if v_local_hour < 10 or v_local_hour >= 22 then
    return jsonb_build_object(
      'ok', false,
      'message', 'Drops are closed until 10AM Mountain Time.',
      'device_remaining', 0,
      'ip_remaining', 0
    );
  end if;

  if v_local_hour < 14 then
    v_window_start_local := date_trunc('day', v_local_now) + interval '10 hours';
    v_window_end_local := date_trunc('day', v_local_now) + interval '14 hours';
  elsif v_local_hour < 18 then
    v_window_start_local := date_trunc('day', v_local_now) + interval '14 hours';
    v_window_end_local := date_trunc('day', v_local_now) + interval '18 hours';
  else
    v_window_start_local := date_trunc('day', v_local_now) + interval '18 hours';
    v_window_end_local := date_trunc('day', v_local_now) + interval '22 hours';
  end if;

  v_window_start_at := v_window_start_local at time zone 'America/Denver';
  v_window_end_at := v_window_end_local at time zone 'America/Denver';

  select count(*)
    into v_device_count
    from public.drops
   where client_hash = v_client_hash
     and created_at >= v_window_start_at
     and created_at < v_window_end_at;

  select count(*)
    into v_ip_count
    from public.drops
   where ip_hash = v_ip_hash
     and created_at >= v_window_start_at
     and created_at < v_window_end_at;

  if v_ip_count >= 1 then
    return jsonb_build_object(
      'ok', false,
      'message', 'IP limit reached for this Mountain Time window.',
      'device_remaining', greatest(2 - v_device_count, 0),
      'ip_remaining', 0
    );
  end if;

  if v_device_count >= 2 then
    return jsonb_build_object(
      'ok', false,
      'message', 'Device limit reached for this Mountain Time window.',
      'device_remaining', 0,
      'ip_remaining', greatest(1 - v_ip_count, 0)
    );
  end if;

  insert into public.drops (message, client_hash, ip_hash)
  values (p_message, v_client_hash, v_ip_hash);

  v_device_remaining := 1 - v_device_count;
  v_ip_remaining := 0;

  return jsonb_build_object(
    'ok', true,
    'message', 'Drop received.',
    'device_remaining', v_device_remaining,
    'ip_remaining', v_ip_remaining
  );
end;
$$;

revoke all on public.drops from anon, authenticated;
grant execute on function public.submit_drop(text, uuid) to anon;
grant execute on function public.submit_drop(text, uuid) to authenticated;
