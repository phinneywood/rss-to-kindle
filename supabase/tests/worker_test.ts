// Full worker orchestration with real extraction/EPUB generation. All HTTP is
// replaced in-process: no credentials, production records or emails are used.
import JSZip from "npm:jszip@3.10.1";
Deno.env.set("SUPABASE_URL", "https://database.example.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-only-key");
Deno.env.set("RESEND_API_KEY", "test-only-key");
Deno.env.set("OPENAI_API_KEY", "test-only-key");
const { processJob, handleWorkerRequest } = await import("../functions/worker/core.ts");
function assert(value: unknown, message = "Assertion failed"): asserts value { if (!value) throw new Error(message); }

async function scenario(mode: "empty" | "failed" | "partial" | "retry" | "prepare_retry" | "scheduled" | "rescheduled" | "test" | "classified") {
  const original = globalThis.fetch;
  const job: any = { id: "job-1", user_id: "user-1", status: "queued", attempts: mode === "failed" ? 2 : 0, reason: "manual", created_at: new Date().toISOString(), lookback_hours: 168 };
  if(mode === "scheduled" || mode === "rescheduled")Object.assign(job,{reason:"scheduled",section_id:"section-1",schedule_version:1,lookback_hours:192});
  if(mode === "test")Object.assign(job,{reason:"test",lookback_hours:168});
  let outbox: any = null, sends = 0, failFinalUpdate = mode === "retry", failOutboxInsert = mode === "prepare_retry";
  const feedUpdates: any[] = [];
  const good = { id: "feed-1", user_id: job.user_id, section_id: "section-1", name: "Example", url: "https://8.8.8.8/feed" };
  const bad = { ...good, id: "feed-2", name: "Broken source", url: "https://8.8.8.8/broken" };
  const feeds = mode === "empty" ? [] : mode === "failed" ? [bad] : mode === "partial" ? [good, bad] : mode === "scheduled" ? [good,{...bad,section_id:"section-2"}] : [good];
  const fetched: string[]=[];
  let articleDeliveryReads = 0, articleDeliveryWrites = 0;
  const snapshots: string[] = [];
  const manifestWrites: any[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), url = new URL(req.url);
    if (url.hostname === "api.resend.com") { sends++;snapshots.push(await req.text());return Response.json({ id: "email-1" }); }
    if (url.hostname === "api.openai.com") {
      const payload = JSON.parse(await req.text());
      const format = payload?.text?.format?.name;
      const userContent = JSON.parse(payload?.input?.at(-1)?.content || "{}");
      if (format === "morning_reader_issue_organization") {
        const plan = {
          articles: (userContent.candidates || []).map((candidate: any) => ({
            id: candidate.id,
            section_name: candidate.title === "Drop me" ? "Other" : "Fixture section",
            topic_name: null,
          })),
        };
        return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(plan) }] }], usage: { input_tokens: 10, output_tokens: 10 } });
      }
      if (format === "morning_reader_related_discovery" || format === "morning_reader_open_discovery") {
        return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ articles: [] }) }] }], usage: { input_tokens: 10, output_tokens: 2 } });
      }
      if (format === "morning_reader_issue_introduction") {
        const paragraph = "Tools acquire boundaries, teams acquire rituals, and systems become legible when something pushes against their edges. The stories here circle that pressure from different directions: software needs supervision, organizations reveal their shape through failure, and a quieter detour makes structure easier to see from the side. The morning’s recurring question is simple enough to state and harder to answer: once a system starts acting on its own, who gets to decide where it stops?";
        return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ paragraph }) }] }], usage: { input_tokens: 40, output_tokens: 110 } });
      }
      return new Response("unexpected OpenAI request", { status: 400 });
    }
    if (url.hostname === "8.8.8.8") {
      fetched.push(url.pathname);
      if (url.pathname === "/broken") return new Response("Unavailable", { status: 503 });
      if (url.pathname.endsWith(".png")) return new Response(new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
      if (mode === "classified" && url.pathname === "/feed") {
        const body = "Substantial original reading text. ".repeat(24);
        return new Response(`<rss><channel>
          <item><title>Keep me</title><link>https://8.8.8.8/keep-article</link><content:encoded><![CDATA[<p>${body}</p><img src="https://8.8.8.8/keep.png" alt="Keep">]]></content:encoded></item>
          <item><title>Drop me</title><link>https://8.8.8.8/drop-article</link><content:encoded><![CDATA[<p>${body}</p><img src="https://8.8.8.8/drop.png" alt="Drop">]]></content:encoded></item>
        </channel></rss>`);
      }
      if (mode === "test" && url.pathname === "/feed") {
        const body = "Substantial original reading text. ".repeat(24);
        return new Response(`<rss><channel>${Array.from({length:5},(_,i)=>`<item><title>Test article ${i+1}</title><link>https://8.8.8.8/article-${i+1}</link><content:encoded><![CDATA[<p>${body}</p><img src="https://8.8.8.8/test-${i+1}.png" alt="Test image ${i+1}">]]></content:encoded></item>`).join("")}</channel></rss>`);
      }
      return new Response(`<rss><channel><item><title>Example article</title><link>https://8.8.8.8/article</link>${mode==='scheduled'?`<pubDate>${new Date(Date.now()-5*86400_000).toUTCString()}</pubDate>`:''}<content:encoded><![CDATA[<p>${"Substantial original reading text. ".repeat(24)}</p>]]></content:encoded></item></channel></rss>`);
    }
    assert(url.hostname === "database.example.invalid", "Unexpected network call " + url.hostname);
    if (url.pathname.includes("/rpc/kick_digest_worker")) return Response.json(1);
    const table = url.pathname.split('/').at(-1);
    const body = req.method === "GET" ? null : await req.json();
    let rows: any[] = [];
    if (table === "digest_jobs") {
      if (body?.status === "sent" && failFinalUpdate) { failFinalUpdate = false;return Response.json({ message: "Final status database failure" }, { status: 500 }); }
      if (body?.result?.preparation_manifest) manifestWrites.push(structuredClone(body.result.preparation_manifest));
      if (body) Object.assign(job, body);
      rows = [structuredClone(job)];
    } else if (table === "delivery_outbox") {
      if (req.method === "POST" && failOutboxInsert) { failOutboxInsert = false;return Response.json({ message: "Outbox unavailable after manifest freeze" }, { status: 500 }); }
      if (req.method === "POST") outbox = { ...body, first_send_at: null, provider_email_id: null };
      if (req.method === "PATCH") Object.assign(outbox, body);
      rows = outbox ? [outbox] : [];
    } else if (table === "user_settings") rows = [{ kindle_email: "test@example.com", timezone: "UTC",paused:false,onboarding_complete:true,editorial_brief:"Systems, software, design, and thoughtful long-form reading." }];
    else if (table === "sections") {
      rows = [{ id: "section-1", name: "Reading",enabled:true,delivery_days:[0,1,2,3,4,5,6] },{id:"section-2",name:"Other section",enabled:true,delivery_days:[]}];
      const idFilter = url.searchParams.get("id");
      if (idFilter?.startsWith("eq.")) rows = rows.filter(row => row.id === idFilter.slice(3));
    }
    else if (table === "feeds") { if (body) feedUpdates.push(body);else rows = feeds; }
    else if (table === "digests") rows = [{ id: "digest-1" }];
    else if (table === "pending_issue_articles") rows = [];
    else if (table === "article_deliveries") {
      if (req.method === "GET") articleDeliveryReads++;
      else articleDeliveryWrites++;
    }
    else throw new Error("Unexpected table: " + table);
    return Response.json(req.headers.get("accept")?.includes("vnd.pgrst.object") ? rows[0] : rows);
  }) as typeof fetch;
  try {
    const initial = await processJob(structuredClone(job));
    const sendsAfterInitial = sends;
    const manifestsAfterInitial = manifestWrites.length;
    let first = initial;
    if (initial?.continuation === "frozen-manifest") first = await processJob(structuredClone(job));
    if (mode === "retry" || mode === "prepare_retry") {
      assert(first?.status === "queued", JSON.stringify(first));
      await processJob(structuredClone(job));
    }
    return { initial, first, sendsAfterInitial, manifestsAfterInitial, job, outbox, sends, feedUpdates, snapshots, fetched, articleDeliveryReads, articleDeliveryWrites, manifestWrites };
  } finally { globalThis.fetch = original; }
}

Deno.test("worker distinguishes an empty edition from failed sources", async () => {
  const empty = await scenario("empty"), failed = await scenario("failed");
  assert(empty.job.status === "empty");assert(failed.job.status === "failed", JSON.stringify(failed));
  assert(empty.sends === 0 && failed.sends === 0);assert(failed.job.error.includes("Broken source"));
});

Deno.test("worker splits agentic preparation from deterministic packaging and submits the frozen issue", async () => {
  const result = await scenario("partial");
  assert(result.initial?.continuation === "frozen-manifest", "fresh v2 preparation should stop after freezing the manifest");
  assert(result.sendsAfterInitial === 0, "the agentic preparation invocation must not package or send");
  assert(result.manifestsAfterInitial === 1, "the manifest must be frozen before continuation");
  assert(typeof result.manifestWrites[0].introduction === "string" && result.manifestWrites[0].introduction.length > 200, "the Luna introduction should be frozen with the manifest");
  assert(result.job.status === "partial", JSON.stringify(result.first));assert(result.sends === 1);
  assert(result.job.result.articles === 1);assert(result.job.result.issues.some((x: string) => x.includes("Broken source")));
  assert(result.job.result.editorial?.organization?.status === "edited", "organizer diagnostics must survive outbox freezing");
  assert(result.job.result.editorial?.introduction?.status === "written", "Luna introduction diagnostics must survive outbox freezing");
  assert(result.job.result.editorial?.discovery?.related?.status === "discovered", "related-discovery diagnostics must survive outbox freezing");
  assert(result.outbox.payload.editorial?.organization?.status === "edited", "frozen outbox must retain organizer diagnostics");
  assert(result.outbox.payload.editorial?.discovery?.open?.status === "discovered", "frozen outbox must retain discovery diagnostics");
  assert(result.outbox.payload.email.attachments[0].filename.endsWith(".epub"));
  assert(result.job.result.qa?.contentsEntries === 1, "pre-send QA must survive outbox freezing and final job diagnostics");
  assert(result.outbox.payload.qa?.contentsEntries === 1, "frozen payload should retain EPUB QA evidence");
});

Deno.test("worker reconciles accepted delivery without resending after final status failure", async () => {
  const result = await scenario("retry");
  assert(result.job.status === "sent", JSON.stringify(result.first));assert(result.sends === 1, "A reconciliation retry must not resubmit accepted mail");
});

Deno.test("retry reuses the frozen preparation manifest instead of rediscovering live feeds", async () => {
  const result = await scenario("prepare_retry");
  assert(result.job.status === "sent", JSON.stringify(result.first));
  assert(result.sends === 1, "the successful retry should submit exactly one email");
  assert(result.fetched.filter((path: string) => path === "/feed").length === 1, "feed discovery must not rerun after the manifest has been frozen");
  assert(result.manifestWrites.length === 1, "the selected issue should be frozen exactly once across retries");
  assert(result.manifestWrites[0].version === 2, "new recurring runs should freeze the v2 agentic manifest");
  assert(result.manifestWrites[0].groups[0].items.length === 1, "the frozen manifest should preserve the organized article set");
});

Deno.test("scheduled issues ignore legacy section frequency and read all enabled sources",async()=>{
  const r=await scenario("scheduled");assert(r.job.status==='partial',JSON.stringify(r.first));assert(r.sends===1);
  assert(r.fetched.includes('/broken'),"legacy section schedules must not suppress enabled sources");
  assert(r.outbox.payload.email.attachments.length===1,"daily issue must have exactly one EPUB");
  assert(r.outbox.payload.email.attachments[0].filename.startsWith("morning-reader-"));
  assert(r.job.result.articles===1);
});

Deno.test("worker rejects requests without its configured authentication", async () => {
  const response = await handleWorkerRequest(new Request("https://worker.example.invalid", { method: "POST" }));
  assert(response.status === 401);
});

Deno.test("stale recovery terminalizes exhausted jobs and requeues retryable jobs", async () => {
  const original = globalThis.fetch;
  const updates: { query: string; body: any }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), url = new URL(req.url);
    if (url.pathname.includes('/rpc/')) return Response.json(true);
    if (req.method === 'PATCH') updates.push({ query: url.search, body: await req.json() });
    return Response.json([]);
  }) as typeof fetch;
  try {
    const response = await handleWorkerRequest(new Request("https://worker.example.invalid", { method: "POST", headers: { "x-worker-secret": "fake-test-secret" } }));
    assert(response.status === 200);
    assert(updates.some(u => u.query.includes('attempts=lt.3') && u.body.status === 'queued'));
    assert(updates.some(u => u.query.includes('attempts=gte.3') && u.body.status === 'failed' && u.body.finished_at));
  } finally { globalThis.fetch = original; }
});


Deno.test("explicit test sends are uniquely reviewable on Kindle without consuming recurring delivery history", async () => {
  const result = await scenario("test");
  assert(result.job.status === "sent", JSON.stringify(result.first));
  assert(result.sends === 1, "test send should still deliver a real EPUB");
  assert(result.job.result.articles === 5, "test send should preserve full issue length instead of truncating to three articles per section");
  assert(!result.fetched.some((path: string) => /^\/test-\d+\.png$/.test(path)), "full-length test sends should not fetch inline article images");
  assert(result.articleDeliveryReads === 0, "test send should not suppress articles based on recurring delivery history");
  assert(result.articleDeliveryWrites === 0, "test send should not consume articles from future recurring issues");

  const email = result.outbox.payload.email;
  assert(/^Morning Reader · TEST \d{2}:\d{2}:\d{2} · JOB1 · /.test(email.subject), "test email subject should carry a timestamped review identity");
  assert(/^morning-reader-test-\d{4}-\d{2}-\d{2}-\d{6}-job1\.epub$/.test(email.attachments[0].filename), "test attachment filename should be unique and sortable");

  const bytes = Uint8Array.from(atob(email.attachments[0].content), (char) => char.charCodeAt(0));
  const zip = await JSZip.loadAsync(bytes);
  const opf = await zip.file("OEBPS/content.opf")!.async("string");
  const contents = await zip.file("OEBPS/contents.xhtml")!.async("string");
  const introduction = await zip.file("OEBPS/introduction.xhtml")!.async("string");
  const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
  assert(/<dc:title>Morning Reader · TEST \d{2}:\d{2}:\d{2} · JOB1<\/dc:title>/.test(opf), "Kindle library metadata should distinguish every test run");
  assert(introduction.includes('<p class="intro-kicker">Editor\'s note</p>'), "the first editorial page should identify itself as the editor note");
  assert(introduction.includes("Tools acquire boundaries, teams acquire rituals"), "the EPUB should contain the exact frozen Luna introduction");
  assert(opf.indexOf('<itemref idref="introduction"/>') < opf.indexOf('<itemref idref="contents"/>'), "the Luna introduction must precede contents in reading order");
  assert(nav.includes('href="introduction.xhtml">Editor&#39;s note</a>'), "native navigation should expose the editor note");
  assert(contents.includes("<h1 class=\"publication-title\">Morning Reader</h1>"), "test interior should keep the production publication title");
  assert(!contents.includes("TEST "), "test identity should not pollute the production-like reading interior");
  for (let index = 1; index <= 5; index++) {
    assert(contents.includes(`href="article-${index}.xhtml">Test article ${index}</a>`), "every test article should appear as a linked title in the opening contents");
  }
  assert(result.job.result.qa?.contentsEntries === 5, "end-to-end QA should count every article-title contents entry");
  assert(result.job.result.media?.omitted === 5, "test-send media diagnostics should record intentionally omitted inline images without fetching them");
});


Deno.test("organizer never filters an eligible RSS article before image hydration", async () => {
  const result = await scenario("classified");
  assert(result.job.status === "sent", JSON.stringify(result.first));
  assert(result.job.result.articles === 2, "every eligible RSS article must be delivered");
  assert(result.fetched.includes("/keep.png"), "first eligible article image should be hydrated");
  assert(result.fetched.includes("/drop.png"), "an article placed in Other must still have its media hydrated");
  assert(result.job.result.editorial.organization.other >= 1, "organizer diagnostics should record Other placement");
  assert(result.job.result.qa?.contentsEntries === 2, "organized delivery should pass article-title contents QA for every eligible article");
  assert(result.job.result.media?.discovered === 2 && result.job.result.media?.embedded === 2, "production media diagnostics should include both eligible articles");
});
