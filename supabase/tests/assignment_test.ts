import {
  applyAssignmentPlan,
  assignIssue,
  type AssignmentClassifier,
  type AssignmentPlan,
} from "../functions/_shared/assignment.ts";
import type { EpubArticle } from "../functions/_shared/epub.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const sections = [
  { id: "ai", name: "AI" },
  { id: "systems", name: "Systems" },
];

function article(index: number, sectionId: string, title: string, source = "Example"): EpubArticle {
  return {
    title,
    url: `https://example.com/${index}`,
    canonical_url: `https://example.com/${index}`,
    source,
    author: null,
    published_at: "2026-09-23T12:00:00Z",
    excerpt: `${title} excerpt`,
    body: `<p>ORIGINAL-${index}: ${title}. This body must survive classification unchanged.</p>`,
    assets: [],
    warnings: [],
    article_hash: `hash-${index}`,
    feed_id: `feed-${index}`,
    section_id: sectionId,
  };
}

Deno.test("assignment desk omits and reroutes articles without changing source bodies", () => {
  const input = [
    article(1, "ai", "Agent reliability"),
    article(2, "ai", "VS Code SSH architecture"),
    article(3, "ai", "A wine atlas", "Outside Journal"),
  ];
  const bodies = new Map(input.map((item) => [item.article_hash, item.body]));
  const plan: AssignmentPlan = {
    articles: [
      { id: "article-1", label: "AI", confidence: 0.98, reason: "Direct AI fit." },
      { id: "article-2", label: "Systems", confidence: 0.94, reason: "Developer infrastructure and security." },
      { id: "article-3", label: "OMIT", confidence: 0.99, reason: "Unrelated lifestyle project." },
    ],
  };
  const result = applyAssignmentPlan(sections, input, plan, "test-provider");
  assert(result.articles.length === 2, "one article should be omitted");
  assert(result.report.omitted === 1, "omission count should be tracked");
  assert(result.report.moved === 1, "reroute count should be tracked");
  assert(result.articles[1].section_name === "Systems", "technical article should be rerouted");
  assert(!result.articles.some((item) => item.title === "A wine atlas"), "off-topic article must be excluded");
  for (const item of result.articles) assert(item.body === bodies.get(item.article_hash), "classification must not rewrite article bodies");
});

Deno.test("Luna implements the provider-neutral assignment contract with structured output", async () => {
  const input = [article(1, "ai", "Agent reliability")];
  let requestBody: any = null;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || "{}"));
    const plan: AssignmentPlan = {
      articles: [{ id: "article-1", label: "AI", confidence: 0.93, reason: "Direct AI fit." }],
    };
    return Response.json({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(plan) }] }],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    });
  }) as typeof fetch;

  const result = await assignIssue(sections, input, {
    apiKey: "test-key",
    fetchImpl,
    deadline: Date.now() + 30_000,
  });
  assert(requestBody?.model === "gpt-6-luna", "Luna should be the default assignment provider");
  assert(requestBody?.text?.format?.name === "morning_reader_assignment_plan", "assignment output should use its own strict schema");
  const labels = requestBody?.text?.format?.schema?.properties?.articles?.items?.properties?.label?.enum || [];
  assert(labels.includes("NO_STRONG_FIT"), "assignment contract should let worthwhile articles declare no natural section fit");
  assert(JSON.stringify(requestBody).includes("Apple charging-hardware guide"), "today's weak-fit failure should remain an explicit assignment regression example");
  assert(requestBody?.store === false, "assignment responses should not be stored");
  assert(result.report.status === "assigned", "valid classification should be applied");
  assert(result.report.provider === "luna", "provider identity should be explicit");
  assert(result.report.confidence_kind === "self_reported", "Luna confidence must be labeled as self-reported");
  assert(result.articles[0].assignment_confidence === 0.93, "confidence should travel with the assigned article");
});

Deno.test("assignment provider can be swapped without changing the pipeline contract", async () => {
  const classifier: AssignmentClassifier = {
    name: "fake-jev",
    async classify({ articles }) {
      return {
        provider: "fake-jev",
        model: "jev-test",
        confidence_kind: "provider_probability",
        plan: {
          articles: articles.map((_article, index) => ({
            id: `article-${index + 1}`,
            label: index === 0 ? "Systems" : "OMIT",
            confidence: 0.95,
            reason: "Fixture decision.",
          })),
        },
      };
    },
  };
  const result = await assignIssue(sections, [
    article(1, "ai", "Database internals"),
    article(2, "ai", "Travel story"),
  ], { classifier, deadline: Date.now() + 30_000 });

  assert(result.report.provider === "fake-jev", "worker-facing report should not care which classifier implementation was used");
  assert(result.report.confidence_kind === "provider_probability", "provider probability semantics should be preserved");
  assert(result.articles.length === 1 && result.articles[0].section_name === "Systems", "custom classifier decisions should apply through the same path");
});

Deno.test("assignment policy sends strong no-fit cases to Other and rejects low-confidence destructive decisions", () => {
  const policySections = [...sections, { id: "tpm", name: "TPM" }];
  const input = [
    article(1, "tpm", "Apple Charging Guide", "Rands in Repose"),
    article(2, "ai", "Design Engineering with Maggie Appleton", "Pragmatic Engineer"),
    article(3, "systems", "Borderline systems essay"),
  ];
  const plan: AssignmentPlan = {
    articles: [
      { id: "article-1", label: "NO_STRONG_FIT", confidence: 0.95, reason: "Useful consumer technology, but not a natural fit for the configured sections." },
      { id: "article-2", label: "TPM", confidence: 0.78, reason: "Professional practice overlaps with program management." },
      { id: "article-3", label: "OMIT", confidence: 0.70, reason: "Borderline relevance." },
    ],
  };
  const result = applyAssignmentPlan(policySections, input, plan, "luna");
  assert(result.articles.length === 3, "low-confidence omission must not silently delete an article");
  assert(result.articles[0].section_id === null && result.articles[0].section_name === "Other", "strong no-fit decisions should render under Other");
  assert(result.articles[1].section_id === "ai" && result.articles[1].section_name === "AI", "a 0.78 cross-section move should be conservatively retained");
  assert(result.articles[2].section_id === "systems", "low-confidence omission should preserve the original section");
  assert(result.report.other === 1, "Other placements should be counted");
  assert(result.report.omitted === 0, "the low-confidence omission should not count as applied");
  assert(result.report.moved === 1, "moving a strong no-fit case to Other should count as one applied move");
});

Deno.test("assignment provider failure falls back to feed placement instead of dropping the issue", async () => {
  const input = [article(1, "ai", "Agent reliability")];
  const classifier: AssignmentClassifier = {
    name: "broken-provider",
    async classify() { throw new Error("provider unavailable"); },
  };
  const result = await assignIssue(sections, input, { classifier, deadline: Date.now() + 30_000 });
  assert(result.report.status === "fallback", "provider failure should be explicit");
  assert(result.articles.length === input.length, "fallback must keep all articles");
  assert(result.articles[0].section_id === "ai", "fallback must preserve original feed placement");
});

Deno.test("invalid assignment plans cannot silently duplicate or lose articles", () => {
  const input = [article(1, "ai", "One"), article(2, "ai", "Two")];
  const invalid: AssignmentPlan = {
    articles: [
      { id: "article-1", label: "AI", confidence: 0.9, reason: "One" },
      { id: "article-1", label: "OMIT", confidence: 0.9, reason: "Duplicate" },
    ],
  };
  let threw = false;
  try { applyAssignmentPlan(sections, input, invalid, "test"); } catch { threw = true; }
  assert(threw, "duplicate or missing decisions must invalidate the whole assignment plan");
});
