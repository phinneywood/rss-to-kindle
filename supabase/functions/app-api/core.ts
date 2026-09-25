import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { fetchPublicText } from "../_shared/network.ts";
import { XMLParser } from "npm:fast-xml-parser@5.11.1";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
export const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {auth:{persistSession:false,autoRefreshToken:false}});
export const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, content-type, x-client-info, apikey","Access-Control-Allow-Methods":"GET, POST, PATCH, DELETE, OPTIONS","Cache-Control":"no-store"};
export function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json; charset=utf-8"}})}
export function routePath(req:Request){const p=new URL(req.url).pathname,m="/app-api",i=p.indexOf(m);return i>=0?p.slice(i+m.length)||"/":p}
export function normEmail(v:unknown){return String(v||"").trim().toLowerCase()}
export function validEmail(v:string){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)&&v.length<=320}
export function normalizeUrl(v:string){const s=String(v||"").trim();if(!s)return"";return /^[a-z][a-z0-9+.-]*:\/\//i.test(s)?s:`https://${s}`}
export function validUrl(v:string){try{const u=new URL(normalizeUrl(v));return["http:","https:"].includes(u.protocol)&&!u.username&&!u.password}catch{return false}}
export function validTimezone(v:string){try{new Intl.DateTimeFormat("en-US",{timeZone:v}).format(new Date());return true}catch{return false}}
function hex(b:Uint8Array){return Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join("")}
export async function sha256(v:string){return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v))))}
function token(n=32){const b=new Uint8Array(n);crypto.getRandomValues(b);let s="";for(const x of b)s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}
function code(){const a=new Uint32Array(1);crypto.getRandomValues(a);return String(a[0]%1_000_000).padStart(6,"0")}
async function codeHash(email:string,c:string){return sha256(`${SERVICE_ROLE}:${email}:${c}`)}
async function mailCode(email:string,c:string){
  if(!RESEND_API_KEY)throw new Error("Email service is not configured.");
  const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${RESEND_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({from:"Morning Reader <reader@antonioskilton.com>",to:[email],subject:`${c} is your Morning Reader code`,text:`Your Morning Reader sign-in code is ${c}. It expires in 10 minutes.`,html:`<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif"><p>Your Morning Reader sign-in code is:</p><p style="font-size:34px;font-weight:700;letter-spacing:6px">${c}</p><p>It expires in 10 minutes.</p></body></html>`})});
  if(!r.ok)throw new Error(`Email provider error (${r.status}): ${(await r.text()).slice(0,250)}`);
}
export async function requestCode(email:string){const since=new Date(Date.now()-600_000).toISOString();const{count}=await admin.from("login_codes").select("id",{count:"exact",head:true}).eq("email",email).gte("created_at",since);if((count||0)>=5)throw Object.assign(new Error("Too many codes requested. Try again in a few minutes."),{status:429});const c=code(),expires=new Date(Date.now()+600_000).toISOString();const{data,error}=await admin.from("login_codes").insert({email,code_hash:await codeHash(email,c),expires_at:expires}).select("id").single();if(error)throw error;try{await mailCode(email,c)}catch(e){await admin.from("login_codes").delete().eq("id",data.id);throw e}}
async function ensureUserSetup(userId:string){
  const{data:settings,error:settingsError}=await admin.from("user_settings").select("user_id").eq("user_id",userId).maybeSingle();
  if(settingsError)throw settingsError;
  if(!settings){const{error}=await admin.from("user_settings").insert({user_id:userId,timezone:"America/Los_Angeles",delivery_time:"06:00:00"});if(error)throw error}
  const{count,error:sectionError}=await admin.from("sections").select("id",{count:"exact",head:true}).eq("user_id",userId).is("archived_at",null);
  if(sectionError)throw sectionError;
  if(!count){const{error}=await admin.from("sections").insert({user_id:userId,name:"Reading",position:0});if(error)throw error}
}
async function issueAppSession(user:{id:string,email:string}){
  await ensureUserSetup(user.id);
  const idleTimeoutSeconds=90*86400;
  const raw=token(),expiresAt=new Date(Date.now()+idleTimeoutSeconds*1000).toISOString();
  const{error}=await admin.from("sessions").insert({user_id:user.id,token_hash:await sha256(raw),expires_at:expiresAt,idle_timeout_seconds:idleTimeoutSeconds});
  if(error)throw error;
  return{raw,expiresAt,user};
}
export async function verifyCode(email:string,c:string){
  const{data:login,error}=await admin.from("login_codes").select("*").eq("email",email).is("consumed_at",null).gt("expires_at",new Date().toISOString()).lt("attempts",5).order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(error)throw error;
  if(!login)throw Object.assign(new Error("That code has expired. Request a new one."),{status:401});
  if(await codeHash(email,c)!==login.code_hash){await admin.from("login_codes").update({attempts:login.attempts+1}).eq("id",login.id);throw Object.assign(new Error("That code is not correct."),{status:401})}
  await admin.from("login_codes").update({consumed_at:new Date().toISOString()}).eq("id",login.id);
  const{data:user,error:userError}=await admin.from("app_users").upsert({email},{onConflict:"email"}).select("id,email").single();
  if(userError)throw userError;
  return issueAppSession(user);
}
export async function exchangeSupabaseAuth(accessToken:string){
  if(!accessToken)throw Object.assign(new Error("Missing Supabase access token."),{status:401});
  const{data,error}=await admin.auth.getUser(accessToken);
  const authUser=data?.user;
  if(error||!authUser?.id||!authUser.email)throw Object.assign(new Error("Supabase session is invalid or expired."),{status:401});
  if(!authUser.email_confirmed_at)throw Object.assign(new Error("Your email address must be verified before signing in."),{status:401});
  const provider=String(authUser.app_metadata?.provider||"").toLowerCase();
  if(provider&&!["google","apple","email"].includes(provider))throw Object.assign(new Error("This sign-in provider is not enabled for Morning Reader."),{status:403});
  const email=normEmail(authUser.email);
  let{data:user,error:userError}=await admin.from("app_users").select("id,email,auth_user_id").eq("auth_user_id",authUser.id).maybeSingle();
  if(userError)throw userError;
  if(!user){
    const{data:byEmail,error:emailError}=await admin.from("app_users").select("id,email,auth_user_id").eq("email",email).maybeSingle();
    if(emailError)throw emailError;
    if(byEmail){
      if(byEmail.auth_user_id&&byEmail.auth_user_id!==authUser.id)throw Object.assign(new Error("This email is already linked to another sign-in identity."),{status:409});
      const{data:linked,error:linkError}=await admin.from("app_users").update({auth_user_id:authUser.id,updated_at:new Date().toISOString()}).eq("id",byEmail.id).select("id,email,auth_user_id").single();
      if(linkError)throw linkError; user=linked;
    }else{
      const{data:created,error:createError}=await admin.from("app_users").insert({email,auth_user_id:authUser.id}).select("id,email,auth_user_id").single();
      if(createError)throw createError; user=created;
    }
  }
  const session=await issueAppSession({id:user.id,email:user.email});
  return{...session,provider:provider||"oauth",auth_user_id:authUser.id};
}
export async function auth(req:Request){
  const h=req.headers.get("authorization")||"",raw=h.startsWith("Bearer ")?h.slice(7).trim():"";
  if(!raw)return null;
  // Validate and renew together: an expired or revoked session must never revive.
  const{data,error}=await admin.rpc("authenticate_app_session",{p_token_hash:await sha256(raw)});
  if(error)throw Object.assign(new Error("Sign-in could not be checked. Please try again."),{status:503});
  const session=data?.[0];
  if(!session)return null;
  return{sessionId:session.session_id,user:{id:session.user_id,email:session.email}};
}
export async function dashboard(userId:string,email:string){
  const[s,se,fe,di,jo]=await Promise.all([
    admin.from("user_settings").select("*").eq("user_id",userId).single(),
    admin.from("sections").select("*").eq("user_id",userId).is("archived_at",null).order("position").order("created_at"),
    admin.from("feeds").select("*").eq("user_id",userId).is("archived_at",null).order("created_at"),
    admin.from("digests").select("id,section_id,edition_name,status,article_count,error,created_at,sent_at").eq("user_id",userId).order("created_at",{ascending:false}).limit(25),
    admin.from("digest_jobs").select("id,reason,section_id,edition_name,scheduled_for,packet_name,article_urls,status,result,error,attempts,run_after,created_at,started_at,finished_at").eq("user_id",userId).order("created_at",{ascending:false}).limit(15)
  ]);
  if(s.error)throw s.error;if(se.error)throw se.error;if(fe.error)throw fe.error;if(di.error)throw di.error;if(jo.error)throw jo.error;
  const sources=fe.data||[];
  const sections=(se.data||[]).map((x:any)=>({...x,feeds:sources.filter((f:any)=>f.section_id===x.id)}));
  return{
    user:{id:userId,email},
    settings:s.data,
    sources,
    sections,
    digests:di.data||[],
    jobs:jo.data||[],
    sender_email:"reader@antonioskilton.com"
  };
}
export async function systemHealth(userId:string){
  const since=new Date(Date.now()-24*3600_000).toISOString();
  const [settingsR,feedsR,jobsR,articlesR]=await Promise.all([
    admin.from("user_settings").select("paused,onboarding_complete,next_run_at,kindle_email").eq("user_id",userId).single(),
    admin.from("feeds").select("id,name,last_fetch_at,last_success_at,last_error,consecutive_failures,enabled").eq("user_id",userId).eq("enabled",true).is("archived_at",null).order("consecutive_failures",{ascending:false}),
    admin.from("digest_jobs").select("id,reason,section_id,edition_name,scheduled_for,packet_name,status,result,error,created_at,started_at,finished_at").eq("user_id",userId).gte("created_at",since).order("created_at",{ascending:false}).limit(100),
    admin.from("article_deliveries").select("id",{count:"exact",head:true}).eq("user_id",userId).gte("delivered_at",since)
  ]);
  if(settingsR.error)throw settingsR.error;if(feedsR.error)throw feedsR.error;if(jobsR.error)throw jobsR.error;if(articlesR.error)throw articlesR.error;
  const settings=settingsR.data,feeds=feedsR.data||[],jobs=jobsR.data||[];
  const completed=jobs.filter((j:any)=>["sent","empty","partial","failed"].includes(j.status));
  const successful=completed.filter((j:any)=>j.status==="sent"||j.status==="empty").length;
  const durations=completed.map((j:any)=>j.started_at&&j.finished_at?new Date(j.finished_at).getTime()-new Date(j.started_at).getTime():null).filter((x:number|null):x is number=>typeof x==="number"&&x>=0).sort((a,b)=>a-b);
  const medianMs=durations.length?durations[Math.floor((durations.length-1)/2)]:null;
  const failingFeeds=feeds.filter((f:any)=>f.last_error);
  const repeatedFeeds=feeds.filter((f:any)=>Number(f.consecutive_failures||0)>=3);
  const failedJobs=jobs.filter((j:any)=>j.status==="failed");
  const alerts:any[]=[];
  if(settings?.onboarding_complete&&!settings?.paused&&settings?.next_run_at&&new Date(settings.next_run_at).getTime()<Date.now()-30*60_000){
    alerts.push({severity:"error",type:"delivery_overdue",message:"Scheduled daily delivery is overdue by more than 30 minutes."});
  }
  if(failedJobs.length)alerts.push({severity:"error",type:"delivery_failed",message:`${failedJobs.length} delivery ${failedJobs.length===1?"job has":"jobs have"} failed in the last 24 hours.`});
  if(repeatedFeeds.length)alerts.push({severity:"warning",type:"feeds_repeatedly_failing",message:`${repeatedFeeds.length} source${repeatedFeeds.length===1?" is":"s are"} failing repeatedly.`});
  return{
    generated_at:new Date().toISOString(),
    window_hours:24,
    delivery:{
      jobs:jobs.length,
      completed:completed.length,
      successful,
      failed:failedJobs.length,
      empty:jobs.filter((j:any)=>j.status==="empty").length,
      success_rate:completed.length?Math.round((successful/completed.length)*1000)/10:null,
      median_duration_ms:medianMs,
      articles_delivered:articlesR.count||0
    },
    feeds:{
      total:feeds.length,
      healthy:feeds.length-failingFeeds.length,
      failing:failingFeeds.length,
      repeatedly_failing:repeatedFeeds.length
    },
    alerts,
    recent_jobs:jobs.slice(0,12),
    source_issues:failingFeeds.slice(0,20).map((f:any)=>({id:f.id,name:f.name,last_error:f.last_error,consecutive_failures:f.consecutive_failures||0,last_fetch_at:f.last_fetch_at,last_success_at:f.last_success_at}))
  };
}

async function safeFetch(input:string,maxBytes=1_500_000){return (await fetchPublicText(input,"application/rss+xml,application/atom+xml,text/html,*/*",maxBytes)).text}
function looksLikeFeed(x:string){return /<(rss\b|feed\b|rdf:RDF\b)/i.test(x)}
function feedTitle(x:string){const m=x.match(/<title(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);return(m?.[1]||"").replace(/<[^>]+>/g,"").replace(/&amp;/gi,"&").replace(/&#39;/g,"'").trim().slice(0,120)}
function htmlAttr(tag:string,name:string){const m=tag.match(new RegExp(name+"\\s*=\\s*([\\\"'])(.*?)\\1","i"));return m?.[2]||""}
function htmlFeedLinks(html:string,base:string){
  const out:{url:string,title:string,method:string}[]=[];
  for(const tag of html.match(/<link\b[^>]*>/gi)||[]){
    const rel=htmlAttr(tag,"rel").toLowerCase(),type=htmlAttr(tag,"type").toLowerCase(),href=htmlAttr(tag,"href");
    if(!href||!rel.split(/\s+/).includes("alternate")||!/(rss|atom|feed\+json)/.test(type))continue;
    try{out.push({url:new URL(href,base).toString(),title:htmlAttr(tag,"title"),method:"autodiscovery"})}catch{}
  }
  return out;
}
async function verifyFeedCandidate(candidate:{url:string,title?:string,method?:string}){
  if(!validUrl(candidate.url))return null;
  try{const x=await safeFetch(candidate.url,1_500_000);if(!looksLikeFeed(x))return null;return{url:normalizeUrl(candidate.url),title:(candidate.title||feedTitle(x)||new URL(candidate.url).hostname).slice(0,120),method:candidate.method||"discovered"}}catch{return null}
}
export async function discoverFeeds(input:string){
  const url=normalizeUrl(input);if(!validUrl(url))throw new Error("Enter a valid website or RSS/Atom address.");
  let html="";let originalError="";
  try{html=await safeFetch(url,1_500_000)}catch(e){originalError=e instanceof Error?e.message:String(e)}
  if(html&&looksLikeFeed(html))return[{url,title:feedTitle(html)||new URL(url).hostname,method:"direct"}];

  const found:{url:string,title:string,method:string}[]=[];
  if(html){
    for(const c of htmlFeedLinks(html,url).slice(0,8)){const v=await verifyFeedCandidate(c);if(v&&!found.some(x=>x.url===v.url))found.push(v)}
  }
  if(!found.length){
    const base=new URL(url),paths=["/feed","/feed/","/rss","/rss.xml","/feed.xml","/atom.xml","/index.xml"];
    for(const p of paths){const v=await verifyFeedCandidate({url:new URL(p,base.origin).toString(),method:"common-path"});if(v&&!found.some(x=>x.url===v.url))found.push(v);if(found.length>=4)break}
  }
  if(!found.length){
    try{
      const raw=await safeFetch("https://origin.feedsearch.dev/api/v1/search?info=true&favicon=false&opml=false&url="+encodeURIComponent(url),1_000_000);
      {
        const rows=JSON.parse(raw);
        for(const row of (Array.isArray(rows)?rows:[]).slice(0,8)){
          const v=await verifyFeedCandidate({url:String(row.url||""),title:String(row.title||row.site_name||""),method:"feedsearch"});
          if(v&&!found.some(x=>x.url===v.url))found.push(v);
          if(found.length>=6)break;
        }
      }
    }catch{}
  }
  if(found.length)return found;
  if(originalError)throw new Error(originalError);
  throw new Error("Morning Reader couldn't find an RSS or Atom feed for this site. Try a direct feed URL or search with Feedsearch.");
}
export async function probe(url:string){const feeds=await discoverFeeds(url);return feeds[0]}
function arr(x:any){return x==null?[]:Array.isArray(x)?x:[x]}
function text(x:any):string{if(x==null)return"";if(typeof x==="string"||typeof x==="number")return String(x);if(typeof x==="object"){if("__cdata"in x)return text(x.__cdata);if("#text"in x)return text(x["#text"])}return""}
function link(x:any):string{if(typeof x==="string")return x;for(const v of arr(x)){if(typeof v==="string")return v;if(v&&typeof v==="object"&&v["@_href"])return String(v["@_href"])}return""}
export async function preview(feed:any){try{const raw=await safeFetch(feed.url);if(!looksLikeFeed(raw))throw new Error("This source did not return RSS or Atom.");const p=new XMLParser({ignoreAttributes:false,attributeNamePrefix:"@_",textNodeName:"#text",cdataPropName:"__cdata"}),d:any=p.parse(raw);let es:any[]=[];if(d?.rss?.channel?.item)es=arr(d.rss.channel.item);else if(d?.feed?.entry)es=arr(d.feed.entry);else if(d?.["rdf:RDF"]?.item)es=arr(d["rdf:RDF"].item);const items=es.slice(0,10).map(e=>{const raw=text(e.pubDate||e.published||e.updated||e["dc:date"]),dt=raw?new Date(raw):null;return{title:text(e.title).replace(/<[^>]+>/g,"").trim()||"Untitled",url:link(e.link)||text(e.guid||e.id),published_at:dt&&!isNaN(+dt)?dt.toISOString():null,source:feed.name}}).filter(x=>x.url);const now=new Date().toISOString();await admin.from("feeds").update({last_fetch_at:now,last_success_at:now,last_error:null,consecutive_failures:0}).eq("id",feed.id);return{feed_id:feed.id,items}}catch(e){const m=e instanceof Error?e.message:String(e),failures=Number(feed.consecutive_failures||0)+1;await admin.from("feeds").update({last_fetch_at:new Date().toISOString(),last_error:m.slice(0,500),consecutive_failures:failures}).eq("id",feed.id);return{feed_id:feed.id,items:[],error:m}}}
export function emailConfigured(){return Boolean(RESEND_API_KEY)}
