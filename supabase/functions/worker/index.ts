import { createClient } from "npm:@supabase/supabase-js@2";
import { XMLParser } from "npm:fast-xml-parser@4.5.0";
import JSZip from "npm:jszip@3.10.1";
import sanitizeHtml from "npm:sanitize-html@2.17.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", cdataPropName: "__cdata" });
const cors = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: cors }); }
function arr<T = any>(x: T | T[] | null | undefined): T[] { return x == null ? [] : Array.isArray(x) ? x : [x]; }
function txt(x: any): string {
  if (x == null) return "";
  if (typeof x === "string" || typeof x === "number") return String(x);
  if (typeof x === "object") { if ("__cdata" in x) return txt(x.__cdata); if ("#text" in x) return txt(x["#text"]); }
  return "";
}
function href(x: any): string {
  if (typeof x === "string") return x;
  for (const v of arr(x)) {
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && v["@_href"] && (!v["@_rel"] || v["@_rel"] === "alternate")) return String(v["@_href"]);
  }
  return "";
}
function stripTracking(u: string): string {
  try {
    const x = new URL(u); x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(k)) x.searchParams.delete(k);
    return x.toString();
  } catch { return u.split("#")[0]; }
}
async function sha256(s: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(b).map(v => v.toString(16).padStart(2, "0")).join("");
}
function isPrivateV4(ip: string) {
  const p = ip.split(".").map(Number); if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b] = p; return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}
function isPrivateV6(ip: string) { const x = ip.toLowerCase(); return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb"); }
async function assertPublic(url: URL) {
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only public http(s) URLs are allowed.");
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || isPrivateV4(h) || isPrivateV6(h)) throw new Error("Private network URLs are not allowed.");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(h) && !h.includes(":")) {
    const ips = [...await Deno.resolveDns(h, "A").catch(() => []), ...await Deno.resolveDns(h, "AAAA").catch(() => [])];
    if (!ips.length || ips.some((ip: string) => isPrivateV4(ip) || isPrivateV6(ip))) throw new Error("Feed host did not resolve to a public address.");
  }
}
async function safeFetch(input: string, init: RequestInit = {}, maxBytes = 2_500_000): Promise<{response:Response,text:string,url:string}> {
  let url = new URL(input); let response: Response | null = null;
  for (let i=0;i<5;i++) {
    await assertPublic(url);
    const c = new AbortController(); const timer = setTimeout(() => c.abort(), 12_000);
    try { response = await fetch(url, { ...init, signal: c.signal, redirect: "manual", headers: { "User-Agent":"MorningReader/1.0 (+https://morning-reader.vercel.app)", ...(init.headers||{}) } }); }
    finally { clearTimeout(timer); }
    if ([301,302,303,307,308].includes(response.status)) { const l = response.headers.get("location"); if (!l) break; url = new URL(l, url); continue; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = (await response.text()).slice(0,maxBytes); return { response, text, url: url.toString() };
  }
  throw new Error("Too many redirects.");
}
function cleanHtml(html: string) {
  return sanitizeHtml(html || "", {
    allowedTags: ["p","br","h1","h2","h3","h4","blockquote","pre","code","ul","ol","li","strong","b","em","i","a","hr","sup","sub"],
    allowedAttributes: { a:["href"] }, allowedSchemes:["http","https"],
    transformTags: { div:"p", section:"p", article:"p", img:() => ({tagName:"span",text:""}) } as any,
  }).replace(/<p>\s*<\/p>/g, "").trim();
}
function plainLen(html:string){return cleanHtml(html).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().length}
function normText(s:string){return s.replace(/<[^>]+>/g," ").replace(/&amp;/gi,"&").replace(/&#39;/g,"'").replace(/&quot;/gi,'"').replace(/\s+/g," ").trim().toLowerCase()}
function stripDuplicateTitle(html:string,title:string){
  const target=normText(title); if(!target)return html;
  let removed=false;
  return html.replace(/<(h[1-4]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi,(full,_tag,inner,offset)=>{
    if(removed||offset>2500)return full;
    const candidate=normText(inner);
    const close=candidate===target||(candidate.length>12&&target.length>12&&(candidate.startsWith(target)||target.startsWith(candidate))&&Math.abs(candidate.length-target.length)<12);
    if(close){removed=true;return ""}
    return full;
  }).trim();
}
async function pageBody(url:string) {
  const {text} = await safeFetch(url, {headers:{Accept:"text/html,application/xhtml+xml"}}, 2_500_000);
  let html = text.replace(/<script\b[\s\S]*?<\/script>/gi,"").replace(/<style\b[\s\S]*?<\/style>/gi,"").replace(/<(nav|aside|footer|header|form)\b[\s\S]*?<\/\1>/gi,"");
  const m = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) || html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) || html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return cleanHtml(m?.[1] || "");
}
function contentOf(e:any){ return txt(e["content:encoded"] || e.content || e.description || e.summary || ""); }
function dateOf(e:any) { const raw = txt(e.pubDate || e.published || e.updated || e["dc:date"]); if (!raw) return null; const d = new Date(raw); return isNaN(+d)?null:d.toISOString(); }
async function readFeed(feed:any, cutoff:Date) {
  try {
    const {text} = await safeFetch(feed.url, {headers:{Accept:"application/rss+xml, application/atom+xml, application/xml, text/xml, */*"}}, 2_000_000);
    const d:any = parser.parse(text); let entries:any[]=[];
    if(d?.rss?.channel?.item) entries=arr(d.rss.channel.item); else if(d?.feed?.entry) entries=arr(d.feed.entry); else if(d?.["rdf:RDF"]?.item) entries=arr(d["rdf:RDF"].item);
    const out:any[]=[];
    for(const e of entries.slice(0,40)) {
      const url=stripTracking(href(e.link)||txt(e.guid||e.id)); if(!url) continue;
      const published_at=dateOf(e); if(published_at && new Date(published_at)<cutoff) continue;
      const title=txt(e.title).replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim()||"Untitled";
      let body=cleanHtml(contentOf(e));
      if(plainLen(body)<500){ try{ const full=await pageBody(url); if(plainLen(full)>plainLen(body))body=full; }catch{/* excerpt fallback */} }
      body=stripDuplicateTitle(body,title);
      if(!body) body = "<p>Article text was not available in the feed. Use the original article link below.</p>";
      out.push({feed_id:feed.id,section_id:feed.section_id,source:feed.name,title,url,canonical_url:url,published_at,body,article_hash:await sha256(url)});
    }
    await admin.from("feeds").update({last_fetch_at:new Date().toISOString(),last_error:null}).eq("id",feed.id);
    return out;
  } catch(e) {
    const m=e instanceof Error?e.message:String(e); await admin.from("feeds").update({last_fetch_at:new Date().toISOString(),last_error:m.slice(0,500)}).eq("id",feed.id); return [];
  }
}
function esc(s:string){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function slug(s:string){return s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,50)||"reading"}
async function makeEpub(section:any, items:any[], displayDate:string) {
  const zip=new JSZip(); zip.file("mimetype","application/epub+zip",{compression:"STORE"});
  zip.folder("META-INF")!.file("container.xml",`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const o=zip.folder("OEBPS")!; const bookId=crypto.randomUUID();
  const sourceCount=new Set(items.map((x:any)=>x.source)).size;

  function coverLines(value:string){
    const words=value.trim().split(/\s+/).filter(Boolean), lines:string[]=[]; let line="";
    const max=18;
    for(const word of words){
      const candidate=line?line+" "+word:word;
      if(candidate.length>max&&line){lines.push(line);line=word}else line=candidate;
    }
    if(line)lines.push(line);
    if(lines.length>5)return [lines.slice(0,4).join(" "),lines.slice(4).join(" ")].filter(Boolean);
    return lines;
  }
  const lines=coverLines(section.name);
  const fontSize=lines.length<=2?112:lines.length===3?94:78;
  const startY=560-(lines.length-1)*(fontSize*.62);
  const titleTspans=lines.map((line:string,i:number)=>`<tspan x="92" y="${Math.round(startY+i*fontSize*1.06)}">${esc(line)}</tspan>`).join("");
  const coverSvg=`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">
  <rect width="1200" height="1600" fill="#f4efe5"/>
  <circle cx="108" cy="112" r="26" fill="none" stroke="#174f3c" stroke-width="5"/>
  <text x="154" y="128" font-family="Arial,Helvetica,sans-serif" font-size="38" font-weight="700" fill="#174f3c" letter-spacing="3">MORNING READER</text>
  <line x1="92" y1="196" x2="1108" y2="196" stroke="#d8cfbf" stroke-width="3"/>
  <text font-family="Georgia,serif" font-size="${fontSize}" font-weight="700" fill="#1e1b17">${titleTspans}</text>
  <text x="92" y="1115" font-family="Arial,Helvetica,sans-serif" font-size="34" fill="#71695e">${esc(displayDate)}</text>
  <text x="92" y="1174" font-family="Arial,Helvetica,sans-serif" font-size="29" fill="#71695e">${items.length} article${items.length===1?"":"s"} · ${sourceCount} source${sourceCount===1?"":"s"}</text>
  <line x1="92" y1="1382" x2="1108" y2="1382" stroke="#d8cfbf" stroke-width="3"/>
  <text x="92" y="1450" font-family="Arial,Helvetica,sans-serif" font-size="27" font-weight="700" fill="#174f3c">Compiled by Morning Reader</text>
  <text x="92" y="1494" font-family="Arial,Helvetica,sans-serif" font-size="24" fill="#71695e">reader.antonioskilton.com</text>
</svg>`;
  o.file("cover.svg",coverSvg);

  const nav=`<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(section.name)}</title><link rel="stylesheet" href="style.css"/></head><body><h1>${esc(section.name)}</h1><p class="date">${esc(displayDate)}</p><ol>${items.map((a:any,i:number)=>`<li><a href="article-${i+1}.xhtml">${esc(a.title)}</a><span class="source">${esc(a.source)}</span></li>`).join("")}</ol></body></html>`;
  o.file("nav.xhtml",nav);
  o.file("style.css",`body{font-family:serif;line-height:1.55;margin:5%;color:#171717}h1,h2,h3{line-height:1.18}.date,.source,.meta{color:#666;font-size:.9em}.source{display:block;margin:.2em 0 1em}a{color:#111}pre{white-space:pre-wrap}blockquote{margin-left:1em;border-left:2px solid #aaa;padding-left:1em}`);
  const manifest=[
    `<item id="cover-image" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>`,
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`
  ];
  const spine=[`<itemref idref="nav"/>`];
  items.forEach((a:any,i:number)=>{
    const id=`a${i+1}`,file=`article-${i+1}.xhtml`;
    manifest.push(`<item id="${id}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    const date=a.published_at?new Intl.DateTimeFormat("en-US",{dateStyle:"medium"}).format(new Date(a.published_at)):"";
    o.file(file,`<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(a.title)}</title><link rel="stylesheet" href="style.css"/></head><body><p><a href="nav.xhtml">Contents</a></p><h1>${esc(a.title)}</h1><p class="meta">${esc(a.source)}${date?` · ${esc(date)}`:""}</p>${a.body}<hr/><p><a href="${esc(a.url)}">Original article</a></p></body></html>`);
  });
  o.file("content.opf",`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:${bookId}</dc:identifier><dc:title>${esc(section.name)} — ${esc(displayDate)}</dc:title><dc:language>en</dc:language><dc:creator>Morning Reader</dc:creator><meta name="cover" content="cover-image"/><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/,"Z")}</meta></metadata><manifest>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`);
  return await zip.generateAsync({type:"uint8array",mimeType:"application/epub+zip",compression:"DEFLATE",compressionOptions:{level:6}});
}
function b64(bytes:Uint8Array){let out="";for(let i=0;i<bytes.length;i+=0x8000)out+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(out)}
async function sendResend(to:string, attachments:any[], jobId:string) {
  if(!RESEND_API_KEY) throw new Error("RESEND_API_KEY is missing.");
  const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${RESEND_API_KEY}`,"Content-Type":"application/json","Idempotency-Key":`morning-reader-${jobId}`},body:JSON.stringify({from:"Morning Reader <reader@antonioskilton.com>",to:[to],subject:`Morning Reader — ${new Intl.DateTimeFormat("en-US",{dateStyle:"medium"}).format(new Date())}`,text:"Your Morning Reader EPUBs are attached.",attachments})});
  const body=await r.text(); if(!r.ok)throw new Error(`Email provider error (${r.status}): ${body.slice(0,400)}`); return JSON.parse(body);
}
async function queueScheduled() {
  const now=new Date().toISOString();
  const {data:nulls}=await admin.from("user_settings").select("user_id,timezone,delivery_time").eq("paused",false).eq("onboarding_complete",true).not("kindle_email","is",null).is("next_run_at",null).limit(50);
  for(const s of nulls||[]){const {data:n}=await admin.rpc("next_delivery_at",{p_timezone:s.timezone,p_time:s.delivery_time,p_from:now});if(n)await admin.from("user_settings").update({next_run_at:n}).eq("user_id",s.user_id)}
  const {data:due}=await admin.from("user_settings").select("user_id,timezone,delivery_time,next_run_at").eq("paused",false).eq("onboarding_complete",true).not("kindle_email","is",null).lte("next_run_at",now).limit(20);
  for(const s of due||[]){const key=`scheduled:${s.user_id}:${s.next_run_at}`;await admin.from("digest_jobs").upsert({user_id:s.user_id,reason:"scheduled",lookback_hours:48,idempotency_key:key,run_after:now},{onConflict:"idempotency_key",ignoreDuplicates:true});const from=new Date(new Date(s.next_run_at).getTime()+60_000).toISOString();const{data:n}=await admin.rpc("next_delivery_at",{p_timezone:s.timezone,p_time:s.delivery_time,p_from:from});if(n)await admin.from("user_settings").update({next_run_at:n}).eq("user_id",s.user_id)}
}
async function processJob(job:any) {
  const claim=await admin.from("digest_jobs").update({status:"running",started_at:new Date().toISOString(),attempts:job.attempts+1,error:null}).eq("id",job.id).eq("status","queued").select("*").maybeSingle(); if(!claim.data)return null; job=claim.data;
  try{
    const [setR,secR,feedR]=await Promise.all([admin.from("user_settings").select("*").eq("user_id",job.user_id).single(),admin.from("sections").select("*").eq("user_id",job.user_id).eq("enabled",true).is("archived_at",null).order("position"),admin.from("feeds").select("*").eq("user_id",job.user_id).eq("enabled",true).is("archived_at",null)]);
    const settings=setR.data;if(!settings?.kindle_email)throw new Error("No Send-to-Kindle email is configured."); const sections=secR.data||[],feeds=feedR.data||[]; const cutoff=new Date(Date.now()-job.lookback_hours*3600_000);
    let all:any[]=[]; for(const feed of feeds.slice(0,100)) all.push(...await readFeed(feed,cutoff));
    const hashes=[...new Set(all.map(x=>x.article_hash))]; let delivered=new Set<string>(); for(let i=0;i<hashes.length;i+=200){const{data}=await admin.from("article_deliveries").select("article_hash").eq("user_id",job.user_id).in("article_hash",hashes.slice(i,i+200));for(const x of data||[])delivered.add(x.article_hash)}
    all=all.filter(x=>!delivered.has(x.article_hash)); all.sort((a,b)=>(b.published_at?+new Date(b.published_at):0)-(a.published_at?+new Date(a.published_at):0));
    const attachments:any[]=[];const groups:any[]=[];const displayDate=new Intl.DateTimeFormat("en-US",{dateStyle:"long",timeZone:settings.timezone||"UTC"}).format(new Date());
    for(const section of sections){let items=all.filter(x=>x.section_id===section.id);if(job.reason==="test")items=items.slice(0,3);else items=items.slice(0,80);if(!items.length)continue;const bytes=await makeEpub(section,items,displayDate);attachments.push({filename:`${slug(section.name)}-${new Date().toISOString().slice(0,10)}.epub`,content:b64(bytes),content_type:"application/epub+zip"});groups.push({section,items})}
    if(!attachments.length){await admin.from("digest_jobs").update({status:"empty",finished_at:new Date().toISOString(),result:{articles:0,sections:0}}).eq("id",job.id);return{job:job.id,status:"empty"}}
    const sent=await sendResend(settings.kindle_email,attachments,job.id); let total=0;
    for(const g of groups){const{data:d,error}=await admin.from("digests").upsert({user_id:job.user_id,section_id:g.section.id,job_id:job.id,scheduled_for:job.reason==="scheduled"?job.run_after:null,status:"sent",article_count:g.items.length,provider_email_id:sent.id,sent_at:new Date().toISOString()},{onConflict:"job_id,section_id"}).select("id").single();if(error)throw error;const rows=g.items.map((a:any)=>({user_id:job.user_id,feed_id:a.feed_id,section_id:a.section_id,digest_id:d.id,canonical_url:a.canonical_url,article_hash:a.article_hash,title:a.title,published_at:a.published_at,delivered_at:new Date().toISOString()}));if(rows.length){const{error:e}=await admin.from("article_deliveries").upsert(rows,{onConflict:"user_id,article_hash",ignoreDuplicates:true});if(e)throw e}total+=g.items.length}
    await admin.from("digest_jobs").update({status:"sent",finished_at:new Date().toISOString(),result:{articles:total,sections:groups.length,provider_email_id:sent.id}}).eq("id",job.id);return{job:job.id,status:"sent",articles:total,sections:groups.length};
  }catch(e){const msg=(e instanceof Error?e.message:String(e)).slice(0,800),attempts=job.attempts+1,next=attempts<3?"queued":"failed";const patch:any={status:next,error:msg};if(next==="queued")patch.run_after=new Date(Date.now()+attempts*10*60_000).toISOString();else patch.finished_at=new Date().toISOString();await admin.from("digest_jobs").update(patch).eq("id",job.id);return{job:job.id,status:next,error:msg}}
}
Deno.serve(async(req)=>{
  if(req.method!=="POST"&&req.method!=="GET")return json({error:"Method not allowed"},405);
  try{
    const workerSecret=req.headers.get("x-worker-secret")||"";
    if(!workerSecret)return json({error:"Unauthorized"},401);
    const {data:authorized,error:authError}=await admin.rpc("verify_worker_secret",{p_secret:workerSecret});
    if(authError||!authorized)return json({error:"Unauthorized"},401);
    const force=req.headers.get("x-worker-force")==="1";
    const {data:claimed,error:claimError}=await admin.rpc("claim_worker_run",{p_name:"digest-worker",p_min_interval_seconds:force?0:240});
    if(claimError)throw claimError;
    if(!claimed)return json({ok:true,skipped:"recently-run"});
    await admin.from("digest_jobs").update({status:"queued",run_after:new Date().toISOString(),error:"Recovered after stale worker claim."}).eq("status","running").lt("started_at",new Date(Date.now()-30*60_000).toISOString()).lt("attempts",3);
    await queueScheduled(); const {data:jobs,error}=await admin.from("digest_jobs").select("*").eq("status","queued").lte("run_after",new Date().toISOString()).order("created_at").limit(3);if(error)throw error;const results=[];for(const j of jobs||[])results.push(await processJob(j));return json({ok:true,processed:results});
  }catch(e){console.error(e);return json({ok:false,error:(e instanceof Error?e.message:String(e)).slice(0,800)},500)}
});