import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const migration=name=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const db=new PGlite();
const user='10000000-0000-0000-0000-000000000001';
const ready=(async()=>{
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(migration('20260917214304_initial_morning_reader_schema.sql').replace(/create extension[^;]+;/,'').replace(/\bcitext\b/g,'text'));
  await db.exec(`insert into app_users(id,email) values('${user}','session-test@example.test');
    insert into sessions(user_id,token_hash,created_at,last_seen_at,expires_at,revoked_at) values
    ('${user}','legacy',now()-interval '20 days',now()-interval '1 day',now()+interval '10 days',null),
    ('${user}','expired',now()-interval '31 days',now()-interval '1 day',now()-interval '1 day',null),
    ('${user}','revoked',now(),now(),now()+interval '30 days',now()),
    ('${user}','delegated',now(),now(),now()+interval '2 minutes',null);`);
  await db.exec(migration('20260919194641_rolling_browser_sessions.sql'));
})();
async function query(sql,params=[]){await ready;return(await db.query(sql,params)).rows;}
async function isolated(work){await ready;await db.exec('begin');try{await work()}finally{await db.exec('rollback')}}
test.after(async()=>{await ready;await db.close()});

test('upgrade preserves valid logins without reviving expired or revoked sessions',async()=>{
  const rows=await query('select token_hash,idle_timeout_seconds,extract(epoch from expires_at-last_seen_at)::integer as seconds from sessions order by token_hash');
  const browser=rows.find(r=>r.token_hash==='legacy');
  assert.equal(browser.idle_timeout_seconds,90*86400);assert.equal(browser.seconds,90*86400);
  for(const row of rows.filter(r=>r.token_hash!=='legacy'))assert.equal(row.idle_timeout_seconds,null);
});
test('authenticated use renews the same device token for 90 days',()=>isolated(async()=>{
  const [before]=await query("select expires_at from sessions where token_hash='legacy'");
  const [result]=await query("select * from authenticate_app_session('legacy')");
  assert.equal(result.user_id,user);assert.equal(result.email,'session-test@example.test');
  const [after]=await query("select expires_at,extract(epoch from expires_at-last_seen_at)::integer as seconds from sessions where token_hash='legacy'");
  assert.ok(after.expires_at>before.expires_at);assert.equal(after.seconds,90*86400);
}));
test('unknown, expired, revoked and exactly-expired sessions cannot authenticate or renew',()=>isolated(async()=>{
  for(const token of ['missing','expired','revoked'])assert.equal((await query('select * from authenticate_app_session($1)',[token])).length,0);
  await db.exec("update sessions set expires_at=statement_timestamp() where token_hash='legacy';");
  assert.equal((await query("select * from authenticate_app_session('legacy')")).length,0);
}));
test('delegated sessions retain their fixed two-minute expiration',()=>isolated(async()=>{
  const [before]=await query("select expires_at from sessions where token_hash='delegated'");
  assert.equal((await query("select * from authenticate_app_session('delegated')")).length,1);
  const [after]=await query("select expires_at from sessions where token_hash='delegated'");
  assert.equal(after.expires_at.getTime(),before.expires_at.getTime());
}));
test('sign-out cannot be undone by another request, and other devices remain valid',()=>isolated(async()=>{
  await db.exec(`insert into sessions(user_id,token_hash,expires_at,idle_timeout_seconds) values('${user}','second-device',now()+interval '90 days',7776000)`);
  await query("select * from authenticate_app_session('legacy')");
  await db.exec("update sessions set revoked_at=now() where token_hash='legacy'");
  assert.equal((await query("select * from authenticate_app_session('legacy')")).length,0);
  assert.equal((await query("select * from authenticate_app_session('second-device')")).length,1);
}));
test('session renewal is restricted to the backend',async()=>{
  const [r]=await query("select has_function_privilege('anon','public.authenticate_app_session(text)','execute') as anon,has_function_privilege('authenticated','public.authenticate_app_session(text)','execute') as auth,has_function_privilege('service_role','public.authenticate_app_session(text)','execute') as backend");
  assert.equal(r.anon,false);assert.equal(r.auth,false);assert.equal(r.backend,true);
});
