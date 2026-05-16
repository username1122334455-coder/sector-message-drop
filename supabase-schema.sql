create extension if not exists pgcrypto;

create table if not exists public.drops (
  id bigint generated always as identity primary key,
  message text not null,
  client_hash text not null,
  created_at timestamptz not null default now(),
  constraint drops_message_format check (
    char_length(message) between 1 and 15
    and message !~ '\s'
  )
);

create index if not exists drops_client_hash_created_at_idx
  on public.drops (client_hash, created_at desc);

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
  v_client_hash text;
  v_count int;
  v_remaining int;
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
      'remaining', 0
    );
  end if;

  v_client_hash := encode(digest(p_client_id::text, 'sha256'), 'hex');

  select count(*)
    into v_count
    from public.drops
   where client_hash = v_client_hash
     and created_at >= now() - interval '1 hour';

  if v_count >= 10 then
    return jsonb_build_object(
      'ok', false,
      'message', 'Hourly limit reached.',
      'remaining', 0
    );
  end if;

  insert into public.drops (message, client_hash)
  values (p_message, v_client_hash);

  v_remaining := 9 - v_count;

  return jsonb_build_object(
    'ok', true,
    'message', 'Drop received.',
    'remaining', v_remaining
  );
end;
$$;

revoke all on public.drops from anon, authenticated;
grant execute on function public.submit_drop(text, uuid) to anon;
grant execute on function public.submit_drop(text, uuid) to authenticated;
