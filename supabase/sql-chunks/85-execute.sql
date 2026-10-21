revoke execute on function public.start_call(uuid, text, boolean) from public, anon;

grant execute on function public.start_call(uuid, text, boolean) to authenticated;
