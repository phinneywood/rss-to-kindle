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

test('dashboard is a calm two-surface home with source actions together and the feed list collapsed', async () => {
  const result = await run(`dashboard();const home=document.querySelector('.home-dashboard'),issue=document.querySelector('.issue-card'),library=document.querySelector('.library-card'),body=document.querySelector('#sources-body'),toggle=document.querySelector('#toggle-sources');const homeResult={surfaces:home.children.length,issue:!!issue,heading:library.querySelector('h2').textContent,addInside:!!library.querySelector('#add-single-feed'),importInside:!!library.querySelector('#import-opml'),collapsed:body.hidden,expanded:toggle.getAttribute('aria-expanded'),readingList:document.querySelector('#one-time-send').textContent,paused:document.querySelector('.feed').textContent.includes('Paused'),history:!!document.querySelector('#delivery-history'),sectionControls:document.querySelectorAll('.remove-section,.rename-section,#add-section,.section-days-link').length,preferencesOnHome:!!document.querySelector('.preferences-panel'),account:document.querySelector('#account-menu').textContent,more:document.querySelector('#delivery-menu').textContent,schedule:document.querySelector('.issue-schedule').textContent};accountMenuModal();return {...homeResult,accountMenu:modal.textContent}`);
  assert.equal(result.surfaces,2);assert.ok(result.issue);assert.equal(result.heading,'Sources');assert.ok(result.addInside&&result.importInside&&result.collapsed);assert.equal(result.expanded,'false');assert.match(result.readingList,/Add articles to this issue/);assert.ok(result.paused&&result.history);assert.equal(result.sectionControls,0);assert.equal(result.preferencesOnHome,false);assert.equal(result.account,'Account');assert.equal(result.more,'•••');assert.match(result.schedule,/Daily at 06:00/);assert.match(result.accountMenu,/Editorial brief/);assert.match(result.accountMenu,/Kindle & delivery/);assert.match(result.accountMenu,/System health/);
});

test('source disclosure expands and collapses without moving add controls',async()=>{
  const result=await run(`dashboard();document.querySelector('#toggle-sources').click();const shown=!document.querySelector('#sources-body').hidden,expanded=document.querySelector('#toggle-sources').getAttribute('aria-expanded'),addWhenOpen=!!document.querySelector('.library-card #add-single-feed');document.querySelector('#toggle-sources').click();return {shown,expanded,collapsed:document.querySelector('#sources-body').hidden,addWhenOpen,addWhenClosed:!!document.querySelector('.library-card #add-single-feed')}`);
  assert.ok(result.shown&&result.collapsed&&result.addWhenOpen&&result.addWhenClosed);assert.equal(result.expanded,'true');
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
  const result = await run(`dashboard();openModal('<h2>Queued</h2>');closeModal();api=async()=>({...state,jobs:[{id:'j1',status:'partial',reason:'one_time',packet_name:'Weekend',created_at:'2026-09-19',result:{articles:2}}]});await watchJob('j1');return document.querySelector('.issue-status').textContent`);
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
  const result=await run(`dashboard();editorialBriefModal();const invariant=modal.textContent;const form=document.querySelector('#editorial-brief-form');document.querySelector('#editorial-brief').value='Architecture, cities, and deeply reported essays.';let request;api=async(path,options)=>{request={path,body:options.body};state.settings={...state.settings,...options.body};return state};await form.onsubmit({preventDefault(){},currentTarget:form});return {request,invariant}`);
  assert.equal(result.request.path,'/settings');assert.equal(result.request.body.editorial_brief,'Architecture, cities, and deeply reported essays.');assert.match(result.invariant,/never filters otherwise eligible RSS articles/i);
});

test('dashboard has one daily delivery schedule rather than section frequency',async()=>{
  const result=await run(`state.settings.paused=true;dashboard();return {next:document.querySelector('.issue-time').textContent,schedule:document.querySelector('.issue-schedule').textContent,sectionDays:document.querySelectorAll('.section-days-link').length}`);
  assert.equal(result.next,'Delivery paused');assert.match(result.schedule,/Daily at 06:00/);assert.equal(result.sectionDays,0);
});

test('account settings contain the one daily delivery time',async()=>{
  const result=await run(`settingsModal();return {time:!!document.querySelector('[name="delivery_time"]'),zone:!!document.querySelector('[name="timezone"]'),text:modal.textContent}`);
  assert.equal(result.time,true);assert.equal(result.zone,true);assert.match(result.text,/Every enabled source participates/);
});

test('primary controls are quiet ink while the editorial accent is reserved for hierarchy and attention',async()=>{
  const css=html.match(/<style>([\s\S]*?)<\/style>/)?.[1]||'';
  assert.match(css,/--accent:#cf1f2c/);
  assert.match(css,/\.btn\.primary\{background:var\(--ink\);border-color:var\(--ink\);color:#fff\}/);
  assert.match(css,/\.micro-label\{[\s\S]*?color:var\(--accent\)/);
  assert.match(css,/\.attention-row\{[\s\S]*?background:var\(--accent-soft\)/);
  assert.match(css,/\.notice\.error\{background:var\(--red-soft\);color:var\(--red\)/);
});

test('source attention is contextual inside the library and identifies the source without legacy section state',async()=>{
  const result=await run(`state.sections[0].feeds[0].enabled=true;state.sections[0].feeds[0].last_error='HTTP 503';dashboard();const attention=document.querySelector('.attention-row').textContent,insideLibrary=!!document.querySelector('.library-card .attention-row');document.querySelector('.attention-row').click();const dialog=modal.textContent;closeModal();return {attention,insideLibrary,dialog,focus:document.activeElement.id}`);
  assert.ok(result.insideLibrary);assert.match(result.attention,/1 source needs attention/);assert.match(result.attention,/Example source/);assert.doesNotMatch(result.attention,/Reading section/);assert.match(result.dialog,/HTTP 503/);assert.doesNotMatch(result.dialog,/Reading section/);assert.equal(result.focus,'feed-f1');
});

test('multiple source failures collapse into one attention summary while all sources remain manageable',async()=>{
  const result=await run(`state.sections[0].feeds[0].last_error='Old failure';state.sections[0].feeds[0].enabled=false;state.sections[1].enabled=false;state.sections[1].feeds=[{id:'f2',name:'Same name',url:'https://example.com/2',enabled:true,last_error:'Timeout'},{id:'f3',name:'Another source',url:'https://example.com/3',enabled:true,last_error:'HTTP 500'}];dashboard();const attention=document.querySelector('.attention-row').textContent,allSources=document.querySelector('.sources-list').textContent;return {attention,allSources,historical:document.querySelector('.feed').textContent}`);
  assert.match(result.attention,/2 sources need attention/);assert.match(result.attention,/Same name/);assert.match(result.attention,/\+1 more/);assert.match(result.allSources,/Another source/);assert.match(result.historical,/source paused/i);
});

test('source review can edit the feed name and URL',async()=>{
  const result=await run(`state.sections[0].feeds[0].enabled=true;state.sections[0].feeds[0].last_error='HTTP 503';dashboard();reviewSource('f1');document.querySelector('#manage-edit').click();document.querySelector('#source-edit-name').value='Fixed source';document.querySelector('#source-edit-url').value='https://example.com/fixed.xml';let request;api=async(path,options)=>{request={path,method:options.method,body:options.body};state.sections[0].feeds[0]={...state.sections[0].feeds[0],...options.body,last_error:null};return state};const form=document.querySelector('#source-edit-form');await form.onsubmit({preventDefault(){},currentTarget:form});return {request,expanded:!document.querySelector('#sources-body').hidden,title:document.querySelector('.feed-title').textContent}`);
  assert.equal(result.request.path,'/feeds/f1');assert.equal(result.request.method,'PATCH');assert.equal(result.request.body.name,'Fixed source');assert.equal(result.request.body.url,'https://example.com/fixed.xml');assert.ok(result.expanded);assert.match(result.title,/Fixed source/);
});

test('source recheck calls only the source endpoint and clears recovered attention',async()=>{
  const result=await run(`state.sections[0].feeds[0].enabled=true;state.sections[0].feeds[0].last_error='HTTP 503';dashboard();reviewSource('f1');let calls=[];api=async(path,options)=>{calls.push({path,method:options.method});state.sections[0].feeds[0].last_error=null;return {result:{feed_id:'f1',items:[]},dashboard:state}};await document.querySelector('#manage-recheck').onclick({currentTarget:document.querySelector('#manage-recheck')});return {calls,attention:!!document.querySelector('.attention-row'),message:modal.textContent}`);
  assert.equal(result.calls.length,1);assert.equal(result.calls[0].path,'/feeds/f1/check');assert.equal(result.calls[0].method,'POST');assert.equal(result.attention,false);assert.match(result.message,/warning has been cleared/);
});

test('failed rechecks retain actionable errors and late responses do not reopen dialogs',async()=>{
  const result=await run(`dashboard();feedActionsModal('f1');api=async()=>{throw new Error('Offline')};await recheckSource('f1',document.querySelector('#manage-recheck'));const failure=document.querySelector('#source-check-result').textContent,enabled=!document.querySelector('#manage-recheck').disabled;let resolve;api=()=>new Promise(r=>resolve=r);const pending=recheckSource('f1',document.querySelector('#manage-recheck'));closeModal();openModal('<h2>Other dialog</h2>');resolve({result:{items:[]},dashboard:state});await pending;return {failure,enabled,text:modal.textContent}`);
  assert.match(result.failure,/Offline/);assert.ok(result.enabled);assert.equal(result.text,'Other dialog');
});

test('article preview errors identify their sources and update stale dashboard attention',async()=>{
  const result=await run(`state.sections[0].feeds[0].enabled=true;dashboard();api=async()=>({items:[],feeds:[{feed_id:'f1',error:'Timed out'}]});await previewModal();const text=modal.textContent,attention=document.querySelector('.attention-row').textContent;document.querySelector('.notice .review-source').click();const context=modal.textContent;closeModal();api=async()=>({items:[],feeds:[{feed_id:'f1',items:[]}]});await previewModal();return {text,attention,context,cleared:!document.querySelector('.attention-row')}`);
  assert.match(result.text,/Example source/);assert.doesNotMatch(result.text,/Reading section/);assert.match(result.attention,/Example source/);assert.match(result.context,/Timed out/);assert.ok(result.cleared);
});

test('system health links source errors directly to the source',async()=>{
  const result=await run(`renderSystemHealth({source_issues:[{id:'f1',name:'Example source',last_error:'HTTP 503',consecutive_failures:2}]});const label=document.querySelector('.review-source').textContent;document.querySelector('.review-source').click();return {label,dialog:modal.textContent}`);
  assert.match(result.label,/Example source/);assert.match(result.label,/Recurring source/);assert.match(result.dialog,/Example source/);assert.doesNotMatch(result.dialog,/Reading section/);
});

test('source names and errors are escaped in alert links and dialogs',async()=>{
  const result=await run(`state.sections[0].name='<img src=x onerror=alert(1)>';state.sections[0].feeds[0].name='<script>bad()</script>';state.sections[0].feeds[0].enabled=true;state.sections[0].feeds[0].last_error='<img src=x>';dashboard();reviewSource('f1');return {injected:document.querySelectorAll('#app img,#app script,#modal img,#modal script').length,text:modal.textContent}`);
  assert.equal(result.injected,0);assert.match(result.text,/<script>bad\(\)<\/script>/);
});
