/** Real-browser regression evidence. Every app API request is intercepted.
 * Never uses a production account or sends real email.
 * npm install --no-save --package-lock=false playwright@1.56.1 @axe-core/playwright@4.10.2
 * npx playwright install chromium webkit
 * BROWSER=chromium node tests/browser.mjs
 */
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const reader={user:{id:'visual-reader',email:'reader@example.com'},settings:{onboarding_complete:true,kindle_email:'reader_sample@kindle.com',paused:false,delivery_time:'06:00',timezone:'America/Los_Angeles',next_run_at:'2026-09-27T13:00:00Z',editorial_brief:'Ideas, science, and the art of paying attention. Writing that rewards a slower read.',editorial_instructions:'Favor original thinking and deeply reported essays. Give unfamiliar ideas room to breathe.'},sources:[
 {id:'f1',name:'Aeon',url:'https://aeon.co/feed.rss',enabled:true},
 {id:'f2',name:'Quanta Magazine',url:'https://www.quantamagazine.org/feed/',enabled:true},
 {id:'f3',name:'The Marginalian',url:'https://www.themarginalian.org/feed/',enabled:true},
 {id:'f4',name:'Works in Progress',url:'https://worksinprogress.co/feed/',enabled:true},
 {id:'f5',name:'A publication with a very long name & a paused subscription',url:'https://example.com/a-long-address/with-a-very-long-feed-name.xml',enabled:false}],sections:[],jobs:[
 {id:'job-latest',status:'sent',reason:'scheduled',created_at:'2026-09-26T13:00:00Z',finished_at:'2026-09-26T13:01:00Z',result:{articles:12}},
 {id:'job-partial',status:'partial',reason:'one_time',packet_name:'The weekend reader',created_at:'2026-09-25T13:00:00Z',finished_at:'2026-09-25T13:02:00Z',article_urls:['https://example.com/attention'],result:{articles:3,issues:['One publisher image could not be included.']}},
 {id:'job-empty',status:'empty',reason:'scheduled',created_at:'2026-09-24T13:00:00Z',result:{articles:0}}],digests:[]};
const articles=[
 {title:'The quiet work of paying attention',url:'https://example.com/attention',source:'Aeon',published_at:'2026-09-25T12:00:00Z'},
 {title:'What a forest knows about time',url:'https://example.com/forest',source:'Quanta Magazine',published_at:'2026-09-24T12:00:00Z'},
 {title:'A small argument for the unfinished',url:'https://example.com/unfinished',source:'The Marginalian',published_at:'2026-09-23T12:00:00Z'}];
const reviewed=articles.map(a=>({...a,status:'ready',excerpt:'There is another way to look at the familiar. This essay follows a patient line of inquiry through everyday life, and asks what becomes visible when we stop rushing to the answer.',warnings:[]}));
const health={window_hours:24,delivery:{success_rate:100,articles_delivered:12,median_duration_ms:48200},feeds:{healthy:4,total:5},alerts:[{severity:'warning',message:'One source needs attention.'}],recent_jobs:reader.jobs,source_issues:[{id:'f2',name:'Quanta Magazine',consecutive_failures:2,last_fetch_at:'2026-09-26T13:00:00Z',last_error:'HTTP 503 — the publisher is temporarily unavailable.'}]};
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const engine=process.env.BROWSER||'chromium';
const out=process.env.REVIEW_DIR||path.join(root,'test-results',engine);
await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 const files={'/':'index.html','/styles.css':'styles.css','/opml.js':'opml.js','/starter-editions.js':'starter-editions.js','/privacy':'privacy.html','/terms':'terms.html'};
 const file=files[pathname];
 if(!file){res.writeHead(404);res.end();return;}
 try{const text=await fs.readFile(path.join(root,file));res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html');res.end(text);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await (engine==='webkit'?webkit:chromium).launch();
const results=[],failures=[],errors=[];
let page;
const widths=process.env.WIDTHS?process.env.WIDTHS.split(',').map(Number):[320,390,768,1440];
async function capture(name,width){
 // Fixed sheets must be captured in the viewport, not stretched over a scrolled page.
 const card=page.locator('.modal-card');
 if(await card.count())await card.evaluate(e=>e.scrollTop=0);
 await page.mouse.move(1,1);
 await page.screenshot({path:path.join(out,`${width}-${name}.png`),fullPage:!(await page.locator('#modal').isVisible())});
 const overflow=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>{
  if(e.closest('[hidden]')||e.closest('#app[inert]')||getComputedStyle(e).display==='none'||!e.getClientRects().length||e.classList.contains('skip-link'))return false;
  const r=e.getBoundingClientRect();return r.right>innerWidth+1||r.left<-1;
 }).map(e=>({tag:e.tagName,class:e.className,text:e.textContent.slice(0,65),width:e.getBoundingClientRect().width})));
 const violations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));
 results.push({name,width,overflow,violations});
 if(overflow.length||violations.length)failures.push({name,width,overflow,violations});
 if(await card.count()){
  const scrolls=await card.evaluate(e=>e.scrollHeight>e.clientHeight+1);
  if(scrolls){await card.evaluate(e=>e.scrollTop=e.scrollHeight);await page.screenshot({path:path.join(out,`${width}-${name}-bottom.png`),fullPage:false});await card.evaluate(e=>e.scrollTop=0);}
 }
}
async function home(){await page.evaluate(data=>{closeModal(true);state=structuredClone(data);sourcesExpanded=false;dashboard();window.scrollTo(0,0);},reader);}
try{
 for(const width of widths){
  const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,isMobile:width<700,hasTouch:width<1100,reducedMotion:'reduce',timezoneId:'America/Los_Angeles'});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin===base)return route.continue();
   if(!url.pathname.includes('/functions/v1/app-api'))return route.abort();
   const endpoint=url.pathname.split('/app-api')[1],method=route.request().method();
   let payload=structuredClone(reader);
   if(endpoint==='/auth/request-code')payload={};
   else if(endpoint==='/auth/verify-code')payload={...payload,token:'synthetic-session'};
   else if(endpoint==='/preview')payload={items:articles,feeds:[]};
   else if(endpoint==='/system')payload=health;
   else if(endpoint==='/discover')payload={feeds:[{title:'A discovered publication',url:'https://example.com/feed.xml'}]};
   else if(endpoint==='/one-time/preview')payload={name:'Weekend reading',items:reviewed};
   else if(endpoint==='/settings'&&method==='PATCH')payload.settings={...payload.settings,...route.request().postDataJSON()};
   else if(endpoint.startsWith('/feeds/')&&method==='PATCH'){const i=payload.sources.findIndex(s=>s.id===endpoint.split('/').at(-1));assert.ok(i>=0);payload.sources[i]={...payload.sources[i],...route.request().postDataJSON()};}
   await route.fulfill({contentType:'application/json',body:JSON.stringify(payload)});
  });
  await page.goto(base);await page.locator('#login-submit').waitFor();await capture('sign-in',width);
  await page.locator('#email').fill('reader@example.com');await page.locator('#login-submit').click();await page.locator('#code').waitFor();await capture('verification',width);
  await page.locator('#code').fill('123456');await page.locator('#verify-form .primary').click();await page.locator('#send-now').waitFor();
  assert.equal(await page.locator('.home-dashboard > section').count(),3);await capture('home',width);
  await page.locator('#toggle-sources').click();assert.equal(await page.locator('#toggle-sources').getAttribute('aria-expanded'),'true');await capture('sources',width);
  await home();await page.evaluate(()=>{state.sources[1].last_error='HTTP 503 — the publisher is temporarily unavailable.';dashboard();});await capture('source-attention',width);
  await page.locator('.attention-row').click();await capture('source-management',width);
  await page.locator('#manage-edit').click();await capture('source-edit',width);
  await page.locator('#source-edit-name').fill('A renamed publication');await page.locator('#source-edit-submit').click();await page.locator('#modal').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>state.sources.find(s=>s.id==='f2').name),'A renamed publication');await page.locator('#toast').waitFor({state:'hidden'});
  await home();await page.locator('#add-single-feed').click();await capture('add-source',width);
  await home();await page.locator('#import-opml').click();await capture('opml',width);
  await page.locator('#opml-file').setInputFiles({name:'subscriptions.opml',mimeType:'text/xml',buffer:Buffer.from('<opml><body><outline text="Science"><outline text="Quanta Magazine" xmlUrl="https://www.quantamagazine.org/feed/"/><outline text="Aeon" xmlUrl="https://aeon.co/feed.rss"/></outline></body></opml>')});
  await page.getByRole('heading',{name:'Review OPML import'}).waitFor();await capture('opml-review',width);
  await home();await page.locator('#open-editor').click();assert.equal(await page.locator('#app').evaluate(e=>e.inert),true);await capture('editor',width);
  await page.locator('.editor-effective summary').click();await capture('editor-instructions',width);
  await page.locator('#editorial-brief').fill('History, science, and ideas that reward attention.');await page.locator('.editor-form-actions button').click();await page.locator('#modal').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>state.settings.editorial_brief),'History, science, and ideas that reward attention.');await page.locator('#toast').waitFor({state:'hidden'});
  await home();await page.locator('#preview').click();await page.locator('.preview-list').waitFor();await capture('articles',width);
  await home();await page.locator('#delivery-history').click();await page.locator('#refresh-history').waitFor();await capture('history',width);
  await home();await page.locator('#one-time-send').click();await capture('reading-list',width);
  await page.locator('#one-time-name').fill('Weekend reading');await page.locator('#one-time-urls').fill('https://example.com/attention');await page.locator('#review-one-time').click();await page.locator('.one-time-list').waitFor();await capture('reading-review',width);
  await home();await page.locator('#account-menu').click();await capture('account',width);
  await page.locator('#account-kindle').click();await capture('kindle',width);
  await page.locator('#kindle-edit-settings').click();await capture('settings',width);
  await home();await page.locator('#account-menu').click();await page.locator('#account-system-health').click();await page.locator('.system-metrics').waitFor();await capture('system-health',width);
  await home();await page.evaluate(()=>{state.settings.onboarding_complete=false;state.sources=[];starterPicker();});await capture('starter-packs',width);
  await page.evaluate(()=>starterReady(STARTER_EDITIONS[0],{added:5}));await capture('starter-ready',width);
  await page.evaluate(()=>onboarding());await capture('onboarding',width);
  await home();await page.evaluate(()=>{state.sources=[];state.jobs=[];state.settings.editorial_brief='';state.settings.editorial_instructions='';dashboard();});await capture('empty-home',width);
  await home();await page.evaluate(()=>{state.settings.paused=true;dashboard();});await capture('paused-home',width);
  await home();await page.evaluate(()=>{state.settings.onboarding_complete=false;state.settings.kindle_email='';dashboard();});await capture('setup-needed',width);
  await home();await page.evaluate(()=>sessionUnavailable());await capture('session-error',width);
  await home();await page.evaluate(()=>openModal('<h2>Latest articles</h2><p class="loading-state" role="status">Checking your active feeds…</p><button class="btn" onclick="closeModal()">Close</button>'));await capture('loading',width);
  await home();await page.evaluate(()=>{api=async()=>{throw new Error('The publisher is not responding. Please try again.')};return previewModal();});await capture('preview-error',width);
  await page.goto(base+'/privacy');await capture('privacy',width);await page.goto(base+'/terms');await capture('terms',width);
  await page.goto(base);await page.locator('#open-editor').waitFor();
  const targets=await page.locator('button').evaluateAll(es=>es.filter(e=>!e.closest('[hidden]')&&e.getClientRects().length).map(e=>({id:e.id,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})));
  assert.deepEqual(targets.filter(e=>e.w<43.5||e.h<43.5),[],`Home targets below 44px at ${width}`);
  await page.locator('#open-editor').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.modal-card').evaluate(e=>document.activeElement===e),true);
  await page.keyboard.press('Shift+Tab');assert.equal(await page.locator('.editor-form-actions button').evaluate(e=>document.activeElement===e),true);
  await page.keyboard.press('Tab');assert.equal(await page.locator('#close-modal').evaluate(e=>document.activeElement===e),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#open-editor').evaluate(e=>document.activeElement===e),true);
  assert.equal(await page.evaluate(()=>document.body.classList.contains('dialog-open')),false);
  console.log(`${engine} ${width}px: ${results.filter(r=>r.width===width).length} states; ${failures.filter(r=>r.width===width).length} failed checks`);
  await context.close();
 }
}catch(error){
 if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure-viewport.png')}).catch(()=>{});
 errors.push(String(error));throw error;
}finally{
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({engine,results,failures,errors},null,2));
 await browser.close();await new Promise(r=>server.close(r));
}
assert.deepEqual(errors,[],'Browser runtime errors');
assert.equal(failures.length,0,JSON.stringify(failures,null,2));
console.log(`PASS: ${results.length} states; no automated WCAG A/AA violations or horizontal overflow; keyboard/focus and 44px home targets verified.`);
