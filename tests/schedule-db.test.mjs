import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const migration=name=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const db=new PGlite();
const user='10000000-0000-0000-0000-000000000001';
const daily='20000000-0000-0000-0000-000000000001';
const weekly='20000000-0000-0000-0000-000000000002';
const ready=(async()=>{
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  // Email case-folding is unrelated to this test; all scheduling tables and
  // triggers otherwise come from the real baseline migrations.
  await db.exec(migration('20260917214304_initial_morning_reader_schema.sql').replace(/create extension[^;]+;/,'').replace(/\bcitext\b/g,'text'));
  await db.exec(migration('20260917215216_add_digest_job_queue.sql'));
  await db.exec(`insert into app_users(id,email) values('${user}','fixture@example.test');
    insert into user_settings(user_id,kindle_email,timezone,delivery_time,onboarding_complete,next_run_at)
      values('${user}','fixture@kindle.test','America/Los_Angeles','04:00',true,'2026-09-20T11:00:00Z');
    insert into sections(id,user_id,name) values('${daily}','${user}','Daily'),('${weekly}','${user}','Weekly');`);
  await db.exec(migration('20260919172328_edition_delivery_schedules.sql'));
  await db.exec(migration('20260919205500_single_daily_issue.sql'));
})();
async function query(sql,params=[]){await ready;return (await db.query(sql,params)).rows;}
async function isolated(work){await ready;await db.exec('begin');try{await work()}finally{await db.exec('rollback')}}
test.after(async()=>{await ready;await db.close()});

test('migration restores one account-wide daily schedule and keeps section inclusion days',async()=>{
  const settings=(await query('select delivery_time,next_run_at from user_settings'))[0];
  assert.equal(settings.delivery_time,'04:00:00');assert.ok(settings.next_run_at);
  const sections=await query('select next_run_at,delivery_days from sections order by id');
  assert.ok(sections.every(s=>s.next_run_at===null));assert.ok(sections.every(s=>s.delivery_days.length===7));
});
test('daily scheduler queues exactly one issue for the account',()=>isolated(async()=>{
  await db.exec("update user_settings set next_run_at='2026-09-20T11:00:00Z'");
  assert.equal((await query("select queue_due_daily_issues('2026-09-20T11:01:00Z') as n"))[0].n,1);
  assert.equal((await query("select queue_due_daily_issues('2026-09-20T11:01:00Z') as n"))[0].n,0);
  const jobs=await query("select section_id,edition_name,lookback_hours from digest_jobs where reason='scheduled'");
  assert.equal(jobs.length,1);assert.equal(jobs[0].section_id,null);assert.equal(jobs[0].edition_name,null);assert.equal(jobs[0].lookback_hours,48);
}));
test('section weekday edits do not create independent schedules',()=>isolated(async()=>{
  await db.exec(`update sections set delivery_days='{1,3,5}' where id='${daily}'`);
  const rows=await query('select id,delivery_days,next_run_at from sections order by id');
  assert.deepEqual(rows[0].delivery_days,[1,3,5]);assert.ok(rows.every(r=>r.next_run_at===null));
}));
test('pause and delivery-time changes recalculate only the account schedule',()=>isolated(async()=>{
  await db.exec(`update user_settings set paused=true where user_id='${user}'`);
  assert.equal((await query('select next_run_at from user_settings'))[0].next_run_at,null);
  await db.exec(`update user_settings set delivery_time='07:30',paused=false where user_id='${user}'`);
  const settings=(await query('select delivery_time,next_run_at from user_settings'))[0];
  assert.equal(settings.delivery_time,'07:30:00');assert.ok(settings.next_run_at>new Date());
}));
test('untrusted roles cannot queue daily issues and invalid section days fail',()=>isolated(async()=>{
  const [r]=await query("select has_function_privilege('anon','public.queue_due_daily_issues(timestamptz)','execute') as anon,has_function_privilege('authenticated','public.queue_due_daily_issues(timestamptz)','execute') as auth,has_function_privilege('service_role','public.queue_due_daily_issues(timestamptz)','execute') as worker");
  assert.equal(r.anon,false);assert.equal(r.auth,false);assert.equal(r.worker,true);
  await assert.rejects(db.exec("update sections set delivery_days='{}'"),/sections_delivery_days_valid/);
}));
