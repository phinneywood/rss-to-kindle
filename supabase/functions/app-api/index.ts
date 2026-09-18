import {admin,auth,cors,dashboard,discoverFeeds,emailConfigured,json,nextRun,normEmail,normalizeUrl,preview,probe,requestCode,routePath,validEmail,validTimezone,validUrl,verifyCode} from "./core.ts";

Deno.serve(async(req)=>{
  const origin=req.headers.get("origin");
  const allowedOrigin=!origin||origin==="https://morning-reader.vercel.app"||origin==="https://reader.antonioskilton.com"||origin==="http://localhost:3000"||origin==="http://127.0.0.1:3000"||/^https:\/\/morning-reader(?:-[a-z0-9]+)?-phinneywood\.vercel\.app$/.test(origin);
  if(!allowedOrigin)return json({error:"Origin not allowed"},403);
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  const route=routePath(req);
  try{
    if(route==="/"||route==="/health")return json({ok:true,service:"morning-reader",email_configured:emailConfigured(),time:new Date().toISOString()});
    if(route==="/auth/request-code"&&req.method==="POST"){
      const b=await req.json().catch(()=>({})),email=normEmail(b.email);if(!validEmail(email))return json({error:"Enter a valid email address."},400);
      await requestCode(email);return json({ok:true});
    }
    if(route==="/auth/verify-code"&&req.method==="POST"){
      const b=await req.json().catch(()=>({})),email=normEmail(b.email),code=String(b.code||"").replace(/\D/g,"");
      if(!validEmail(email)||!/^\d{6}$/.test(code))return json({error:"Invalid code."},400);
      const v=await verifyCode(email,code);return json({ok:true,token:v.raw,expires_at:v.expiresAt,...await dashboard(v.user.id,v.user.email)});
    }
    const a=await auth(req);if(!a)return json({error:"Unauthorized"},401);const {user,sessionId}=a;
    if(route==="/auth/logout"&&req.method==="POST"){await admin.from("sessions").update({revoked_at:new Date().toISOString()}).eq("id",sessionId);return json({ok:true})}
    if(route==="/me"&&req.method==="GET")return json(await dashboard(user.id,user.email));
    if(route==="/export"&&req.method==="GET")return json({exported_at:new Date().toISOString(),...await dashboard(user.id,user.email)});
    if(route==="/account"&&req.method==="DELETE"){const{error}=await admin.from("app_users").delete().eq("id",user.id);if(error)throw error;return json({ok:true})}

    if(route==="/settings"&&req.method==="PATCH"){
      const b=await req.json().catch(()=>({}));const {data:cur,error:ce}=await admin.from("user_settings").select("*").eq("user_id",user.id).single();if(ce)throw ce;const p:any={};
      if("kindle_email"in b){const k=normEmail(b.kindle_email);if(k&&!validEmail(k))return json({error:"Enter a valid Send-to-Kindle email address."},400);p.kindle_email=k||null}
      if("timezone"in b){const tz=String(b.timezone||"");if(!validTimezone(tz))return json({error:"Invalid timezone."},400);p.timezone=tz}
      if("delivery_time"in b){const t=String(b.delivery_time||"");if(!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(t))return json({error:"Invalid delivery time."},400);p.delivery_time=t.length===5?`${t}:00`:t}
      if("paused"in b)p.paused=Boolean(b.paused);if("onboarding_complete"in b)p.onboarding_complete=Boolean(b.onboarding_complete);
      p.next_run_at=await nextRun(p.timezone||cur.timezone,p.delivery_time||cur.delivery_time);p.updated_at=new Date().toISOString();
      const{error}=await admin.from("user_settings").update(p).eq("user_id",user.id);if(error)throw error;return json(await dashboard(user.id,user.email));
    }

    if(route==="/sections"&&req.method==="POST"){
      const b=await req.json().catch(()=>({})),name=String(b.name||"").trim();if(!name||name.length>80)return json({error:"Section name must be 1–80 characters."},400);
      const{count}=await admin.from("sections").select("id",{count:"exact",head:true}).eq("user_id",user.id).is("archived_at",null);if((count||0)>=12)return json({error:"You can have up to 12 sections."},400);
      const{error}=await admin.from("sections").insert({user_id:user.id,name,position:count||0});if(error)throw error;return json(await dashboard(user.id,user.email),201);
    }
    const sm=route.match(/^\/sections\/([0-9a-f-]+)$/i);
    if(sm&&req.method==="PATCH"){
      const b=await req.json().catch(()=>({})),p:any={updated_at:new Date().toISOString()};if("name"in b){const n=String(b.name||"").trim();if(!n||n.length>80)return json({error:"Section name must be 1–80 characters."},400);p.name=n}if("enabled"in b)p.enabled=Boolean(b.enabled);
      const{error}=await admin.from("sections").update(p).eq("id",sm[1]).eq("user_id",user.id);if(error)throw error;return json(await dashboard(user.id,user.email));
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
      let activeCount=feedCount||0,nextPosition=sections.length?Math.max(...sections.map((s:any)=>Number(s.position)||0))+1:0;

      const probed:any[]=new Array(items.length);let cursor=0;
      async function worker(){
        while(true){
          const i=cursor++;if(i>=items.length)return;
          const item=items[i]||{},input=String(item.url||"").trim(),requestedName=String(item.name||"").trim(),sectionId=String(item.section_id||"").trim(),sectionName=String(item.section_name||"").trim();
          if(!validUrl(input)){probed[i]={index:i,input,requestedName,sectionId,sectionName,error:"Enter a valid website or RSS/Atom address."};continue}
          if(!sectionId&&!sectionName){probed[i]={index:i,input,requestedName,sectionId,sectionName,error:"Choose an edition for this feed."};continue}
          if(sectionName.length>80){probed[i]={index:i,input,requestedName,sectionId,sectionName,error:"Edition name must be 80 characters or fewer."};continue}
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
            if(sections.length>=12){results.push({index:item.index,input:item.input,name:item.name,status:"failed",error:"You can have up to 12 editions."});continue}
            const{data:created,error:createError}=await admin.from("sections").insert({user_id:user.id,name:item.sectionName,position:nextPosition++}).select("id,name,position").single();
            if(createError){results.push({index:item.index,input:item.input,name:item.name,status:"failed",error:String(createError.message||createError)});continue}
            section=created;sections.push(created);sectionById.set(created.id,created);sectionByName.set(String(created.name).trim().toLowerCase(),created);
          }
        }
        if(!section){results.push({index:item.index,input:item.input,name:item.name,status:"failed",error:"Edition not found."});continue}

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
      return json({ok:true,summary,results,dashboard:await dashboard(user.id,user.email)});
    }

    if(route==="/feeds"&&req.method==="POST"){
      const b=await req.json().catch(()=>({})),input=String(b.url||"").trim(),sectionId=String(b.section_id||"");if(!validUrl(input))return json({error:"Enter a valid website or RSS/Atom address."},400);
      const{data:sec}=await admin.from("sections").select("id").eq("id",sectionId).eq("user_id",user.id).is("archived_at",null).maybeSingle();if(!sec)return json({error:"Section not found."},404);
      const{count}=await admin.from("feeds").select("id",{count:"exact",head:true}).eq("user_id",user.id).is("archived_at",null);if((count||0)>=100)return json({error:"You can have up to 100 feeds."},400);
      let pr;try{pr=await probe(input)}catch(e){return json({error:e instanceof Error?e.message:String(e)},400)}
      const url=normalizeUrl(pr.url),name=(String(b.name||"").trim()||pr.title||new URL(url).hostname.replace(/^www\./,"")).slice(0,120);
      const{data:existing,error:existingError}=await admin.from("feeds").select("id,archived_at").eq("user_id",user.id).eq("url",url).maybeSingle();if(existingError)throw existingError;
      if(existing){
        if(!existing.archived_at)return json({error:"This source is already in one of your editions. Move it instead of adding it again."},409);
        const{error}=await admin.from("feeds").update({section_id:sectionId,name,kind:"standard",enabled:true,archived_at:null,last_error:null,last_fetch_at:new Date().toISOString()}).eq("id",existing.id).eq("user_id",user.id);if(error)throw error;
        return json(await dashboard(user.id,user.email),200);
      }
      const{error}=await admin.from("feeds").insert({user_id:user.id,section_id:sectionId,name,url,kind:"standard",enabled:true});
      if(error){if((error as any)?.code==="23505")return json({error:"This source is already in one of your editions. Move it instead of adding it again."},409);throw error}
      return json(await dashboard(user.id,user.email),201);
    }
    const fm=route.match(/^\/feeds\/([0-9a-f-]+)$/i);
    if(fm&&req.method==="PATCH"){
      const b=await req.json().catch(()=>({})),p:any={updated_at:new Date().toISOString()};if("name"in b){const n=String(b.name||"").trim();if(!n||n.length>120)return json({error:"Feed name must be 1–120 characters."},400);p.name=n}if("enabled"in b)p.enabled=Boolean(b.enabled);
      if("section_id"in b){const{data:sec}=await admin.from("sections").select("id").eq("id",b.section_id).eq("user_id",user.id).is("archived_at",null).maybeSingle();if(!sec)return json({error:"Section not found."},404);p.section_id=b.section_id}
      const{error}=await admin.from("feeds").update(p).eq("id",fm[1]).eq("user_id",user.id);if(error)throw error;return json(await dashboard(user.id,user.email));
    }
    if(fm&&req.method==="DELETE"){const now=new Date().toISOString();const{error}=await admin.from("feeds").update({archived_at:now,enabled:false}).eq("id",fm[1]).eq("user_id",user.id);if(error)throw error;return json(await dashboard(user.id,user.email))}

    if(route==="/preview"&&req.method==="POST"){
      const{data:feeds,error}=await admin.from("feeds").select("*").eq("user_id",user.id).eq("enabled",true).is("archived_at",null).limit(40);if(error)throw error;const rs=[];for(const f of feeds||[])rs.push(await preview(f));
      const items=rs.flatMap((r:any)=>r.items).sort((a:any,b:any)=>(b.published_at?+new Date(b.published_at):0)-(a.published_at?+new Date(a.published_at):0)).slice(0,60);return json({items,feeds:rs});
    }
    if((route==="/send-now"||route==="/send-test")&&req.method==="POST"){
      const{data:s}=await admin.from("user_settings").select("kindle_email").eq("user_id",user.id).single();if(!s?.kindle_email)return json({error:"Add your Send-to-Kindle email first."},400);const reason=route==="/send-test"?"test":"manual";
      const{data:job,error}=await admin.from("digest_jobs").insert({user_id:user.id,reason,lookback_hours:168,idempotency_key:`${reason}:${user.id}:${crypto.randomUUID()}`,run_after:new Date().toISOString()}).select("id,status,reason,created_at").single();if(error)throw error;
      const now=Date.now(),nextBoundary=new Date(Math.ceil((now+1000)/300000)*300000).toISOString();
      const{data:kick,error:kickError}=await admin.rpc("kick_digest_worker");
      return json({ok:true,job,worker_triggered:!kickError&&Boolean(kick),next_worker_check_at:nextBoundary},202);
    }
    return json({error:"Not found"},404);
  }catch(e:any){console.error(e);return json({error:String(e?.message||e).slice(0,600)},Number(e?.status)||500)}
});