-- DropMMSSGG durable visitor-rotation queue.
--
-- This additive migration intentionally does not update or delete any visit or
-- drop row, does not backfill historical visits, and does not install a worker
-- token. The singleton starts disabled with a NULL token hash, so installing
-- this migration cannot enqueue, poll, or acknowledge a rotation. Baseline
-- reconciliation, token setup, activation, and any post-baseline backfill are
-- separate operator-controlled steps.

begin;

create schema if not exists dropmmssgg_rotation;

revoke all on schema dropmmssgg_rotation
  from public, anon, authenticated;

create table if not exists dropmmssgg_rotation.config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  token_hash bytea,
  check (token_hash is null or pg_catalog.octet_length(token_hash) = 32)
);

create table if not exists dropmmssgg_rotation.queue (
  event_id bigint generated always as identity primary key,
  visit_id bigint not null,
  created_at timestamptz not null,
  acked_at timestamptz,
  unique (visit_id, created_at)
);

create index if not exists queue_pending_event_id_idx
  on dropmmssgg_rotation.queue (event_id)
  where acked_at is null;

alter table dropmmssgg_rotation.config enable row level security;
alter table dropmmssgg_rotation.queue enable row level security;

revoke all on table
  dropmmssgg_rotation.config,
  dropmmssgg_rotation.queue
  from public, anon, authenticated;

revoke all on sequence dropmmssgg_rotation.queue_event_id_seq
  from public, anon, authenticated;

insert into dropmmssgg_rotation.config (singleton, enabled, token_hash)
values (true, false, null)
on conflict (singleton) do nothing;

create or replace function dropmmssgg_rotation.token_matches(
  p_token text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    p_token is not null
    and pg_catalog.length(p_token) = 64
    and p_token ~ '^[0-9a-f]{64}$'
    and exists (
      select 1
      from dropmmssgg_rotation.config as c
      where c.singleton
        and c.token_hash is not null
        and c.token_hash = pg_catalog.sha256(
          pg_catalog.convert_to(p_token, 'UTF8')
        )
    );
$function$;

revoke all on function dropmmssgg_rotation.token_matches(text)
  from public, anon, authenticated;

create or replace function dropmmssgg_rotation.enqueue_visit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- The trigger is installed inert. Cutover explicitly enables it only after
  -- the worker token and frozen legacy checkpoint are ready.
  if not exists (
    select 1
    from dropmmssgg_rotation.config as c
    where c.singleton
      and c.enabled
  ) then
    return new;
  end if;

  -- Click telemetry must not rotate the bulletin. NULL and ordinary paths are
  -- real visit events and remain eligible.
  if pg_catalog.left(
    coalesce(new.path, ''),
    6
  ) = 'click:' then
    return new;
  end if;

  insert into dropmmssgg_rotation.queue (
    visit_id,
    created_at
  )
  values (
    new.id,
    new.created_at
  )
  on conflict (visit_id, created_at) do nothing;

  return new;
end;
$function$;

revoke all on function dropmmssgg_rotation.enqueue_visit()
  from public, anon, authenticated;

drop trigger if exists dropmmssgg_rotation_enqueue_visit
  on public.visits;

create trigger dropmmssgg_rotation_enqueue_visit
after insert on public.visits
for each row
execute function dropmmssgg_rotation.enqueue_visit();

create or replace function public.dropmmssgg_rotation_pending(
  p_token text
)
returns table (
  event_id text,
  visit_id text,
  created_at text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not coalesce(
    (
      select c.enabled
      from dropmmssgg_rotation.config as c
      where c.singleton
    ),
    false
  ) then
    raise exception 'rotation unavailable';
  end if;

  if not dropmmssgg_rotation.token_matches(p_token) then
    raise exception using
      errcode = '42501',
      message = 'rotation authorization failed';
  end if;

  return query
  select
    q.event_id::text,
    q.visit_id::text,
    pg_catalog.to_char(
      q.created_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  from dropmmssgg_rotation.queue as q
  where q.acked_at is null
  order by q.event_id
  limit 50;
end;
$function$;

create or replace function public.dropmmssgg_rotation_ack(
  p_token text,
  p_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_event_id bigint;
  v_acked_at timestamptz;
begin
  if not coalesce(
    (
      select c.enabled
      from dropmmssgg_rotation.config as c
      where c.singleton
    ),
    false
  ) then
    raise exception 'rotation unavailable';
  end if;

  if not dropmmssgg_rotation.token_matches(p_token) then
    raise exception using
      errcode = '42501',
      message = 'rotation authorization failed';
  end if;

  if p_event_id is null or p_event_id !~ '^[1-9][0-9]*$' then
    return false;
  end if;

  begin
    v_event_id := p_event_id::bigint;
  exception
    when numeric_value_out_of_range then
      return false;
  end;

  select q.acked_at
  into v_acked_at
  from dropmmssgg_rotation.queue as q
  where q.event_id = v_event_id;

  if not found then
    return false;
  end if;

  -- Repeating a confirmed acknowledgement is safe and successful.
  if v_acked_at is not null then
    return true;
  end if;

  update dropmmssgg_rotation.queue as q
  set acked_at = pg_catalog.clock_timestamp()
  where q.event_id = v_event_id
    and q.acked_at is null;

  return found;
end;
$function$;

revoke all on function public.dropmmssgg_rotation_pending(text)
  from public, anon, authenticated;
revoke all on function public.dropmmssgg_rotation_ack(text, text)
  from public, anon, authenticated;

grant execute on function public.dropmmssgg_rotation_pending(text)
  to anon, service_role;
grant execute on function public.dropmmssgg_rotation_ack(text, text)
  to anon, service_role;

notify pgrst, 'reload schema';

commit;
