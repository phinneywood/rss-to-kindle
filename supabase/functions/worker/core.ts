import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { XMLParser } from "npm:fast-xml-parser@5.11.1";
import { extractArticle, fetchPublicText, textValue } from "../_shared/article.ts";
import { makeEpub, type EpubArticle } from "../_shared/epub.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", cdataPropName: "__cdata" });
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function logEvent(event: string, fields: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info") {
  const line = JSON.stringify({ ts: new Date().toISOString(), service: "worker", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

function array<T = any>(value: T | T[] | null | undefined): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function entryHref(value: any): string {
  if (typeof value === "string") return value;
  for (const candidate of array(value)) {
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object" && candidate["@_href"] && (!candidate["@_rel"] || candidate["@_rel"] === "alternate")) {
      return String(candidate["@_href"]);
    }
  }
  return "";
}

function stripTracking(input: string) {
  try {
    const url = new URL(input);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return input.split("#")[0];
  }
}

function entryDate(entry: any) {
  const raw = textValue(entry.pubDate || entry.published || entry.updated || entry["dc:date"]);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(+date) ? null : date.toISOString();
}

function entryAuthor(entry: any) {
  const value = entry.author?.name || entry.author || entry["dc:creator"] || null;
  return textValue(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
}

function entryContent(entry: any): { html: string; kind: "full" | "summary" } {
  if (entry["content:encoded"] != null) return { html: textValue(entry["content:encoded"]), kind: "full" };
  if (entry.content != null) return { html: textValue(entry.content), kind: "full" };
  if (entry.description != null) return { html: textValue(entry.description), kind: "summary" };
  return { html: textValue(entry.summary || ""), kind: "summary" };
}

async function readFeed(feed: any, cutoff: Date, jobId: string, deadline = Number.POSITIVE_INFINITY): Promise<EpubArticle[]> {
  const started = performance.now();
  try {
    const { text } = await fetchPublicText(feed.url, "application/rss+xml, application/atom+xml, application/xml, text/xml, */*", 2_500_000);
    const parsed: any = parser.parse(text);
    let entries: any[] = [];
    if (parsed?.rss?.channel?.item) entries = array(parsed.rss.channel.item);
    else if (parsed?.feed?.entry) entries = array(parsed.feed.entry);
    else if (parsed?.["rdf:RDF"]?.item) entries = array(parsed["rdf:RDF"].item);
    const articles: EpubArticle[] = [];
    for (const entry of entries.slice(0, 20)) {
      if (articles.length >= 12 || performance.now() > deadline) break;
      const url = stripTracking(entryHref(entry.link) || textValue(entry.guid || entry.id));
      if (!url) continue;
      const publishedAt = entryDate(entry);
      if (publishedAt && new Date(publishedAt) < cutoff) continue;
      const title = textValue(entry.title).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
      const content = entryContent(entry);
      try {
        const article = await extractArticle({
          url,
          title,
          source: feed.name,
          author: entryAuthor(entry),
          publishedAt,
          feedHtml: content.html,
          feedKind: content.kind,
          includeImages: true,
        });
        articles.push({ ...article, feed_id: feed.id, section_id: feed.section_id });
        if (article.warnings.length) logEvent("article.extracted_with_warnings", { job_id: jobId, feed_id: feed.id, url, warnings: article.warnings });
      } catch (error) {
        logEvent("article.extract_failed", { job_id: jobId, feed_id: feed.id, url, error: error instanceof Error ? error.message : String(error) }, "warn");
      }
    }
    const now = new Date().toISOString();
    await admin.from("feeds").update({ last_fetch_at: now, last_success_at: now, last_error: null, consecutive_failures: 0 }).eq("id", feed.id);
    return articles;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failures = Number(feed.consecutive_failures || 0) + 1;
    await admin.from("feeds").update({ last_fetch_at: new Date().toISOString(), last_error: message.slice(0, 500), consecutive_failures: failures }).eq("id", feed.id);
    let host = "";
    try { host = new URL(feed.url).hostname; } catch { /* invalid feed URL */ }
    logEvent("feed.fetch_failed", { job_id: jobId, user_id: feed.user_id, feed_id: feed.id, host, error: message.slice(0, 300), consecutive_failures: failures, duration_ms: Math.round(performance.now() - started) }, failures >= 3 ? "error" : "warn");
    return [];
  }
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "reading";
}

function localDateKey(timezone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function base64(bytes: Uint8Array) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 0x8000) output += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(output);
}

async function sendResend(to: string, attachments: any[], jobId: string, subject: string) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is missing.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `morning-reader-${jobId}` },
    body: JSON.stringify({
      from: "Morning Reader <reader@antonioskilton.com>",
      to: [to],
      subject,
      text: attachments.length === 1 ? "Your Morning Reader edition is attached." : "Your Morning Reader editions are attached.",
      attachments,
    }),
  });
  const responseBody = await response.text();
  if (!response.ok) throw new Error(`Email provider error (${response.status}): ${responseBody.slice(0, 400)}`);
  return JSON.parse(responseBody);
}

async function queueScheduled() {
  const now = new Date().toISOString();
  const { data: missing } = await admin.from("user_settings").select("user_id,timezone,delivery_time").eq("paused", false).eq("onboarding_complete", true).not("kindle_email", "is", null).is("next_run_at", null).limit(50);
  for (const settings of missing || []) {
    const { data: next } = await admin.rpc("next_delivery_at", { p_timezone: settings.timezone, p_time: settings.delivery_time, p_from: now });
    if (next) await admin.from("user_settings").update({ next_run_at: next }).eq("user_id", settings.user_id);
  }
  const { data: due } = await admin.from("user_settings").select("user_id,timezone,delivery_time,next_run_at").eq("paused", false).eq("onboarding_complete", true).not("kindle_email", "is", null).lte("next_run_at", now).limit(20);
  for (const settings of due || []) {
    const key = `scheduled:${settings.user_id}:${settings.next_run_at}`;
    await admin.from("digest_jobs").upsert({ user_id: settings.user_id, reason: "scheduled", lookback_hours: 48, idempotency_key: key, run_after: now }, { onConflict: "idempotency_key", ignoreDuplicates: true });
    const from = new Date(new Date(settings.next_run_at).getTime() + 60_000).toISOString();
    const { data: next } = await admin.rpc("next_delivery_at", { p_timezone: settings.timezone, p_time: settings.delivery_time, p_from: from });
    if (next) await admin.from("user_settings").update({ next_run_at: next }).eq("user_id", settings.user_id);
  }
}

async function digestForGroup(job: any, group: { section: any; items: EpubArticle[] }, providerEmailId: string) {
  const row = {
    user_id: job.user_id,
    section_id: group.section.id || null,
    edition_name: group.section.name,
    job_id: job.id,
    scheduled_for: job.reason === "scheduled" ? job.run_after : null,
    status: "sent",
    article_count: group.items.length,
    provider_email_id: providerEmailId,
    sent_at: new Date().toISOString(),
  };
  let digest: any = null;
  if (row.section_id) {
    const result = await admin.from("digests").upsert(row, { onConflict: "job_id,section_id" }).select("id").single();
    if (result.error) throw result.error;
    digest = result.data;
  } else {
    const existing = await admin.from("digests").select("id").eq("job_id", job.id).is("section_id", null).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      const result = await admin.from("digests").update(row).eq("id", existing.data.id).select("id").single();
      if (result.error) throw result.error;
      digest = result.data;
    } else {
      const result = await admin.from("digests").insert(row).select("id").single();
      if (result.error) throw result.error;
      digest = result.data;
    }
  }
  const deliveries = group.items.map((article) => ({
    user_id: job.user_id,
    feed_id: article.feed_id || null,
    section_id: article.section_id || null,
    digest_id: digest.id,
    canonical_url: article.canonical_url,
    article_hash: article.article_hash,
    title: article.title,
    published_at: article.published_at,
    delivery_kind: job.reason === "one_time" ? "one_time" : "recurring",
    delivered_at: new Date().toISOString(),
  }));
  if (deliveries.length) {
    const result = await admin.from("article_deliveries").upsert(deliveries, { onConflict: "digest_id,article_hash", ignoreDuplicates: true });
    if (result.error) throw result.error;
  }
}

async function buildOneTime(job: any, settings: any, now: Date, displayDate: string, filenameDate: string) {
  const name = String(job.packet_name || "").trim();
  const urls = Array.isArray(job.article_urls) ? job.article_urls.map(String) : [];
  if (!name || !urls.length || urls.length > 20) throw new Error("This one-time edition request is invalid.");
  const items: EpubArticle[] = new Array(urls.length);const errors: { index: number; error: unknown }[] = [];let cursor = 0;
  async function articleWorker() {
    while (true) {
      const index = cursor++;if (index >= urls.length) return;
      try { items[index] = await extractArticle({ url: urls[index], includeImages: true }); }
      catch (error) { errors.push({ index, error }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, () => articleWorker()));
  if (errors.length) {
    errors.sort((a, b) => a.index - b.index);const first = errors[0];
    throw new Error(`Article ${first.index + 1} could not be prepared: ${first.error instanceof Error ? first.error.message : String(first.error)}`);
  }
  const bytes = await makeEpub({ name, displayDate, date: now, timezone: settings.timezone || "UTC", label: "One-time edition" }, items);
  return {
    attachments: [{ filename: `${slug(name)}-${filenameDate}.epub`, content: base64(bytes), content_type: "application/epub+zip" }],
    groups: [{ section: { id: null, name }, items }],
    feedCount: 0,
    subject: `${name} — ${displayDate}`,
  };
}

async function buildRecurring(job: any, settings: any, now: Date, displayDate: string, filenameDate: string) {
  const [sectionResult, feedResult] = await Promise.all([
    admin.from("sections").select("*").eq("user_id", job.user_id).eq("enabled", true).is("archived_at", null).order("position"),
    admin.from("feeds").select("*").eq("user_id", job.user_id).eq("enabled", true).is("archived_at", null),
  ]);
  if (sectionResult.error) throw sectionResult.error;
  if (feedResult.error) throw feedResult.error;
  const sections = sectionResult.data || [];
  const feeds = feedResult.data || [];
  const cutoff = new Date(now.getTime() - job.lookback_hours * 3_600_000);
  let all: EpubArticle[] = [];
  const extractionDeadline = performance.now() + 180_000;
  for (const feed of feeds.slice(0, 100)) {
    if (all.length >= 240 || performance.now() > extractionDeadline) {
      logEvent("digest.extraction_capped", { job_id: job.id, user_id: job.user_id, articles: all.length, feeds_processed: feeds.indexOf(feed), feeds_total: feeds.length }, "warn");
      break;
    }
    all.push(...await readFeed(feed, cutoff, job.id, extractionDeadline));
  }
  const hashes = [...new Set(all.map((article) => article.article_hash))];
  const delivered = new Set<string>();
  for (let index = 0; index < hashes.length; index += 200) {
    const { data } = await admin.from("article_deliveries").select("article_hash").eq("user_id", job.user_id).eq("delivery_kind", "recurring").in("article_hash", hashes.slice(index, index + 200));
    for (const row of data || []) delivered.add(row.article_hash);
  }
  all = all.filter((article) => !delivered.has(article.article_hash));
  all.sort((a, b) => (b.published_at ? +new Date(b.published_at) : 0) - (a.published_at ? +new Date(a.published_at) : 0));
  const attachments: any[] = [];
  const groups: { section: any; items: EpubArticle[] }[] = [];
  for (const section of sections) {
    let items = all.filter((article) => article.section_id === section.id);
    items = items.slice(0, job.reason === "test" ? 3 : 80);
    if (!items.length) continue;
    const bytes = await makeEpub({ name: section.name, displayDate, date: now, timezone: settings.timezone || "UTC" }, items);
    attachments.push({ filename: `${slug(section.name)}-${filenameDate}.epub`, content: base64(bytes), content_type: "application/epub+zip" });
    groups.push({ section, items });
  }
  return { attachments, groups, feedCount: feeds.length, subject: `Morning Reader — ${displayDate}` };
}

async function processJob(queuedJob: any) {
  const started = performance.now();
  const claim = await admin.from("digest_jobs").update({ status: "running", started_at: new Date().toISOString(), attempts: queuedJob.attempts + 1, error: null }).eq("id", queuedJob.id).eq("status", "queued").select("*").maybeSingle();
  if (!claim.data) return null;
  const job = claim.data;
  try {
    logEvent("digest.started", { job_id: job.id, user_id: job.user_id, reason: job.reason, attempt: job.attempts });
    const settingsResult = await admin.from("user_settings").select("*").eq("user_id", job.user_id).single();
    if (settingsResult.error) throw settingsResult.error;
    const settings = settingsResult.data;
    if (!settings?.kindle_email) throw new Error("No Send-to-Kindle email is configured.");
    const now = new Date();
    const timezone = settings.timezone || "UTC";
    const displayDate = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: timezone }).format(now);
    const filenameDate = localDateKey(timezone, now);
    const build = job.reason === "one_time"
      ? await buildOneTime(job, settings, now, displayDate, filenameDate)
      : await buildRecurring(job, settings, now, displayDate, filenameDate);
    if (!build.attachments.length) {
      await admin.from("digest_jobs").update({ status: "empty", finished_at: new Date().toISOString(), result: { articles: 0, sections: 0, feeds: build.feedCount } }).eq("id", job.id);
      logEvent("digest.empty", { job_id: job.id, user_id: job.user_id, reason: job.reason, feeds: build.feedCount, duration_ms: Math.round(performance.now() - started) });
      return { job: job.id, status: "empty" };
    }
    const sent = await sendResend(settings.kindle_email, build.attachments, job.id, build.subject);
    let total = 0;
    for (const group of build.groups) {
      await digestForGroup(job, group, sent.id);
      total += group.items.length;
    }
    const warningCount = build.groups.flatMap((group) => group.items).reduce((sum, article) => sum + article.warnings.length, 0);
    await admin.from("digest_jobs").update({ status: "sent", finished_at: new Date().toISOString(), result: { articles: total, sections: build.groups.length, feeds: build.feedCount, provider_email_id: sent.id, packet_name: job.packet_name || null, warnings: warningCount } }).eq("id", job.id);
    logEvent("digest.sent", { job_id: job.id, user_id: job.user_id, reason: job.reason, articles: total, sections: build.groups.length, feeds: build.feedCount, warnings: warningCount, duration_ms: Math.round(performance.now() - started) });
    return { job: job.id, status: "sent", articles: total, sections: build.groups.length };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 800);
    const attempts = job.attempts;
    const nextStatus = attempts < 3 ? "queued" : "failed";
    const patch: any = { status: nextStatus, error: message };
    if (nextStatus === "queued") patch.run_after = new Date(Date.now() + attempts * 10 * 60_000).toISOString();
    else patch.finished_at = new Date().toISOString();
    await admin.from("digest_jobs").update(patch).eq("id", job.id);
    logEvent(nextStatus === "failed" ? "digest.failed" : "digest.retry_scheduled", { job_id: job.id, user_id: job.user_id, reason: job.reason, error: message, attempt: attempts, duration_ms: Math.round(performance.now() - started) }, nextStatus === "failed" ? "error" : "warn");
    return { job: job.id, status: nextStatus, error: message };
  }
}

export async function handleWorkerRequest(request: Request) {
  const invocationId = crypto.randomUUID();
  const started = performance.now();
  if (request.method !== "POST" && request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    logEvent("worker.invoked", { invocation_id: invocationId, method: request.method });
    const workerSecret = request.headers.get("x-worker-secret") || "";
    if (!workerSecret) return json({ error: "Unauthorized" }, 401);
    const { data: authorized, error: authError } = await admin.rpc("verify_worker_secret", { p_secret: workerSecret });
    if (authError || !authorized) return json({ error: "Unauthorized" }, 401);
    const force = request.headers.get("x-worker-force") === "1";
    const { data: claimed, error: claimError } = await admin.rpc("claim_worker_run", { p_name: "digest-worker", p_min_interval_seconds: force ? 0 : 240 });
    if (claimError) throw claimError;
    if (!claimed) {
      logEvent("worker.skipped", { invocation_id: invocationId, reason: "recently-run", duration_ms: Math.round(performance.now() - started) });
      return json({ ok: true, skipped: "recently-run" });
    }
    await admin.from("digest_jobs").update({ status: "queued", run_after: new Date().toISOString(), error: "Recovered after stale worker claim." }).eq("status", "running").lt("started_at", new Date(Date.now() - 30 * 60_000).toISOString()).lt("attempts", 3);
    await queueScheduled();
    const { data: jobs, error } = await admin.from("digest_jobs").select("*").eq("status", "queued").lte("run_after", new Date().toISOString()).order("created_at").limit(3);
    if (error) throw error;
    const results = [];
    for (const job of jobs || []) results.push(await processJob(job));
    logEvent("worker.completed", { invocation_id: invocationId, jobs: (jobs || []).length, duration_ms: Math.round(performance.now() - started) });
    return json({ ok: true, processed: results });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 800);
    logEvent("worker.failed", { invocation_id: invocationId, error: message, duration_ms: Math.round(performance.now() - started) }, "error");
    return json({ ok: false, error: message }, 500);
  }
}
