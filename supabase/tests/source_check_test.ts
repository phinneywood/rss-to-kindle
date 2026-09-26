// Exercise the actual HTTP handler with all external requests mocked.
Deno.env.set("SUPABASE_URL","https://source-check.example.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY","test-only-key");
let handler:(req:Request)=>Promise<Response>;
const originalServe=Deno.serve;
Deno.serve=((fn:typeof handler)=>{handler=fn;return {} as Deno.HttpServer}) as typeof Deno.serve;
try{await import("../functions/app-api/index.ts")}finally{Deno.serve=originalServe}
function assert(value:unknown,message="Assertion failed"):asserts value{if(!value)throw new Error(message)}

async function check(mode:"healthy"|"failed"|"foreign"|"archived"|"anonymous"){
  const originalFetch=globalThis.fetch;
  const id="11111111-1111-4111-8111-111111111111";
  const feed:any={id,user_id:"user-1",section_id:"section-1",name:"Example",url:"https://8.8.8.8/feed",enabled:false,last_error:"Old error",consecutive_failures:1};
  let fetched=0,updated=0;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const req=new Request(input,init),url=new URL(req.url);
    if(url.hostname==="8.8.8.8"){
      fetched++;
      return mode==="failed"?new Response("Unavailable",{status:503}):new Response('<rss><channel><item><title>Example</title><link>https://8.8.8.8/article</link></item></channel></rss>');
    }
    assert(url.hostname==="source-check.example.invalid","Unexpected external request: "+url.hostname);
    const table=url.pathname.split('/').at(-1);
    if(table==="authenticate_app_session")return Response.json([{session_id:"session-1",user_id:"user-1",email:"test@example.invalid"}]);
    if(table==="feeds"){
      if(req.method==="PATCH"){
        updated++;Object.assign(feed,await req.json());return new Response(null,{status:204});
      }
      if(url.searchParams.has("id")){
        assert(url.searchParams.get("id")==="eq."+id);
        assert(url.searchParams.get("user_id")==="eq.user-1","Must restrict source lookup to the session owner");
        assert(url.searchParams.get("archived_at")==="is.null","Must exclude removed sources");
        return Response.json(mode==="foreign"||mode==="archived"?null:feed);
      }
      return Response.json([feed]);
    }
    if(table==="user_settings")return Response.json({paused:true});
    if(table==="sections")return Response.json([{id:"section-1",name:"Reading"}]);
    assert(table==="digests"||table==="digest_jobs","Unexpected data access: "+table);
    assert(req.method==="GET","Source checks must not queue or send an issue");
    return Response.json([]);
  }) as typeof fetch;
  try{
    const response=await handler!(new Request('https://source-check.example.invalid/app-api/feeds/'+id+'/check',{method:'POST',headers:mode==="anonymous"?{}:{Authorization:'Bearer test-session'}}));
    return {status:response.status,body:await response.json(),feed,fetched,updated};
  }finally{globalThis.fetch=originalFetch}
}

Deno.test("source recheck clears health errors without resuming a paused feed or sending",async()=>{
  const r=await check("healthy");assert(r.status===200);assert(r.fetched===1&&r.updated===1);assert(r.feed.enabled===false);assert(r.feed.last_error===null);assert(r.body.dashboard.sections[0].feeds[0].last_error===null);assert(r.body.result.items.length===1);
});
Deno.test("source recheck persists publisher failures for the dialog and dashboard",async()=>{
  const r=await check("failed");assert(r.status===200);assert(r.body.result.error);assert(r.feed.last_error);assert(r.feed.consecutive_failures===2);
});
Deno.test("source recheck rejects anonymous, other-account and archived sources before fetching",async()=>{
  for(const mode of ["anonymous","foreign","archived"] as const){const r=await check(mode);assert(r.status===(mode==="anonymous"?401:404));assert(r.fetched===0&&r.updated===0)}
});


async function editSource(urlValue:string){
  const originalFetch=globalThis.fetch;
  const id="11111111-1111-4111-8111-111111111111";
  const feed:any={id,user_id:"user-1",section_id:"section-1",name:"Example",url:"https://8.8.8.8/feed",enabled:true,last_error:"Old error",consecutive_failures:3,archived_at:null};
  let publisherFetches=0,updates=0;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const req=new Request(input,init),url=new URL(req.url);
    if(url.hostname==="8.8.8.8"){
      publisherFetches++;
      return new Response('<rss><channel><title>Replacement</title><item><title>Example</title><link>https://8.8.8.8/article</link></item></channel></rss>',{headers:{"content-type":"application/rss+xml"}});
    }
    assert(url.hostname==="source-check.example.invalid","Unexpected external request: "+url.hostname);
    const table=url.pathname.split('/').at(-1);
    if(table==="authenticate_app_session")return Response.json([{session_id:"session-1",user_id:"user-1",email:"test@example.invalid"}]);
    if(table==="feeds"){
      if(req.method==="PATCH"){
        updates++;Object.assign(feed,await req.json());return Response.json({id});
      }
      if(url.searchParams.get("select")==="id"&&url.searchParams.get("id")?.startsWith("neq."))return Response.json(null);
      return Response.json([feed]);
    }
    if(table==="user_settings")return Response.json({paused:true});
    if(table==="sections")return Response.json([{id:"section-1",name:"Reading"}]);
    if(table==="digests"||table==="digest_jobs")return Response.json([]);
    throw new Error("Unexpected data access: "+table);
  }) as typeof fetch;
  try{
    const response=await handler!(new Request('https://source-check.example.invalid/app-api/feeds/'+id,{method:'PATCH',headers:{Authorization:'Bearer test-session',"content-type":"application/json"},body:JSON.stringify({name:"Replacement",url:urlValue})}));
    return {status:response.status,body:await response.json(),feed,publisherFetches,updates};
  }finally{globalThis.fetch=originalFetch}
}

Deno.test("source editing validates and saves a replacement feed while clearing stale health errors",async()=>{
  const r=await editSource("https://8.8.8.8/new-feed");
  assert(r.status===200,JSON.stringify(r.body));assert(r.publisherFetches>=1);assert(r.updates===1);
  assert(r.feed.name==="Replacement");assert(r.feed.url==="https://8.8.8.8/new-feed");assert(r.feed.last_error===null);assert(r.feed.consecutive_failures===0);
});

Deno.test("source editing rejects invalid replacement URLs before touching the source",async()=>{
  const r=await editSource("not a url");
  assert(r.status===400);assert(r.publisherFetches===0);assert(r.updates===0);
});
