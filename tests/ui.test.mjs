import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).find(s => s.includes('function dashboard'));
const source = script.slice(0, script.lastIndexOf('(async()=>{'));
const fixture = { user: { id: 'user-1', email: 'reader@example.com' }, settings: { onboarding_complete: true, kindle_email: 'example@kindle.com', paused: false, delivery_time: '06:00', timezone: 'UTC' }, sections: [{ id: 's1', name: 'Reading', feeds: [{ id: 'f1', name: 'Example source', url: 'https://example.com/feed', enabled: false }] }, { id: 's2', name: 'Science', feeds: [] }], jobs: [], digests: [] };
async function run(code) {
  const w = new Window({ url: 'https://reader.antonioskilton.com' });
  w.document.body.innerHTML = '<div id="app"></div><div id="modal"></div><div id="toast"></div>';
  w.eval(readFileSync(new URL('../starter-editions.js', import.meta.url), 'utf8'));
  try { return await w.eval(source + `\nstate=${JSON.stringify(fixture)};token='test-token';(async()=>{${code}})()`); }
  finally { await w.happyDOM.abort(); }
}

test('email-only sign-in has an explicit heading and button', async () => {
  const result = await run(`landing();return [document.querySelector('.auth-form-section h2').textContent,document.querySelector('#login-submit').textContent]`);
  assert.equal(result[0], 'Sign in with email.');assert.equal(result[1], 'Send code');
});

test('opening and reloading a saved session restores the dashboard without a code',async()=>{
  const result=await run(`localStorage.morningReaderToken=token;let calls=0;fetch=async()=>{calls++;return new Response(JSON.stringify(state),{status:200})};await startApp();await startApp();return {calls,saved:localStorage.morningReaderToken,dashboard:!!document.querySelector('#one-time-send')}`);
  assert.equal(result.calls,2);assert.equal(result.saved,'test-token');assert.ok(result.dashboard);
});

test('network and server failures retain the token, and Retry restores the dashboard',async()=>{
  for(const failure of ['throw new TypeError("Failed to fetch")','return new Response("Temporary outage",{status:503})']){
    const result=await run(`localStorage.morningReaderToken=token;fetch=async()=>{${failure}};await startApp();const saved=localStorage.morningReaderToken,notice=app.textContent,retry=document.querySelector('#retry-session');fetch=async()=>new Response(JSON.stringify(state),{status:200});await retry.onclick({currentTarget:retry});return {saved,notice,dashboard:!!document.querySelector('#one-time-send')}`);
    assert.equal(result.saved,'test-token');assert.match(result.notice,/Your sign-in is saved/);assert.ok(result.dashboard);
  }
});

test('a confirmed expired or revoked session clears the token and requests sign-in',async()=>{
  const result=await run(`localStorage.morningReaderToken=token;fetch=async()=>new Response(JSON.stringify({error:'Unauthorized'}),{status:401});await startApp();return {saved:localStorage.getItem('morningReaderToken'),signedOut:state===null,login:!!document.querySelector('#login-submit'),notice:app.textContent}`);
  assert.equal(result.saved,null);assert.ok(result.signedOut&&result.login);assert.match(result.notice,/Your session has ended/);
});

test('explicit sign-out clears credentials only after server revocation succeeds',async()=>{
  const result=await run(`localStorage.morningReaderToken=token;dashboard();fetch=async()=>new Response('{}',{status:503});await signOut();const retained=localStorage.morningReaderToken,message=toastEl.textContent;fetch=async()=>new Response('{}',{status:200});await signOut();return {retained,message,saved:localStorage.getItem('morningReaderToken'),login:!!document.querySelector('#login-submit')}`);
  assert.equal(result.retained,'test-token');assert.match(result.message,/Could not sign out/);assert.equal(result.saved,null);assert.ok(result.login);
});

test('one-time sending, history, paused sources and removal are discoverable', async () => {
  const result = await run(`expandedSections.add('s1');dashboard();return {first:document.querySelector('.source-index-action').id,paused:document.querySelector('.feed').textContent.includes('Paused'),history:!!document.querySelector('#delivery-history'),remove:!!document.querySelector('.remove-section'),label:document.querySelector('.kindle-state').textContent}`);
  assert.equal(result.first, 'one-time-send');assert.ok(result.paused && result.history && result.remove);assert.match(result.label, /Address saved/);
});

test('dialogs manage focus, trap Tab, restore focus and close on Escape', async () => {
  const result = await run(`dashboard();const trigger=document.querySelector('#one-time-send');trigger.focus();openModal('<h2>Dialog</h2><button id="first">First</button><button id="last">Last</button>');const card=modal.querySelector('.modal-card');const role=card.getAttribute('role'),aria=card.getAttribute('aria-modal'),focused=document.activeElement===card;document.querySelector('#last').focus();modal.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));const trapped=document.activeElement.id==='first';modal.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return {role,aria,focused,trapped,closed:!modal.classList.contains('open'),restored:document.activeElement===trigger}`);
  assert.equal(result.role, 'dialog');assert.equal(result.aria, 'true');assert.ok(result.focused && result.trapped && result.closed && result.restored);
});

test('closing or replacing headline browser safely ignores late responses', async () => {
  const result = await run(`let resolve;api=()=>new Promise(r=>resolve=r);const pending=previewModal();closeModal();openModal('<h2>Different dialog</h2>');resolve({items:[]});await pending;return modal.textContent`);
  assert.equal(result, 'Different dialog');
});

test('closing one-time review while loading never reopens it', async () => {
  const result = await run(`let resolve;api=()=>new Promise(r=>resolve=r);oneTimeEditionModal({name:'Weekend',urls:'https://example.com/a'});const form=document.querySelector('#one-time-form');const pending=form.onsubmit({preventDefault(){},currentTarget:form});closeModal();resolve({name:'Weekend',items:[]});await pending;return !modal.classList.contains('open')`);
  assert.ok(result);
});

test('one-time drafts survive closing and review shows excerpts and warnings', async () => {
  const result = await run(`oneTimeEditionModal();document.querySelector('#one-time-name').value='Weekend';document.querySelector('#one-time-urls').value='https://example.com/a';document.querySelector('#one-time-form').oninput();closeModal();oneTimeEditionModal();const restored=document.querySelector('#one-time-name').value;oneTimeReview('Weekend',[{status:'ready',title:'Article',url:'https://example.com/a',excerpt:'Readable excerpt',warnings:['Feed version used']}]);return {restored,text:modal.textContent}`);
  assert.equal(result.restored, 'Weekend');assert.match(result.text, /Readable excerpt/);assert.match(result.text, /Feed version used/);assert.match(result.text, /not the final EPUB/);
});

test('new one-time users can save an address without scheduling or a test send', async () => {
  const result = await run(`state.settings.kindle_email=null;state.settings.onboarding_complete=false;oneTimeEditionModal();document.querySelector('#packet-kindle-email').value='new@kindle.com';let calls=[];api=async(path,options)=>{calls.push({path,body:options.body});state.settings={...state.settings,...options.body};return state};const form=document.querySelector('#one-time-kindle');await form.onsubmit({preventDefault(){},currentTarget:form});return {calls,articleForm:!!document.querySelector('#one-time-form')}`);
  assert.equal(result.calls.length, 1);assert.equal(result.calls[0].path, '/settings');assert.equal(result.calls[0].body.paused, true);assert.ok(result.articleForm);
});

test('Send now button restores on success and failure', async () => {
  const result = await run(`dashboard();watchJob=async()=>{};api=async()=>({job:{id:'j1'}});await queueSend('/send-now','Queued');closeModal();const success=!document.querySelector('#send-now').disabled;api=async()=>{throw new Error('Offline')};await queueSend('/send-now','Queued');return {success,failure:!document.querySelector('#send-now').disabled,text:document.querySelector('#send-now').textContent}`);
  assert.ok(result.success && result.failure);assert.equal(result.text, 'Send now');
});

test('background polling refreshes the dashboard after the dialog closes', async () => {
  const result = await run(`dashboard();openModal('<h2>Queued</h2>');closeModal();api=async()=>({...state,jobs:[{id:'j1',status:'partial',reason:'one_time',packet_name:'Weekend',created_at:'2026-09-19',result:{articles:2}}]});await watchJob('j1');return document.querySelector('.latest-run').textContent`);
  assert.match(result, /Submitted with omissions/);
});

test('history lists omissions and creates a newly reviewed resend', async () => {
  const result = await run(`state.jobs=[{id:'j1',status:'partial',reason:'one_time',packet_name:'Weekend',article_urls:['https://example.com/a'],created_at:'2026-09-19',result:{articles:1,issues:['An image was omitted']}}];api=async()=>state;await historyModal();const visible=modal.textContent.includes('An image was omitted');document.querySelector('.resend-packet').click();return {visible,name:document.querySelector('#one-time-name').value,request:oneTimeDraft.request_id}`);
  assert.ok(result.visible);assert.equal(result.name, 'Weekend');assert.match(result.request, /^[a-f0-9-]{36}$/);
});

test('unsafe feed links cannot inject active URLs', async () => {
  assert.equal(await run(`return safeHref('javascript:alert(1)')`), '#');
});

test('section frequency saves selected weekdays without a separate delivery time', async () => {
  const result=await run(`sectionDaysModal('s1');const form=document.querySelector('#section-days-form');form.querySelectorAll('[name="delivery_days"]').forEach(c=>c.checked=c.value==='1'||c.value==='5');let request;api=async(path,options)=>{request={path,body:options.body};return state};await form.onsubmit({preventDefault(){},currentTarget:form});return request`);
  assert.equal(result.path,'/sections/s1');assert.deepEqual([...result.body.delivery_days],[1,5]);assert.equal(result.body.delivery_time,undefined);
});
test('empty section weekday selection prevents saving',async()=>{
  const result=await run(`sectionDaysModal('s1');const form=document.querySelector('#section-days-form');form.querySelectorAll('[name="delivery_days"]').forEach(c=>c.checked=false);let calls=0;api=async()=>{calls++;return state};await form.onsubmit({preventDefault(){},currentTarget:form});return {calls,notice:document.querySelector('#schedule-error').textContent}`);
  assert.equal(result.calls,0);assert.match(result.notice,/at least one/);
});
test('dashboard presents one daily issue and section frequency',async()=>{
  const result=await run(`state.sections[0].delivery_days=[1,2,3,4,5];state.settings.paused=true;dashboard();return {label:document.querySelector('.section-days-link').textContent,next:document.querySelector('.edition-next').textContent,text:document.body.textContent}`);
  assert.match(result.label,/Weekdays only/);assert.equal(result.next,'Delivery paused');assert.match(result.text,/Your sections/);
});
test('account settings contain the one daily delivery time',async()=>{
  const result=await run(`settingsModal();return {time:!!document.querySelector('[name="delivery_time"]'),zone:!!document.querySelector('[name="timezone"]')}`);
  assert.equal(result.time,true);assert.equal(result.zone,true);
});
