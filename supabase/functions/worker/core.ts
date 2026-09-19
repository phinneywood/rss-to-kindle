import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { XMLParser } from "npm:fast-xml-parser@5.11.1";
import { extractArticle, extractionBudget, type ExtractionBudget, fetchPublicText, sha256, textValue } from "../_shared/article.ts";
import { dispatchPrepared, DeliveryNeedsReview, checkAttachmentBudget } from "../_shared/delivery.ts";
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

async function readFeed(feed: any, cutoff: Date, jobId: string, budget: ExtractionBudget) {
  const issues: string[] = [];
  const started = performance.now();
  try {
    const { text } = await fetchPublicText(feed.url, "application/rss+xml, application/atom+xml, application/xml, text/xml, */*", 1_500_000, budget.deadline);
    const parsed: any = parser.parse(text);
    let entries: any[] = [];
    if (parsed?.rss?.channel?.item) entries = array(parsed.rss.channel.item);
    else if (parsed?.feed?.entry) entries = array(parsed.feed.entry);
    else if (parsed?.["rdf:RDF"]?.item) entries = array(parsed["rdf:RDF"].item);
    if (!parsed?.rss?.channel && !parsed?.feed && !parsed?.["rdf:RDF"]) throw new Error("This source did not return a valid RSS or Atom feed.");
    const candidates = entries.slice(0, 20);
    const hashes = await Promise.all(candidates.map(e => sha256(stripTracking(entryHref(e.link) || textValue(e.guid || e.id)))));
    const prior = hashes.length ? await admin.from("article_deliveries").select("article_hash").eq("user_id", feed.user_id).eq("delivery_kind", "recurring").in("article_hash", hashes) : { data: [], error: null };
    if (prior.error) throw prior.error;
    const delivered = new Set((prior.data || []).map((row: any) => row.article_hash));
    const articles: EpubArticle[] = [];
    for (const [index, entry] of candidates.entries()) {
      if (articles.length >= 12) break;
      if (Date.now() >= budget.deadline) { issues.push(`${feed.name}: preparation time limit reached; some articles were omitted.`); break; }
      if (delivered.has(hashes[index])) continue;
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
          includeImages: true, budget,
        });
        articles.push({ ...article, feed_id: feed.id, section_id: feed.section_id });
        if (article.warnings.length) logEvent("article.extracted_with_warnings", { job_id: jobId, feed_id: feed.id, url, warnings: article.warnings });
      } catch (error) {
        issues.push(`${feed.name}: ${title} could not be extracted.`);
        logEvent("article.extract_failed", { job_id: jobId, feed_id: feed.id, url, error: error instanceof Error ? error.message : String((error as any)?.message || error) }, "warn");
      }
    }
    const now = new Date().toISOString();
    await admin.from("feeds").update({ last_fetch_at: now, ...(issues.length ? {} : { last_success_at: now }), last_error: issues.length ? issues.join(" ").slice(0, 500) : null, consecutive_failures: issues.length ? Number(feed.consecutive_failures || 0) + 1 : 0 }).eq("id", feed.id);
    return { articles, issues };
  } catch (error) {
    const message = error instanceof Error ? error.message : String((error as any)?.message || error);
    const failures = Number(feed.consecutive_failures || 0) + 1;
    await admin.from("feeds").update({ last_fetch_at: new Date().toISOString(), last_error: message.slice(0, 500), consecutive_failures: failures }).eq("id", feed.id);
    let host = "";
    try { host = new URL(feed.url).hostname; } catch { /* invalid feed URL */ }
    logEvent("feed.fetch_failed", { job_id: jobId, user_id: feed.user_id, feed_id: feed.id, host, error: message.slice(0, 300), consecutive_failures: failures, duration_ms: Math.round(performance.now() - started) }, failures >= 3 ? "error" : "warn");
    return { articles: [], issues: [`${feed.name}: ${message}`] };
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

async function sendResend(email: any, jobId: string) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is missing.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `morning-reader-${jobId}` },
    body: JSON.stringify(email),
  });
  const responseBody = await response.text();
  if (!response.ok) throw new Error(`Email provider error (${response.status}): ${responseBody.slice(0, 400)}`);
  return JSON.parse(responseBody);
}

async function queueScheduled() {
  const { error } = await admin.rpc("queue_due_daily_issues");
  if (error) throw error;
}

async function digestForGroup(job: any, group: { section: any; items: EpubArticle[] }, providerEmailId: string) {
  const row = {
    user_id: job.user_id,
    section_id: group.section.id || null,
    edition_name: group.section.name,
    job_id: job.id,
    scheduled_for: job.reason === "scheduled" ? job.scheduled_for || job.run_after : null,
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

async function buildOneTime(job: any, settings: any, now: Date, displayDate: string, filenameDate: string, deadline: number) {
  const name = String(job.packet_name || "").trim();
  const urls = Array.isArray(job.article_urls) ? job.article_urls.map(String) : [];
  if (!name || !urls.length || urls.length > 20) throw new Error("This one-time edition request is invalid.");
  const budget = extractionBudget(deadline);
  const items: EpubArticle[] = new Array(urls.length);const errors: { index: number; error: unknown }[] = [];let cursor = 0;
  async function articleWorker() {
    while (true) {
      const index = cursor++;if (index >= urls.length) return;
      try { items[index] = await extractArticle({ url: urls[index], includeImages: true, budget }); }
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
    feedCount: 0, issues: [] as string[],
    subject: `${name} — ${displayDate}`,
  };
}

async function buildRecurring(job: any, settings: any, now: Date, displayDate: string, filenameDate: string, deadline: number) {
  const [sectionResult, feedResult, pendingResult] = await Promise.all([
    admin.from("sections").select("*").eq("user_id", job.user_id).eq("enabled", true).is("archived_at", null).order("position"),
    admin.from("feeds").select("*").eq("user_id", job.user_id).eq("enabled", true).is("archived_at", null),
    admin.from("pending_issue_articles").select("*").eq("user_id", job.user_id).order("created_at").limit(20),
  ]);
  if (sectionResult.error) throw sectionResult.error;
  if (feedResult.error) throw feedResult.error;
  if (pendingResult.error) throw pendingResult.error;
  const timezone = settings.timezone || "UTC";
  const weekdayName = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now);
  const weekdayNumber = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(weekdayName);
  const sections = (sectionResult.data || []).filter((section: any) =>
    job.reason !== "scheduled" || !Array.isArray(section.delivery_days) || section.delivery_days.includes(weekdayNumber));
  const feeds = (feedResult.data || []).filter((feed: any) => sections.some((section: any) => section.id === feed.section_id));
  const cutoff = new Date(now.getTime() - job.lookback_hours * 3_600_000);
  let all: EpubArticle[] = [];
  const budget = extractionBudget(deadline);
  const issues: string[] = [];
  for (const feed of feeds.slice(0, 100)) {
    if (all.length >= 60 || Date.now() >= budget.deadline) {
      issues.push("Preparation limit reached; some sources were not included.");
      logEvent("digest.extraction_capped", { job_id: job.id, user_id: job.user_id, articles: all.length, feeds_processed: feeds.indexOf(feed), feeds_total: feeds.length }, "warn");
      break;
    }
    const result = await readFeed(feed, cutoff, job.id, budget);
    all.push(...result.articles);
    issues.push(...result.issues);
  }
  const hashes = [...new Set(all.map((article) => article.article_hash))];
  const delivered = new Set<string>();
  for (let index = 0; index < hashes.length; index += 200) {
    const { data, error } = await admin.from("article_deliveries").select("article_hash").eq("user_id", job.user_id).eq("delivery_kind", "recurring").in("article_hash", hashes.slice(index, index + 200));
    if (error) throw error;
    for (const row of data || []) delivered.add(row.article_hash);
  }
  const seen = new Set<string>();
  all = all.filter((article) => { const key = `${article.section_id}:${article.article_hash}`; if (delivered.has(article.article_hash) || seen.has(key)) return false; seen.add(key); return true; });
  all.sort((a, b) => (b.published_at ? +new Date(b.published_at) : 0) - (a.published_at ? +new Date(a.published_at) : 0));
  const pendingItems: EpubArticle[] = [];
  for (const pending of pendingResult.data || []) {
    if (Date.now() >= budget.deadline) { issues.push("Preparation limit reached; some saved articles were deferred."); break; }
    try {
      const article = await extractArticle({ url: pending.url, includeImages: true, budget });
      pendingItems.push({ ...article, section_name: pending.section_name || "Saved articles", pending_id: pending.id });
    } catch (error) {
      issues.push(`Saved article could not be prepared: ${pending.url}`);
      logEvent("pending_article.extract_failed", { job_id: job.id, pending_id: pending.id, error: error instanceof Error ? error.message : String(error) }, "warn");
    }
  }
  const attachments: any[] = [];
  const groups: { section: any; items: EpubArticle[] }[] = [];
  const issueItems: EpubArticle[] = [];
  for (const section of sections) {
    let items = all.filter((article) => article.section_id === section.id);
    items = items.slice(0, job.reason === "test" ? 3 : 80).map((article) => ({ ...article, section_name: section.name }));
    if (!items.length) continue;
    groups.push({ section, items });
    issueItems.push(...items);
  }
  issueItems.push(...pendingItems);
  if (pendingItems.length) groups.push({ section: { id: null, name: "Saved articles" }, items: pendingItems });
  if (issueItems.length) {
    const bytes = await makeEpub({ name: "Morning Reader", displayDate, date: now, timezone: settings.timezone || "UTC", label: "Daily issue" }, issueItems);
    attachments.push({ filename: `morning-reader-${filenameDate}.epub`, content: base64(bytes), content_type: "application/epub+zip" });
    checkAttachmentBudget(attachments);
  }
  return { attachments, groups, issues, feedCount: feeds.length, subject: `Morning Reader — ${displayDate}` };
}

export async function processJob(queuedJob: any, deadline = Date.now() + 90_000) {
  const started = performance.now();
  const claim = await admin.from("digest_jobs").update({ status: "running", started_at: new Date().toISOString(), attempts: queuedJob.attempts + 1, error: null }).eq("id", queuedJob.id).eq("status", "queued").select("*").maybeSingle();
  if (!claim.data) return null;
  const job = claim.data;
  try {
    logEvent("digest.started", { job_id: job.id, user_id: job.user_id, reason: job.reason, attempt: job.attempts });
    const { build, providerId } = await dispatchPrepared({
      load: async () => { const r = await admin.from("delivery_outbox").select("*").eq("job_id", job.id).maybeSingle(); if (r.error) throw r.error; return r.data; },
      prepare: async () => {
        const settingsResult = await admin.from("user_settings").select("*").eq("user_id", job.user_id).single();
        if (settingsResult.error) throw settingsResult.error;
        const settings = settingsResult.data;
        if (job.reason === "scheduled" && (settings.paused || !settings.onboarding_complete || !settings.kindle_email)) {
          return { email: { from: "Morning Reader <reader@antonioskilton.com>", to: [], subject: "", text: "", attachments: [] },
            groups: [], feedCount: 0, issues: [], skipReason: "Skipped because daily delivery settings changed." };
        }
        if (!settings?.kindle_email) throw new Error("No Send-to-Kindle email is configured.");
        const now = new Date(job.created_at);
        const timezone = settings.timezone || "UTC";
        const displayDate = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: timezone }).format(now);
        const filenameDate = localDateKey(timezone, now);
        const prepared = job.reason === "one_time"
          ? await buildOneTime(job, settings, now, displayDate, filenameDate, deadline)
          : await buildRecurring(job, settings, now, displayDate, filenameDate, deadline);
        if (!prepared.attachments.length && prepared.issues.length) throw new Error("No edition could be prepared. " + prepared.issues.join(" ").slice(0, 600));
        checkAttachmentBudget(prepared.attachments);
        return {
          email: { from: "Morning Reader <reader@antonioskilton.com>", to: [settings.kindle_email], subject: prepared.subject, text: "Your Morning Reader edition is attached.", attachments: prepared.attachments },
          groups: prepared.groups.map(group => ({ section: group.section, items: group.items.map(({ body: _body, assets: _assets, ...article }) => article) })),
          feedCount: prepared.feedCount, issues: prepared.issues,
        };
      },
      freeze: async payload => { const r = await admin.from("delivery_outbox").insert({ job_id: job.id, payload }).select("*").single(); if (r.error) throw r.error; return r.data; },
      markAttempt: async at => { const r = await admin.from("delivery_outbox").update({ first_send_at: at }).eq("job_id", job.id); if (r.error) throw r.error; },
      send: email => sendResend(email, job.id),
      record: async id => { const r = await admin.from("delivery_outbox").update({ provider_email_id: id }).eq("job_id", job.id); if (r.error) throw r.error; },
    });
    if (!providerId) {
      const r = await admin.from("digest_jobs").update({ status: "empty", finished_at: new Date().toISOString(), result: { articles: 0, sections: 0, feeds: build.feedCount, note: build.skipReason || null } }).eq("id", job.id);
      if (r.error) throw r.error;
      return { job: job.id, status: "empty" };
    }
    let total = 0;
    const pendingIds: string[] = [];
    for (const group of build.groups) {
      await digestForGroup(job, group, providerId);
      total += group.items.length;
      pendingIds.push(...group.items.map((item: any) => item.pending_id).filter(Boolean));
    }
    const frozenPending = (build as any).pendingItems || [];
    pendingIds.push(...frozenPending.map((item: any) => item.pending_id).filter(Boolean));
    if (pendingIds.length) {
      const deletion = await admin.from("pending_issue_articles").delete().eq("user_id", job.user_id).in("id", [...new Set(pendingIds)]);
      if (deletion.error) throw deletion.error;
    }
    const warningMessages = [...new Set<string>(build.groups.flatMap(group => group.items.flatMap((article: any) => article.warnings || [])))];
    const status = build.issues.length || warningMessages.length ? "partial" : "sent";
    const finished = await admin.from("digest_jobs").update({ status, finished_at: new Date().toISOString(), result: { articles: total, sections: build.groups.length, feeds: build.feedCount, provider_email_id: providerId, packet_name: job.packet_name || null, warnings: warningMessages.length, issues: [...build.issues, ...warningMessages].slice(0, 30) } }).eq("id", job.id);
    if (finished.error) throw finished.error;
    logEvent("digest.submitted", { job_id: job.id, user_id: job.user_id, status, articles: total, duration_ms: Math.round(performance.now() - started) });
    return { job: job.id, status, articles: total, sections: build.groups.length };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String((error as any)?.message || error)).slice(0, 800);
    const attempts = job.attempts;
    const nextStatus = attempts < 3 && !(error instanceof DeliveryNeedsReview) ? "queued" : "failed";
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
    await admin.from("digest_jobs").update({ status: "failed", finished_at: new Date().toISOString(), error: "Final worker attempt was interrupted. Check your Kindle and delivery history before sending again." }).eq("status", "running").lt("started_at", new Date(Date.now() - 30 * 60_000).toISOString()).gte("attempts", 3);
    await queueScheduled();
    const { data: jobs, error } = await admin.from("digest_jobs").select("*").eq("status", "queued").lte("run_after", new Date().toISOString()).order("created_at").limit(3);
    if (error) throw error;
    const results = [];
    const deadline = Date.now() + 90_000;
    for (const job of jobs || []) {
      if (Date.now() > deadline - 20_000) break;
      results.push(await processJob(job, deadline));
    }
    logEvent("worker.completed", { invocation_id: invocationId, jobs: (jobs || []).length, duration_ms: Math.round(performance.now() - started) });
    return json({ ok: true, processed: results });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String((error as any)?.message || error)).slice(0, 800);
    logEvent("worker.failed", { invocation_id: invocationId, error: message, duration_ms: Math.round(performance.now() - started) }, "error");
    return json({ ok: false, error: message }, 500);
  }
}
