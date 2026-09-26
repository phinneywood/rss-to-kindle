update public.user_settings
set editorial_brief = replace(
  editorial_brief,
  'Broad interests carried forward from your previous Morning Reader setup:',
  'Broad interests carried forward from your earlier setup:'
)
where editorial_brief like 'Broad interests carried forward from your previous Morning Reader setup:%';

update public.digest_jobs
set packet_name = replace(packet_name, 'Morning Reader', 'Long Form')
where packet_name ilike '%Morning Reader%';

update public.digest_jobs
set edition_name = replace(edition_name, 'Morning Reader', 'Long Form')
where edition_name ilike '%Morning Reader%';

update public.digests
set edition_name = replace(edition_name, 'Morning Reader', 'Long Form')
where edition_name ilike '%Morning Reader%';
