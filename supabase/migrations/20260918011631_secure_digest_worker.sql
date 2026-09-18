create schema if not exists private;
revoke all on schema private from public,anon,authenticated;
create table if not exists private.worker_auth(name text primary key,secret_hash text not null,created_at timestamptz not null default now());
do $$
declare existing_secret text;new_secret text;
begin
 select decrypted_secret into existing_secret from vault.decrypted_secrets where name='morning_reader_worker_secret' order by created_at desc limit 1;
 if existing_secret is null then
  new_secret:=encode(extensions.gen_random_bytes(32),'hex');
  perform vault.create_secret(new_secret,'morning_reader_worker_secret','Authenticates the internal pg_cron request to the Morning Reader worker');
  existing_secret:=new_secret;
 end if;
 insert into private.worker_auth(name,secret_hash) values('cron',encode(extensions.digest(existing_secret,'sha256'),'hex'))
 on conflict(name) do update set secret_hash=excluded.secret_hash;
end$$;
create or replace function public.verify_worker_secret(p_secret text)
returns boolean language sql security definer set search_path=public,private,extensions,pg_catalog as $$
 select coalesce(encode(extensions.digest(p_secret,'sha256'),'hex')=(select secret_hash from private.worker_auth where name='cron'),false);
$$;
revoke all on function public.verify_worker_secret(text) from public,anon,authenticated;
grant execute on function public.verify_worker_secret(text) to service_role;
do $$declare j record;begin for j in select jobid from cron.job where jobname='morning-reader-worker' loop perform cron.unschedule(j.jobid);end loop;end$$;
select cron.schedule('morning-reader-worker','*/5 * * * *',$cron$
 select net.http_post(
  url:='https://wuikfmmwvrzpaoevtskn.supabase.co/functions/v1/worker',
  headers:=jsonb_build_object('Content-Type','application/json','x-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='morning_reader_worker_secret' order by created_at desc limit 1)),
  body:=jsonb_build_object('source','cron'),timeout_milliseconds:=120000
 );
$cron$);
