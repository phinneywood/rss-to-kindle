/** Read-only verification of the exact frontend files published to production.
 * No account, credentials, form submission, or outgoing email.
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const origin='https://reader.antonioskilton.com';
const out='test-results/production';
await fs.mkdir(out,{recursive:true});
const hash=s=>createHash('sha256').update(s).digest('hex');
const expected={};
for(const [url,file] of [['/','index.html'],['/styles.css','styles.css'],['/opml.js','opml.js'],['/privacy','privacy.html'],['/terms','terms.html']])expected[url]=hash(await fs.readFile(file));
let actual={},matched=false;
for(let attempt=0;attempt<30;attempt++){
 try{
  actual=Object.fromEntries(await Promise.all(Object.keys(expected).map(async path=>{
   const response=await fetch(origin+path,{cache:'no-store',signal:AbortSignal.timeout(10000)});
   assert.equal(response.status,200,path);
   return [path,hash(Buffer.from(await response.arrayBuffer()))];
  })));
  matched=Object.entries(expected).every(([key,value])=>actual[key]===value);
  if(matched)break;
 }catch(error){console.log('Deployment not ready:',String(error));}
 await new Promise(r=>setTimeout(r,4000));
}
assert.ok(matched,'Production must serve the exact committed HTML, CSS, OPML, and legal files');
const browser=await chromium.launch();
const errors=[],screens=[];
try{
 for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:900},isMobile:width<700,hasTouch:width<700,reducedMotion:'reduce'});
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  const response=await page.goto(origin,{waitUntil:'networkidle'});
  assert.equal(response.status(),200);
  await page.locator('#login-submit').waitFor();
  assert.equal(await page.title(),'Long Form');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(247, 245, 240)');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`${out}/${width}-production-sign-in.png`,fullPage:true});
  screens.push({width,url:page.url(),title:await page.title(),status:response.status()});
  await context.close();
 }
}finally{
 await browser.close();
 await fs.writeFile(`${out}/report.json`,JSON.stringify({origin,commit:process.env.GITHUB_SHA,matched,expected,actual,screens,errors},null,2));
}
assert.deepEqual(errors,[]);
console.log('PASS: exact committed frontend files served over production HTTPS; mobile and desktop sign-in render without runtime errors.');
