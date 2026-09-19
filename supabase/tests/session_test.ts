Deno.env.set("SUPABASE_URL","https://session-tests.example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY","test-key-not-a-secret");
const {admin,auth,sha256}=await import("../functions/app-api/core.ts");
function assert(value:unknown,message="Assertion failed"):asserts value{if(!value)throw new Error(message)}

Deno.test("session validation hashes the token and uses the atomic renewal result",async()=>{
  const original=admin.rpc;
  let called=false;
  admin.rpc=((name:string,args:any)=>{
    called=true;assert(name==="authenticate_app_session");assert(args.p_token_hash===expected);
    return Promise.resolve({data:[{session_id:"device-1",user_id:"reader-1",email:"reader@example.test"}],error:null});
  }) as unknown as typeof admin.rpc;
  const expected=await sha256("browser-token");
  try{
    assert(await auth(new Request("https://example.test/me"))===null);assert(!called);
    const result=await auth(new Request("https://example.test/me",{headers:{Authorization:"Bearer browser-token"}}));
    assert(result?.sessionId==="device-1");assert(result?.user.id==="reader-1");assert(called);
  }finally{admin.rpc=original}
});

Deno.test("database outages are retryable errors, not unauthorized responses",async()=>{
  const original=admin.rpc;
  admin.rpc=(()=>Promise.resolve({data:null,error:{message:"Database offline"}})) as unknown as typeof admin.rpc;
  try{
    let caught=false;
    try{await auth(new Request("https://example.test/me",{headers:{Authorization:"Bearer saved-token"}}))}
    catch(error){caught=true;assert((error as {status:number}).status===503)}
    assert(caught);
  }finally{admin.rpc=original}
});

Deno.test("expired and revoked tokens produce an unauthorized result",async()=>{
  const original=admin.rpc;
  admin.rpc=(()=>Promise.resolve({data:[],error:null})) as unknown as typeof admin.rpc;
  try{assert(await auth(new Request("https://example.test/me",{headers:{Authorization:"Bearer expired-token"}}))===null)}
  finally{admin.rpc=original}
});
