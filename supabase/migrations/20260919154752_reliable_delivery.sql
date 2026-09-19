-- Separate from jobs so dashboard queries never load attachment bodies. One atomic
-- insert freezes the entire email and reconciliation metadata before any send.
create table public.delivery_outbox (
  job_id uuid primary key references public.digest_jobs(id) on delete cascade,
  payload jsonb,
  first_send_at timestamptz,
  provider_email_id text,
  created_at timestamptz not null default now(),
  constraint delivery_outbox_payload_size check (octet_length(payload::text) <= 24000000)
);
alter table public.delivery_outbox enable row level security;
revoke all on public.delivery_outbox from anon, authenticated;
grant all on public.delivery_outbox to service_role;
create policy backend_only on public.delivery_outbox as restrictive for all
  to anon, authenticated using(false) with check(false);

-- Retain reconciliation state, but expire private publication bodies after 7 days.
select cron.schedule('expire-delivery-payloads', '35 3 * * *', $$
  update public.delivery_outbox o set payload = null
  from public.digest_jobs j
  where o.job_id = j.id and j.status in ('sent','partial','empty','failed')
    and j.finished_at < now() - interval '7 days' and o.payload is not null;
$$);
