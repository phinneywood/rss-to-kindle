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
})();
async function query(sql,params=[]){await ready;return (await db.query(sql,params)).rows;}
async function isolated(work){await ready;await db.exec('begin');try{await work()}finally{await db.exec('rollback')}}
test.after(async()=>{await ready;await db.close()});

test('migration preserves times and next sends, and retires the account scheduler',async()=>{
  const rows=await query('select delivery_time,next_run_at,delivery_days from sections order by id');
  assert.equal(rows.length,2);for(const row of rows){assert.equal(row.delivery_time,'04:00:00');assert.equal(row.next_run_at.toISOString(),'2026-09-20T11:00:00.000Z');assert.deepEqual(row.delivery_days,[0,1,2,3,4,5,6])}
  assert.equal((await query('select next_run_at from user_settings'))[0].next_run_at,null);
  assert.equal((await query("select next_delivery_at('UTC','06:00') as next"))[0].next,null);
});
test('weekdays skip weekends and exact slots advance once',async()=>{
  const rows=await query("select next_edition_delivery_at('America/Los_Angeles','07:30',array[1,2,3,4,5]::smallint[],'2026-09-19T16:00:00Z') as weekdays,next_edition_delivery_at('UTC','07:30',array[1]::smallint[],'2026-09-21T07:30:00Z') as exact");
  assert.equal(rows[0].weekdays.toISOString(),'2026-09-21T14:30:00.000Z');assert.equal(rows[0].exact.toISOString(),'2026-09-28T07:30:00.000Z');
});
test('daylight saving follows local clock with one unambiguous send',async()=>{
  const [r]=await query("select next_edition_delivery_at('America/Los_Angeles','02:30',array[0]::smallint[],'2026-03-08T08:00:00Z') as spring,next_edition_delivery_at('America/Los_Angeles','01:30',array[0]::smallint[],'2026-11-01T07:00:00Z') as autumn,next_edition_delivery_at('Europe/Madrid','06:00',array[0]::smallint[],'2026-10-24T12:00:00Z') as madrid");
  assert.equal(r.spring.toISOString(),'2026-03-08T10:30:00.000Z');assert.equal(r.autumn.toISOString(),'2026-11-01T09:30:00.000Z');assert.equal(r.madrid.toISOString(),'2026-10-25T05:00:00.000Z');
});
test('queue scopes jobs to editions, widens weekly lookback, and is idempotent',()=>isolated(async()=>{
  await db.exec(`update sections set delivery_days='{0}' where id='${weekly}'; update sections set next_run_at='2026-09-20T11:00:00Z';`);
  assert.equal((await query("select queue_due_editions('2026-09-20T11:01:00Z') as n"))[0].n,2);
  assert.equal((await query("select queue_due_editions('2026-09-20T11:01:00Z') as n"))[0].n,0);
  const jobs=await query('select section_id,edition_name,lookback_hours,scheduled_for,schedule_version from digest_jobs order by edition_name');
  assert.equal(jobs[0].section_id,daily);assert.equal(jobs[0].lookback_hours,48);assert.equal(jobs[1].section_id,weekly);assert.equal(jobs[1].lookback_hours,192);
  assert.equal(jobs[0].scheduled_for.toISOString(),'2026-09-20T11:00:00.000Z');assert.ok(jobs.every(j=>j.schedule_version>=1));
}));
test('overdue schedules catch up once instead of replaying every missed day',()=>isolated(async()=>{
  await db.exec("update sections set next_run_at='2026-09-01T11:00:00Z'");
  assert.equal((await query("select queue_due_editions('2026-09-20T12:00:00Z') as n"))[0].n,2);
  assert.equal((await query("select queue_due_editions('2026-09-20T12:00:00Z') as n"))[0].n,0);
  assert.ok((await query('select next_run_at from sections')).every(s=>s.next_run_at.toISOString()==='2026-09-21T11:00:00.000Z'));
}));
test('schedule edits are isolated; pause, resume, and timezone changes recalculate',()=>isolated(async()=>{
  await db.exec(`update sections set delivery_time='07:30',delivery_days='{1,3,5}' where id='${daily}'`);
  let rows=await query('select id,delivery_time,schedule_version,next_run_at from sections order by id');
  assert.equal(rows[0].schedule_version,2);assert.equal(rows[1].schedule_version,1);assert.equal(rows[1].delivery_time,'04:00:00');
  await db.exec(`update user_settings set paused=true where user_id='${user}'`);
  assert.ok((await query('select next_run_at from sections')).every(s=>s.next_run_at===null));
  await db.exec(`update user_settings set timezone='Europe/Madrid',paused=false where user_id='${user}'`);
  assert.ok((await query('select next_run_at from sections')).every(s=>s.next_run_at>new Date()));
  await db.exec(`update sections set enabled=false where id='${daily}'`);
  assert.equal((await query('select next_run_at from sections where id=$1',[daily]))[0].next_run_at,null);
  await db.exec(`insert into sections(user_id,name) values('${user}','New edition')`);
  assert.equal((await query("select delivery_time from sections where name='New edition'"))[0].delivery_time,'04:00:00');
}));
test('untrusted roles cannot invoke scheduling and invalid day arrays fail',()=>isolated(async()=>{
  const [r]=await query("select has_function_privilege('anon','public.queue_due_editions(timestamptz)','execute') as anon,has_function_privilege('authenticated','public.queue_due_editions(timestamptz)','execute') as auth,has_function_privilege('service_role','public.queue_due_editions(timestamptz)','execute') as worker");
  assert.equal(r.anon,false);assert.equal(r.auth,false);assert.equal(r.worker,true);
  await assert.rejects(db.exec("update sections set delivery_days='{}'"),/sections_delivery_days_valid/);
}));
