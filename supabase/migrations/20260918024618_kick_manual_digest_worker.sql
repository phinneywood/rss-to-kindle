create or replace function public.kick_digest_worker()
returns bigint
language plpgsql
security definer
set search_path = public, private, vault, net, pg_catalog
as $$
declare
  request_id bigint;
  worker_secret text;
begin
  select decrypted_secret into worker_secret
  from vault.decrypted_secrets
  where name = 'morning_reader_worker_secret'
  order by created_at desc
  limit 1;

  if worker_secret is null then
    raise exception 'Worker secret is not configured';
  end if;

  select net.http_post(
    url := 'https://wuikfmmwvrzpaoevtskn.supabase.co/functions/v1/worker',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-worker-secret',worker_secret,
      'x-worker-force','1'
    ),
    body := jsonb_build_object('source','manual'),
    timeout_milliseconds := 120000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function public.kick_digest_worker() from public, anon, authenticated;
grant execute on function public.kick_digest_worker() to service_role;
