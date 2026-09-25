import { discoverBeyondRss } from "../functions/_shared/discovery.ts";
import type { EpubArticle } from "../functions/_shared/epub.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function article(index: number, section: string, title: string): EpubArticle {
  return {
    title,
    url: `https://feeds.example.com/${index}`,
    canonical_url: `https://publisher.example.com/${index}`,
    source: "Subscribed source",
    author: null,
    published_at: "2026-09-25T10:00:00Z",
    excerpt: `${title} excerpt`,
    body: `<p>${title}</p>`,
    assets: [],
    warnings: [],
    article_hash: `hash-${index}`,
    feed_id: `feed-${index}`,
    section_id: null,
    section_name: section,
    editorial_topic: null,
  };
}

Deno.test("discovery uses distinct web-search lanes and strict bounded outputs", async () => {
  const input = [
    article(1, "AI Infrastructure", "Reliable agent runtimes"),
    article(2, "AI Infrastructure", "Observing agent failures"),
    article(3, "Other", "A design essay"),
  ];
  const requests: any[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    requests.push(body);
    const name = body?.text?.format?.name;
    const response = name === "morning_reader_related_discovery"
      ? { articles: [{ url: "https://outside.example.com/primary", title: "Primary evidence", reason: "Adds primary evidence to today's agent-runtime coverage." }] }
      : { articles: [{ url: "https://outside.example.com/history", title: "Unexpected history essay", reason: "Fits the broad history interest while staying outside today's AI and design themes." }] };
    return Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(response) }] }],
      usage: { input_tokens: 100, output_tokens: 25 },
    });
  }) as typeof fetch;

  const result = await discoverBeyondRss(input, "Software, design, history, cities, and excellent long-form essays.", {
    apiKey: "test-key",
    fetchImpl,
    deadline: Date.now() + 40_000,
  });

  assert(requests.length === 2, "both discovery lanes should run when a brief is present");
  assert(requests.every((body) => body.tools?.[0]?.type === "web_search"), "both discovery lanes should use web search");
  assert(requests.every((body) => body.text?.format?.schema?.properties?.articles?.maxItems === 2), "discovery should be structurally capped at two candidates per lane");
  const related = requests.find((body) => body.text?.format?.name === "morning_reader_related_discovery");
  const open = requests.find((body) => body.text?.format?.name === "morning_reader_open_discovery");
  assert(JSON.stringify(related).includes("directly related"), "Related Discovery should require connection to today's themes");
  assert(JSON.stringify(open).includes("meaningfully OUTSIDE"), "Open Discovery should require topical distance");
  assert(JSON.stringify(open).includes("Software, design, history"), "Open Discovery should receive the explicit editorial brief");
  assert(result.related.length === 1 && result.open.length === 1);
  assert(result.report.related.status === "discovered" && result.report.open.status === "discovered");
});

Deno.test("Open Discovery is skipped without an explicit editorial brief", async () => {
  const input = [article(1, "Systems", "Database internals"), article(2, "Systems", "Storage engines")];
  const names: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    names.push(body?.text?.format?.name);
    return Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ articles: [] }) }] }],
    });
  }) as typeof fetch;

  const result = await discoverBeyondRss(input, "", {
    apiKey: "test-key",
    fetchImpl,
    deadline: Date.now() + 40_000,
  });
  assert(names.length === 1 && names[0] === "morning_reader_related_discovery", "blank brief should suppress only Open Discovery");
  assert(result.report.open.status === "skipped");
});

Deno.test("discovery failures are non-blocking and duplicate core URLs are rejected", async () => {
  const input = [article(1, "Systems", "Database internals"), article(2, "Systems", "Storage engines")];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const name = body?.text?.format?.name;
    if (name === "morning_reader_open_discovery") return new Response("search unavailable", { status: 503 });
    return Response.json({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            articles: [
              { url: "https://publisher.example.com/1", title: "Duplicate", reason: "Already present." },
              { url: "https://outside.example.com/new", title: "New context", reason: "Adds context." },
            ],
          }),
        }],
      }],
    });
  }) as typeof fetch;

  const result = await discoverBeyondRss(input, "Systems and history.", {
    apiKey: "test-key",
    fetchImpl,
    deadline: Date.now() + 40_000,
  });
  assert(result.related.length === 1 && result.related[0].url.includes("outside.example.com"), "core duplicates must be rejected");
  assert(result.open.length === 0 && result.report.open.status === "fallback", "provider failure should produce an empty non-blocking lane");
});
