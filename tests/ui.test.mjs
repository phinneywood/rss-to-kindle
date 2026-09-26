import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).find(s => s.includes('function dashboard'));
const source = script.slice(0, script.lastIndexOf('(async()=>{'));
const fixture = { user: { id: 'user-1', email: 'reader@example.com' }, settings: { onboarding_complete: true, kindle_email: 'example@kindle.com', paused: false, delivery_time: '06:00', timezone: 'UTC', editorial_brief: 'Software, design, history, cities, and excellent long-form essays.' }, sections: [{ id: 's1', name: 'Reading', feeds: [{ id: 'f1', name: 'Example source', url: 'https://example.com/feed', enabled: false }] }, { id: 's2', name: 'Science', feeds: [] }], jobs: [], digests: [] };
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

test('dashboard keeps source actions together and the feed list collapsed by default', async () => {
  const result = await run(`dashboard();const children=[...document.querySelector('.editorial-grid').children],panel=document.querySelector('.sources-panel'),body=document.querySelector('#sources-body'),toggle=document.querySelector('#toggle-sources');return {sideFirst:children[0].classList.contains('dashboard-side'),mainFirstHeading:panel.querySelector('h2').textContent,addInside:!!panel.querySelector('#add-single-feed'),importInside:!!panel.querySelector('#import-opml'),collapsed:body.hidden,expanded:toggle.getAttribute('aria-expanded'),readingList:document.querySelector('#one-time-send').textContent,paused:document.querySelector('.feed').textContent.includes('Paused'),history:!!document.querySelector('#delivery-history'),sectionControls:document.querySelectorAll('.remove-section,.rename-section,#add-section,.section-days-link').length,brief:document.querySelector('#edit-editorial-brief').textContent,label:document.querySelectorAll('.kindle-state')[1].textContent,account:document.querySelector('#account-menu').textContent,more:document.querySelector('#delivery-menu').textContent}`);
  assert.ok(result.sideFirst);assert.equal(result.mainFirstHeading,'Sources');assert.ok(result.addInside&&result.importInside&&result.collapsed);assert.equal(result.expanded,'false');assert.match(result.readingList,/Add articles to the next issue/);assert.ok(result.paused && result.history);assert.equal(result.sectionControls,0);assert.match(result.brief,/Edit brief/);assert.match(result.label,/Address saved/);assert.equal(result.account,'Account');assert.equal(result.more,'More');
});

test('source disclosure expands and collapses without moving add controls',async()=>{
  const result=await run(`dashboard();const panel=document.querySelector('.sources-panel');document.querySelector('#toggle-sources').click();const shown=!document.querySelector('#sources-body').hidden,expanded=document.querySelector('#toggle-sources').getAttribute('aria-expanded');document.querySelector('#toggle-sources').click();return {shown,expanded,collapsed:document.querySelector('#sources-body').hidden,addInside:!!panel.querySelector('#add-single-feed')}`);
  assert.ok(result.shown&&result.collapsed&&result.addInside);assert.equal(result.expanded,'true');
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

test('one-time drafts survive closing and article review becomes a full-screen flow', async () => {
  const result = await run(`oneTimeEditionModal();document.querySelector('#one-time-name').value='Weekend';document.querySelector('#one-time-urls').value='https://example.com/a';document.querySelector('#one-time-form').oninput();closeModal();oneTimeEditionModal();const restored=document.querySelector('#one-time-name').value;oneTimeReview('Weekend',[{status:'ready',title:'Article',url:'https://example.com/a',excerpt:'Readable excerpt',warnings:['Feed version used']}]);const flow=modal.classList.contains('flow');document.querySelector('#edit-one-time').click();return {restored,text:modal.textContent,flow,flowCleared:!modal.classList.contains('flow')}`);
  assert.equal(result.restored, 'Weekend');assert.ok(result.flow && result.flowCleared);assert.match(result.text, /Add selected articles/);
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

test('adding a single feed never asks for or sends a section',async()=>{
  const result=await run(`singleFeedModal();const form=document.querySelector('#single-feed-form');document.querySelector('#single-feed-url').value='https://example.com';let calls=[];api=async(path,options)=>{calls.push({path,body:options.body});if(path==='/discover')return {feeds:[{url:'https://example.com/feed',title:'Example'}]};return state};await form.onsubmit({preventDefault(){},currentTarget:form});return {calls,sectionControl:!!document.querySelector('#single-feed-section')}`);
  assert.equal(result.sectionControl,false);assert.equal(result.calls[1].path,'/feeds');assert.equal(JSON.stringify(result.calls[1].body),JSON.stringify({url:'https://example.com/feed'}));assert.equal('section_id' in result.calls[1].body,false);
});

test('editorial brief saves as an explicit setting and states the RSS invariant',async()=>{
  const result=await run(`dashboard();editorialBriefModal();const form=document.querySelector('#editorial-brief-form');document.querySelector('#editorial-brief').value='Architecture, cities, and deeply reported essays.';let request;api=async(path,options)=>{request={path,body:options.body};state.settings={...state.settings,...options.body};return state};await form.onsubmit({preventDefault(){},currentTarget:form});return {request,text:document.body.textContent}`);
  assert.equal(result.request.path,'/settings');assert.equal(result.request.body.editorial_brief,'Architecture, cities, and deeply reported essays.');assert.match(result.text,/never removes an eligible RSS article/i);
});

test('dashboard has one daily delivery schedule rather than section frequency',async()=>{
  const result=await run(`state.settings.paused=true;dashboard();return {next:document.querySelector('.edition-next').textContent,text:document.body.textContent,sectionDays:document.querySelectorAll('.section-days-link').length}`);
  assert.equal(result.next,'Delivery paused');assert.match(result.text,/One daily issue/);assert.equal(result.sectionDays,0);
});

test('account settings contain the one daily delivery time',async()=>{
  const result=await run(`settingsModal();return {time:!!document.querySelector('[name="delivery_time"]'),zone:!!document.querySelector('[name="timezone"]'),text:modal.textContent}`);
  assert.equal(result.time,true);assert.equal(result.zone,true);assert.match(result.text,/Every enabled source participates/);
});

test('routine primary actions use the publication green while danger and errors retain red',async()=>{
  const css=html.match(/<style>([\s\S]*?)<\/style>/)?.[1]||'';
  assert.match(css,/\.btn\.primary\{background:var\(--green\);border-color:var\(--green\)/);
  assert.match(css,/\.btn\.danger\{color:var\(--red\)/);
  assert.match(css,/\.notice\.error\{background:var\(--red-soft\);color:var\(--red\)/);
});

test('source alerts identify the source without exposing legacy section state',async()=>{
  const result=await run(`state.sections[0].feeds[0].enabled=true;state.sections[0].feeds[0].last_error='HTTP 503';dashboard();const banner=document.querySelector('.problem-banner').textContent;document.querySelector('.problem-banner .review-source').click();const dialog=modal.textContent;closeModal();return {banner,dialog,focus:document.activeElement.id}`);
  assert.match(result.banner,/Example source/);assert.match(result.banner,/Recurring source/);assert.doesNotMatch(result.banner,/Reading section/);assert.match(result.dialog,/HTTP 503/);assert.doesNotMatch(result.dialog,/Reading section/);assert.equal(result.focus,'feed-f1');
});

test('multiple source alerts are independent of legacy section enabled state; paused sources stay historical',async()=>{
  const result=await run(`state.sections[0].feeds[0].last_error='Old failure';state.sections[0].feeds[0].enabled=false;state.sections[1].enabled=false;state.sections[1].feeds=[{id:'f2',name:'Same name',url:'https://example.com/2',enabled:true,last_error:'Timeout'},{id:'f3',name:'Another source',url:'https://example.com/3',enabled:true,last_error:'HTTP 500'}];dashboard();const alerts=[...document.querySelectorAll('.problem-banner li')].map(e=>e.textContent);return {alerts,banner:!!document.querySelector('.problem-banner'),historical:document.querySelector('.feed').textContent}`);
  assert.equal(result.alerts.length,2);assert.match(result.alerts[0],/Same name/);assert.match(result.alerts[1],/Another source/);assert.ok(result.banner);assert.match(result.historical,/source paused/i);
});

test('source review can edit the feed name and URL',async()=>{
  const result=await run(`state.sections[0].feeds[0].enabled=true;state.sections[0].feeds[0].last_error='HTTP 503';dashboard();reviewSource('f1');document.querySelector('#manage-edit').click();document.querySelector('#source-edit-name').value='Fixed source';document.querySelector('#source-edit-url').value='https://example.com/fixed.xml';let request;api=async(path,options)=>{request={path,method:options.method,body:options.body};state.sections[0].feeds[0]={...state.sections[0].feeds[0],...options.body,last_error:null};return state};const form=document.querySelector('#source-edit-form');await form.onsubmit({preventDefault(){},currentTarget:form});return {request,expanded:!document.querySelector('#sources-body').hidden,title:document.querySelector('.feed-title').textContent}`);
  assert.equal(result.request.path,'/feeds/f1');assert.equal(result.request.method,'PATCH');assert.equal(result.request.body.name,'Fixed source');assert.equal(result.request.body.url,'https://example.com/fixed.xml');assert.ok(result.expanded);assert.match(result.title,/Fixed source/);
});

test('source recheck calls only the source endpoint and clears recovered alerts',async()=>{
  const result=await run(`state.sections[0].feeds[0].enabled=true;state.sections[0].feeds[0].last_error='HTTP 503';dashboard();reviewSource('f1');let calls=[];api=async(path,options)=>{calls.push({path,method:options.method});state.sections[0].feeds[0].last_error=null;return {result:{feed_id:'f1',items:[]},dashboard:state}};await document.querySelector('#manage-recheck').onclick({currentTarget:document.querySelector('#manage-recheck')});return {calls,banner:!!document.querySelector('.problem-banner'),message:modal.textContent}`);
  assert.equal(result.calls.length,1);assert.equal(result.calls[0].path,'/feeds/f1/check');assert.equal(result.calls[0].method,'POST');assert.equal(result.banner,false);assert.match(result.message,/warning has been cleared/);
});

test('failed rechecks retain actionable errors and late responses do not reopen dialogs',async()=>{
  const result=await run(`dashboard();feedActionsModal('f1');api=async()=>{throw new Error('Offline')};await recheckSource('f1',document.querySelector('#manage-recheck'));const failure=document.querySelector('#source-check-result').textContent,enabled=!document.querySelector('#manage-recheck').disabled;let resolve;api=()=>new Promise(r=>resolve=r);const pending=recheckSource('f1',document.querySelector('#manage-recheck'));closeModal();openModal('<h2>Other dialog</h2>');resolve({result:{items:[]},dashboard:state});await pending;return {failure,enabled,text:modal.textContent}`);
  assert.match(result.failure,/Offline/);assert.ok(result.enabled);assert.equal(result.text,'Other dialog');
});

test('article preview errors identify their sources and update stale dashboard warnings',async()=>{
  const result=await run(`state.sections[0].feeds[0].enabled=true;dashboard();api=async()=>({items:[],feeds:[{feed_id:'f1',error:'Timed out'}]});await previewModal();const text=modal.textContent,banner=document.querySelector('.problem-banner').textContent;document.querySelector('.notice .review-source').click();const context=modal.textContent;closeModal();api=async()=>({items:[],feeds:[{feed_id:'f1',items:[]}]});await previewModal();return {text,banner,context,cleared:!document.querySelector('.problem-banner')}`);
  assert.match(result.text,/Example source/);assert.doesNotMatch(result.text,/Reading section/);assert.match(result.banner,/Example source/);assert.match(result.context,/Timed out/);assert.ok(result.cleared);
});

test('system health links source errors directly to the source',async()=>{
  const result=await run(`renderSystemHealth({source_issues:[{id:'f1',name:'Example source',last_error:'HTTP 503',consecutive_failures:2}]});const label=document.querySelector('.review-source').textContent;document.querySelector('.review-source').click();return {label,dialog:modal.textContent}`);
  assert.match(result.label,/Example source/);assert.match(result.label,/Recurring source/);assert.match(result.dialog,/Example source/);assert.doesNotMatch(result.dialog,/Reading section/);
});

test('source names and errors are escaped in alert links and dialogs',async()=>{
  const result=await run(`state.sections[0].name='<img src=x onerror=alert(1)>';state.sections[0].feeds[0].name='<script>bad()</script>';state.sections[0].feeds[0].enabled=true;state.sections[0].feeds[0].last_error='<img src=x>';dashboard();reviewSource('f1');return {injected:document.querySelectorAll('#app img,#app script,#modal img,#modal script').length,text:modal.textContent}`);
  assert.equal(result.injected,0);assert.match(result.text,/<script>bad\(\)<\/script>/);
});
