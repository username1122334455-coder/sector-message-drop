-- Run this entire file once in the Supabase SQL Editor.
-- It removes the obsolete curfew, hourly limit, no-space rule, and
-- 26-character rule while preserving private storage in public.drops.

create table if not exists public.drops (
  id bigint generated always as identity primary key,
  message text not null,
  client_hash text not null,
  ip_hash text,
  created_at timestamptz not null default now()
);

alter table public.drops
  add column if not exists ip_hash text;

alter table public.drops
  drop constraint if exists drops_message_format;

alter table public.drops
  add constraint drops_message_format check (
    char_length(message) between 1 and 500
  );

alter table public.drops enable row level security;

drop policy if exists "No public reads" on public.drops;
drop policy if exists "No public writes" on public.drops;

revoke all on public.drops from anon, authenticated;

drop function if exists public.submit_drop(text, uuid);

create or replace function public.submit_drop(
  p_message text,
  p_client_id uuid
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

  insert into public.drops (message, client_hash, ip_hash)
  values (p_message, v_client_hash, v_ip_hash);

  return jsonb_build_object(
    'ok', true,
    'message', 'Reply captured.'
  );
end;
$function$;

-- Submissions are routed through the submit-drop-verified Edge Function.
-- Keep direct browser RPC calls closed after bot verification is enabled.
revoke execute on function public.submit_drop(text, uuid) from anon;
revoke execute on function public.submit_drop(text, uuid) from authenticated;
grant execute on function public.submit_drop(text, uuid) to service_role;

notify pgrst, 'reload schema';
