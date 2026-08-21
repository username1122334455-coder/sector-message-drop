-- Keep internal SECURITY DEFINER helpers out of the public Data API.
-- The rotation watcher intentionally retains anon access to
-- public.latest_site_visit_marker(); it returns only the newest visit timestamp.

revoke execute on function public.get_admin_stats() from public, anon, authenticated;
revoke execute on function public.get_drop_stats() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
revoke execute on function public.latest_site_visit_marker() from public, authenticated;

grant execute on function public.get_admin_stats() to service_role;
grant execute on function public.get_drop_stats() to service_role;
grant execute on function public.rls_auto_enable() to service_role;
grant execute on function public.latest_site_visit_marker() to anon, service_role;

notify pgrst, 'reload schema';
