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
begin
  p_message := trim(p_message);

  if p_message is null
    or char_length(p_message) = 0
    or char_length(p_message) > 500
  then
    return jsonb_build_object(
      'ok', false,
      'message', 'Message must be 1-500 characters.'
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

  insert into public.drops (message, client_hash, ip_hash)
  values (p_message, v_client_hash, v_ip_hash);

  return jsonb_build_object(
    'ok', true,
    'message', 'Drop received.'
  );
end;
$$;

grant execute on function public.submit_drop(text, uuid) to anon;
grant execute on function public.submit_drop(text, uuid) to authenticated;

notify pgrst, 'reload schema';
