import {admin,auth,cors,dashboard,discoverFeeds,emailConfigured,exchangeSupabaseAuth,json,normEmail,normalizeUrl,preview,probe,requestCode,routePath,systemHealth,validEmail,validTimezone,validUrl,verifyCode} from "./core.ts";
import {extractArticle,extractionBudget} from "../_shared/article.ts";
import {editionSchedulePatch} from "../_shared/schedule.ts";

function logEvent(event:string,fields:Record<string,unknown>={},level:"info"|"warn"|"error"="info"){
  const line=JSON.stringify({ts:new Date().toISOString(),service:"app-api",event,...fields});
  if(level==="error")console.error(line);else if(level==="warn")console.warn(line);else console.log(line);
}

function oneTimePayload(body:any){
  const name=String(body?.name||"").trim();
  if(!name||name.length>80)throw Object.assign(new Error("Reading list name must be 1–80 characters."),{status:400});
  const raw=Array.isArray(body?.urls)?body.urls:[];
  if(!raw.length||raw.length>20)throw Object.assign(new Error("Add between 1 and 20 article URLs."),{status:400});
  const urls:string[]=[];const seen=new Set<string>();
  for(const value of raw){
    const input=String(value||"").trim();
    if(!validUrl(input))throw Object.assign(new Error("Every article needs a valid http or https URL."),{status:400});
    const normalized=normalizeUrl(input),key=normalized.replace(/#.*$/,"");
    if(seen.has(key))throw Object.assign(new Error("Remove duplicate article URLs before continuing."),{status:400});
    seen.add(key);urls.push(key);
  }
  return{name,urls};
}

async function defaultSourceSectionId(userId:string){
  const existing=await admin.from("sections").select("id").eq("user_id",userId).is("archived_at",null).order("position").order("created_at").limit(1).maybeSingle();
  if(existing.error)throw existing.error;
  if(existing.data?.id)return existing.data.id;
  const created=await admin.from("sections").insert({user_id:userId,name:"Sources",position:0}).select("id").single();
  if(created.error)throw created.error;
  return created.data.id;
}

Deno.serve(async(req)=>{
  const requestId=crypto.randomUUID();
  const origin=req.headers.get("origin");
  const allowedOrigin=!origin||origin==="https://long-form.vercel.app"||origin==="https://morning-reader.vercel.app"||origin==="https://reader.antonioskilton.com"||origin==="http://localhost:3000"||origin==="http://127.0.0.1:3000"||/^https:\/\/(?:long-form|morning-reader)(?:-[a-z0-9]+)?-phinneywood\.vercel\.app$/.test(origin);
  if(!allowedOrigin)return json({error:"Origin not allowed"},403);
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  const route=routePath(req);
  try{
    if(route==="/"||route==="/health")return json({ok:true,service:"long-form",email_configured:emailConfigured(),time:new Date().toISOString()});
    if(route==="/auth/request-code"&&req.method==="POST"){
      const b=await req.json().catch(()=>({})),email=normEmail(b.email);if(!validEmail(email))return json({error:"Enter a valid email address."},400);
      await requestCode(email);logEvent("auth.code_requested",{request_id:requestId});return json({ok:true});
    }
    if(route==="/auth/verify-code"&&req.method==="POST"){
      const b=await req.json().catch(()=>({})),email=normEmail(b.email),code=String(b.code||"").replace(/\D/g,"");
      if(!validEmail(email)||!/^\d{6}$/.test(code))return json({error:"Invalid code."},400);
      const v=await verifyCode(email,code);logEvent("auth.verified",{request_id:requestId,user_id:v.user.id});return json({ok:true,token:v.raw,expires_at:v.expiresAt,...await dashboard(v.user.id,v.user.email)});
    }
    if(route==="/auth/exchange-supabase"&&req.method==="POST"){
      const h=req.headers.get("authorization")||"",accessToken=h.startsWith("Bearer ")?h.slice(7).trim():"";
      const v=await exchangeSupabaseAuth(accessToken);
      logEvent("auth.social_verified",{request_id:requestId,user_id:v.user.id,provider:v.provider});
      return json({ok:true,token:v.raw,expires_at:v.expiresAt,provider:v.provider,...await dashboard(v.user.id,v.user.email)});
    }
    const a=await auth(req);if(!a)return json({error:"Unauthorized"},401);const {user,sessionId}=a;
    if(route==="/auth/logout"&&req.method==="POST"){const{error}=await admin.from("sessions").update({revoked_at:new Date().toISOString()}).eq("id",sessionId);if(error)throw error;return json({ok:true})}
    if(route==="/me"&&req.method==="GET")return json(await dashboard(user.id,user.email));
    if(route==="/system"&&req.method==="GET"){const health=await systemHealth(user.id);logEvent("system.health_viewed",{request_id:requestId,user_id:user.id,alerts:health.alerts.length});return json(health)}
    if(route==="/export"&&req.method==="GET")return json({exported_at:new Date().toISOString(),...await dashboard(user.id,user.email)});
    if(route==="/account"&&req.method==="DELETE"){const{error}=await admin.from("app_users").delete().eq("id",user.id);if(error)throw error;return json({ok:true})}

    if(route==="/settings"&&req.method==="PATCH"){
      const b=await req.json().catch(()=>({}));const {data:cur,error:ce}=await admin.from("user_settings").select("*").eq("user_id",user.id).single();if(ce)throw ce;const p:any={};
      if("kindle_email"in b){const k=normEmail(b.kindle_email);if(k&&!validEmail(k))return json({error:"Enter a valid Send-to-Kindle email address."},400);p.kindle_email=k||null}
      if("timezone"in b){const tz=String(b.timezone||"");if(!validTimezone(tz))return json({error:"Invalid timezone."},400);p.timezone=tz}
      if("delivery_time"in b){const t=String(b.delivery_time||"");if(!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(t))return json({error:"Invalid delivery time."},400);p.delivery_time=t.length===5?`${t}:00`:t}
      if("editorial_brief"in b){const brief=String(b.editorial_brief||"").trim();if(brief.length>3000)return json({error:"Editorial brief must be 3,000 characters or fewer."},400);p.editorial_brief=brief}
      if("paused"in b)p.paused=Boolean(b.paused);if("onboarding_complete"in b)p.onboarding_complete=Boolean(b.onboarding_complete);
      // Account time is retained only as a default for legacy clients/new editions.
      // Database triggers recalculate edition schedules on timezone/pause changes.
      p.updated_at=new Date().toISOString();
      const{error}=await admin.from("user_settings").update(p).eq("user_id",user.id);if(error)throw error;return json(await dashboard(user.id,user.email));
    }

    if(route==="/sections"&&req.method==="POST"){
      const b=await req.json().catch(()=>({})),name=String(b.name||"").trim();if(!name||name.length>80)return json({error:"Section name must be 1–80 characters."},400);
      const{count}=await admin.from("sections").select("id",{count:"exact",head:true}).eq("user_id",user.id).is("archived_at",null);if((count||0)>=12)return json({error:"You can have up to 12 sections."},400);
      const{error}=await admin.from("sections").insert({user_id:user.id,name,position:count||0,...editionSchedulePatch(b)});if(error)throw error;return json(await dashboard(user.id,user.email),201);
    }
    const sm=route.match(/^\/sections\/([0-9a-f-]+)$/i);
    if(sm&&req.method==="PATCH"){
      const b=await req.json().catch(()=>({})),p:any={updated_at:new Date().toISOString(),...editionSchedulePatch(b)};if("name"in b){const n=String(b.name||"").trim();if(!n||n.length>80)return json({error:"Section name must be 1–80 characters."},400);p.name=n}
      const{data:section,error}=await admin.from("sections").update(p).eq("id",sm[1]).eq("user_id",user.id).is("archived_at",null).select("id").maybeSingle();if(error)throw error;if(!section)return json({error:"Section not found."},404);return json(await dashboard(user.id,user.email));
    }
    if(sm&&req.method==="DELETE"){
      const{count}=await admin.from("sections").select("id",{count:"exact",head:true}).eq("user_id",user.id).is("archived_at",null);if((count||0)<=1)return json({error:"Keep at least one section."},400);const now=new Date().toISOString();
      await admin.from("feeds").update({archived_at:now,enabled:false}).eq("section_id",sm[1]).eq("user_id",user.id);const{error}=await admin.from("sections").update({archived_at:now,enabled:false}).eq("id",sm[1]).eq("user_id",user.id);if(error)throw error;return json(await dashboard(user.id,user.email));
    }

    if(route==="/discover"&&req.method==="POST"){
      const b=await req.json().catch(()=>({})),input=String(b.url||"").trim();if(!validUrl(input))return json({error:"Enter a valid website or RSS/Atom address."},400);
      try{return json({feeds:await discoverFeeds(input),powered_by:"Feedsearch"})}catch(e){return json({error:e instanceof Error?e.message:String(e)},400)}
    }
    if(route==="/feeds/bulk"&&req.method==="POST"){
      const b=await req.json().catch(()=>({})),items=Array.isArray(b.feeds)?b.feeds:[];
      if(!items.length||items.length>100)return json({error:"Import between 1 and 100 feeds at a time."},400);

      const[{data:sectionRows,error:sectionError},{count:feedCount,error:feedCountError}]=await Promise.all([
        admin.from("sections").select("id,name,position").eq("user_id",user.id).is("archived_at",null).order("position").order("created_at"),
        admin.from("feeds").select("id",{count:"exact",head:true}).eq("user_id",user.id).is("archived_at",null)
      ]);
      if(sectionError)throw sectionError;if(feedCountError)throw feedCountError;
      const sections=[...(sectionRows||[])],sectionById=new Map(sections.map((s:any)=>[s.id,s])),sectionByName=new Map(sections.map((s:any)=>[String(s.name).trim().toLowerCase(),s]));
      if(!sections.length){
        const{data:created,error:createError}=await admin.from("sections").insert({user_id:user.id,name:"Sources",position:0}).select("id,name,position").single();
        if(createError)throw createError;
        sections.push(created);sectionById.set(created.id,created);sectionByName.set("sources",created);
      }
      const defaultSection=sections[0];
      let activeCount=feedCount||0,nextPosition=sections.length?Math.max(...sections.map((s:any)=>Number(s.position)||0))+1:0;

      const probed:any[]=new Array(items.length);let cursor=0;
      async function worker(){
        while(true){
          const i=cursor++;if(i>=items.length)return;
          const item=items[i]||{},input=String(item.url||"").trim(),requestedName=String(item.name||"").trim();
          let sectionId=String(item.section_id||"").trim();const sectionName=String(item.section_name||"").trim();
          if(!validUrl(input)){probed[i]={index:i,input,requestedName,sectionId,sectionName,error:"Enter a valid website or RSS/Atom address."};continue}
          if(!sectionId&&!sectionName)sectionId=defaultSection.id;
          if(sectionName.length>80){probed[i]={index:i,input,requestedName,sectionId,sectionName,error:"Section name must be 80 characters or fewer."};continue}
          try{
            const pr=await probe(input),url=normalizeUrl(pr.url),name=(requestedName||pr.title||new URL(url).hostname.replace(/^www\./,"")).slice(0,120);
            probed[i]={index:i,input,requestedName,sectionId,sectionName,url,name};
          }catch(e){probed[i]={index:i,input,requestedName,sectionId,sectionName,error:e instanceof Error?e.message:String(e)}}
        }
      }
      await Promise.all(Array.from({length:Math.min(5,items.length)},()=>worker()));

      const results:any[]=[];
      for(const item of probed){
        if(item.error){results.push({index:item.index,input:item.input,name:item.requestedName||item.input,status:"failed",error:item.error});continue}
        let section:any=null;
        if(item.sectionId)section=sectionById.get(item.sectionId)||null;
        if(!section&&item.sectionName){
          const key=item.sectionName.toLowerCase();section=sectionByName.get(key)||null;
          if(!section){
            if(sections.length>=12){results.push({index:item.index,input:item.input,name:item.name,status:"failed",error:"You can have up to 12 sections."});continue}
            const{data:created,error:createError}=await admin.from("sections").insert({user_id:user.id,name:item.sectionName,position:nextPosition++}).select("id,name,position").single();
            if(createError){results.push({index:item.index,input:item.input,name:item.name,status:"failed",error:String(createError.message||createError)});continue}
            section=created;sections.push(created);sectionById.set(created.id,created);sectionByName.set(String(created.name).trim().toLowerCase(),created);
          }
        }
        if(!section){results.push({index:item.index,input:item.input,name:item.name,status:"failed",error:"Section not found."});continue}

        const{data:existing,error:existingError}=await admin.from("feeds").select("id,archived_at,section_id,name").eq("user_id",user.id).eq("url",item.url).maybeSingle();
        if(existingError)throw existingError;
        if(existing&&!existing.archived_at){
          results.push({index:item.index,input:item.input,name:existing.name||item.name,url:item.url,section_id:existing.section_id,status:"duplicate"});
          continue;
        }
        if(activeCount>=100){results.push({index:item.index,input:item.input,name:item.name,url:item.url,status:"failed",error:"You can have up to 100 feeds."});continue}
        if(existing){
          const{error}=await admin.from("feeds").update({section_id:section.id,name:item.name,kind:"standard",enabled:true,archived_at:null,last_error:null,last_fetch_at:new Date().toISOString()}).eq("id",existing.id).eq("user_id",user.id);
          if(error){results.push({index:item.index,input:item.input,name:item.name,url:item.url,status:"failed",error:String(error.message||error)});continue}
          activeCount++;results.push({index:item.index,input:item.input,name:item.name,url:item.url,section_id:section.id,status:"restored"});continue;
        }
        const{error}=await admin.from("feeds").insert({user_id:user.id,section_id:section.id,name:item.name,url:item.url,kind:"standard",enabled:true});
        if(error){
          if((error as any)?.code==="23505"){results.push({index:item.index,input:item.input,name:item.name,url:item.url,status:"duplicate"});continue}
          results.push({index:item.index,input:item.input,name:item.name,url:item.url,status:"failed",error:String((error as any)?.message||error)});continue;
        }
        activeCount++;results.push({index:item.index,input:item.input,name:item.name,url:item.url,section_id:section.id,status:"added"});
      }
      const summary=results.reduce((x:any,r:any)=>{x[r.status]=(x[r.status]||0)+1;return x},{added:0,restored:0,duplicate:0,failed:0});
      logEvent("feeds.bulk_imported",{request_id:requestId,user_id:user.id,...summary});
      return json({ok:true,summary,results,dashboard:await dashboard(user.id,user.email)});
    }

    if(route==="/feeds"&&req.method==="POST"){
      const b=await req.json().catch(()=>({})),input=String(b.url||"").trim();let sectionId=String(b.section_id||"");if(!validUrl(input))return json({error:"Enter a valid website or RSS/Atom address."},400);
      if(!sectionId)sectionId=await defaultSourceSectionId(user.id);
      const{data:sec}=await admin.from("sections").select("id").eq("id",sectionId).eq("user_id",user.id).is("archived_at",null).maybeSingle();if(!sec)return json({error:"Source container not found."},404);
      const{count}=await admin.from("feeds").select("id",{count:"exact",head:true}).eq("user_id",user.id).is("archived_at",null);if((count||0)>=100)return json({error:"You can have up to 100 feeds."},400);
      let pr;try{pr=await probe(input)}catch(e){return json({error:e instanceof Error?e.message:String(e)},400)}
      const url=normalizeUrl(pr.url),name=(String(b.name||"").trim()||pr.title||new URL(url).hostname.replace(/^www\./,"")).slice(0,120);
      const{data:existing,error:existingError}=await admin.from("feeds").select("id,archived_at").eq("user_id",user.id).eq("url",url).maybeSingle();if(existingError)throw existingError;
      if(existing){
        if(!existing.archived_at)return json({error:"This source is already in your source list."},409);
        const{error}=await admin.from("feeds").update({section_id:sectionId,name,kind:"standard",enabled:true,archived_at:null,last_error:null,last_fetch_at:new Date().toISOString()}).eq("id",existing.id).eq("user_id",user.id);if(error)throw error;
        logEvent("feed.restored",{request_id:requestId,user_id:user.id,feed_id:existing.id,section_id:sectionId});return json(await dashboard(user.id,user.email),200);
      }
      const{error}=await admin.from("feeds").insert({user_id:user.id,section_id:sectionId,name,url,kind:"standard",enabled:true});
      if(error){if((error as any)?.code==="23505")return json({error:"This source is already in your source list."},409);throw error}
      logEvent("feed.added",{request_id:requestId,user_id:user.id,section_id:sectionId});return json(await dashboard(user.id,user.email),201);
    }
    const checkFeed=route.match(/^\/feeds\/([0-9a-f-]+)\/check$/i);
    if(checkFeed&&req.method==="POST"){
      const{data:feed,error}=await admin.from("feeds").select("*").eq("id",checkFeed[1]).eq("user_id",user.id).is("archived_at",null).maybeSingle();
      if(error)throw error;
      if(!feed)return json({error:"Source not found."},404);
      const result=await preview(feed);
      logEvent("feed.checked",{request_id:requestId,user_id:user.id,feed_id:feed.id,ok:!result.error});
      return json({result,dashboard:await dashboard(user.id,user.email)});
    }
    const fm=route.match(/^\/feeds\/([0-9a-f-]+)$/i);
    if(fm&&req.method==="PATCH"){
      const b=await req.json().catch(()=>({})),p:any={updated_at:new Date().toISOString()};
      if("name"in b){const n=String(b.name||"").trim();if(!n||n.length>120)return json({error:"Feed name must be 1–120 characters."},400);p.name=n}
      if("enabled"in b)p.enabled=Boolean(b.enabled);
      if("url"in b){
        const input=String(b.url||"").trim();if(!validUrl(input))return json({error:"Enter a valid website or RSS/Atom address."},400);
        try{
          const pr=await probe(input),url=normalizeUrl(pr.url);
          const{data:duplicate,error:duplicateError}=await admin.from("feeds").select("id").eq("user_id",user.id).eq("url",url).neq("id",fm[1]).maybeSingle();
          if(duplicateError)throw duplicateError;
          if(duplicate)return json({error:"That source is already in your list."},409);
          p.url=url;p.last_error=null;p.consecutive_failures=0;p.last_fetch_at=new Date().toISOString();
        }catch(e){return json({error:e instanceof Error?e.message:String(e)},400)}
      }
      if("section_id"in b){const{data:sec}=await admin.from("sections").select("id").eq("id",b.section_id).eq("user_id",user.id).is("archived_at",null).maybeSingle();if(!sec)return json({error:"Section not found."},404);p.section_id=b.section_id}
      const{data:updated,error}=await admin.from("feeds").update(p).eq("id",fm[1]).eq("user_id",user.id).is("archived_at",null).select("id").maybeSingle();if(error)throw error;if(!updated)return json({error:"Source not found."},404);return json(await dashboard(user.id,user.email));
    }
    if(fm&&req.method==="DELETE"){const now=new Date().toISOString();const{error}=await admin.from("feeds").update({archived_at:now,enabled:false}).eq("id",fm[1]).eq("user_id",user.id);if(error)throw error;return json(await dashboard(user.id,user.email))}

    if(route==="/preview"&&req.method==="POST"){
      const{data:feeds,error}=await admin.from("feeds").select("*").eq("user_id",user.id).eq("enabled",true).is("archived_at",null).limit(40);if(error)throw error;const rs:any[]=new Array((feeds||[]).length);let cursor=0;const deadline=Date.now()+60000;await Promise.all(Array.from({length:Math.min(4,(feeds||[]).length)},async()=>{while(cursor<(feeds||[]).length){const i=cursor++;rs[i]=Date.now()>=deadline?{feed_id:feeds![i].id,items:[],error:"Source browsing time limit reached."}:await preview(feeds![i])}}));
      const items=rs.flatMap((r:any)=>r.items).sort((a:any,b:any)=>(b.published_at?+new Date(b.published_at):0)-(a.published_at?+new Date(a.published_at):0)).slice(0,60);logEvent("preview.generated",{request_id:requestId,user_id:user.id,feeds:(feeds||[]).length,items:items.length,feed_errors:rs.filter((r:any)=>r.error).length});return json({items,feeds:rs});
    }
    if(route==="/one-time/preview"&&req.method==="POST"){
      const{name,urls}=oneTimePayload(await req.json().catch(()=>({})));
      const budget=extractionBudget();
      const items:any[]=new Array(urls.length);let cursor=0;
      async function previewWorker(){
        while(true){
          const index=cursor++;if(index>=urls.length)return;
          try{
            const article=await extractArticle({url:urls[index],includeImages:false,budget});
            items[index]={index,status:"ready",title:article.title,url:urls[index],canonical_url:article.canonical_url,source:article.source,author:article.author,published_at:article.published_at,excerpt:article.excerpt,warnings:article.warnings};
          }catch(error){items[index]={index,status:"failed",url:urls[index],error:error instanceof Error?error.message:String(error)}}
        }
      }
      await Promise.all(Array.from({length:Math.min(3,urls.length)},()=>previewWorker()));
      const failed=items.filter(item=>item.status==="failed").length;
      logEvent("one_time.previewed",{request_id:requestId,user_id:user.id,name,articles:urls.length,failed});
      return json({name,items,ready:failed===0});
    }
    if(route==="/one-time/send"&&req.method==="POST"){
      const body=await req.json().catch(()=>({}));
      const{name,urls}=oneTimePayload(body);
      const{data:settings}=await admin.from("user_settings").select("kindle_email").eq("user_id",user.id).single();
      if(!settings?.kindle_email)return json({error:"Add your Send-to-Kindle email first."},400);
      const rows=urls.map(url=>({user_id:user.id,section_name:name,url}));
      const{error}=await admin.from("pending_issue_articles").upsert(rows,{onConflict:"user_id,url",ignoreDuplicates:false});
      if(error)throw error;
      logEvent("next_issue.articles_added",{request_id:requestId,user_id:user.id,name,articles:urls.length});
      return json({ok:true,queued_for_next_issue:true,articles:urls.length,name},202);
    }
    if((route==="/send-now"||route==="/send-test")&&req.method==="POST"){
      const body=await req.json().catch(()=>({})),requestId=String(body.request_id||crypto.randomUUID());
      if(!/^[0-9a-f-]{36}$/i.test(requestId))return json({error:"Invalid request identifier."},400);
      const{data:s}=await admin.from("user_settings").select("kindle_email,timezone").eq("user_id",user.id).single();if(!s?.kindle_email)return json({error:"Add your Send-to-Kindle email first."},400);const reason=route==="/send-test"?"test":"manual";
      const localDate=new Intl.DateTimeFormat("en-CA",{timeZone:s.timezone||"UTC",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
      const key=reason==="manual"?`daily-issue:${user.id}:${localDate}`:`test:${user.id}:${requestId}`;
      const{data:job,error}=await admin.from("digest_jobs").upsert({user_id:user.id,reason,lookback_hours:168,idempotency_key:key,run_after:new Date().toISOString()},{onConflict:"idempotency_key",ignoreDuplicates:true}).select("id,status,reason,created_at").maybeSingle();if(error)throw error;
      if(!job){const existing=await admin.from("digest_jobs").select("id,status,reason,created_at").eq("user_id",user.id).eq("idempotency_key",key).single();if(existing.error)throw existing.error;return json({ok:true,job:existing.data,already_sent_or_queued:reason==="manual"},202)}
      const now=Date.now(),nextBoundary=new Date(Math.ceil((now+1000)/300000)*300000).toISOString();
      const{data:kick,error:kickError}=await admin.rpc("kick_digest_worker");
      logEvent("delivery.queued",{request_id:requestId,user_id:user.id,job_id:job.id,reason,worker_triggered:!kickError&&Boolean(kick)});
      return json({ok:true,job,worker_triggered:!kickError&&Boolean(kick),next_worker_check_at:nextBoundary},202);
    }
    return json({error:"Not found"},404);
  }catch(e:any){const status=Number(e?.status)||500;logEvent("request.failed",{request_id:requestId,route,status,error:String(e?.message||e).slice(0,600)},status>=500?"error":"warn");return json({error:String(e?.message||e).slice(0,600)},status)}
});
