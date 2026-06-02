insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'private-message-uploads',
  'private-message-uploads',
  false,
  10485760,
  null
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = null;

drop policy if exists "Private message pictures can be uploaded" on storage.objects;

create policy "Private message pictures can be uploaded"
on storage.objects
for insert
to anon, authenticated
with check (bucket_id = 'private-message-uploads');
