alter table public.digest_jobs
  drop constraint if exists digest_jobs_reason_check;

alter table public.digest_jobs
  add constraint digest_jobs_reason_check
  check (reason in ('scheduled','manual','test','one_time'));

alter table public.digest_jobs
  add column if not exists packet_name text,
  add column if not exists article_urls jsonb not null default '[]'::jsonb;

alter table public.digest_jobs
  add constraint digest_jobs_one_time_payload_check
  check (
    (
      reason = 'one_time'
      and packet_name is not null
      and char_length(btrim(packet_name)) between 1 and 80
      and jsonb_typeof(article_urls) = 'array'
      and jsonb_array_length(article_urls) between 1 and 20
    )
    or
    (
      reason <> 'one_time'
      and packet_name is null
      and article_urls = '[]'::jsonb
    )
  );

alter table public.digests
  add column if not exists edition_name text;

update public.digests as digest
set edition_name = section.name
from public.sections as section
where digest.section_id = section.id
  and digest.edition_name is null;

create unique index if not exists digests_one_time_job_key
  on public.digests(job_id)
  where job_id is not null and section_id is null;

alter table public.article_deliveries
  drop constraint if exists article_deliveries_user_id_article_hash_key;

alter table public.article_deliveries
  add column if not exists delivery_kind text not null default 'recurring'
  check (delivery_kind in ('recurring','one_time'));

alter table public.article_deliveries
  add constraint article_deliveries_digest_article_key
  unique(digest_id,article_hash);

create index if not exists article_deliveries_user_hash_idx
  on public.article_deliveries(user_id,article_hash);
