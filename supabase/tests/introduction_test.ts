import { writeIssueIntroduction } from "../functions/_shared/introduction.ts";
import type { EpubArticle } from "../functions/_shared/epub.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function article(index: number, section: string, title: string, extra: Partial<EpubArticle> = {}): EpubArticle {
  return {
    title,
    url: `https://example.com/${index}`,
    canonical_url: `https://example.com/${index}`,
    source: "Example",
    author: null,
    published_at: "2026-09-25T12:00:00Z",
    excerpt: `${title} excerpt with enough detail for an editor to understand the angle.`,
    body: `<p>${title}</p>`,
    assets: [],
    warnings: [],
    article_hash: `hash-${index}`,
    feed_id: `feed-${index}`,
    section_id: null,
    section_name: section,
    editorial_topic: null,
    ...extra,
  };
}

const fixtureParagraph = "Software agents keep acquiring the trappings of ordinary coworkers—sandboxes, oversight routines, security boundaries—while the quieter pieces ask a similar question of older institutions: what makes a system trustworthy once its edges start moving? A developer tool becomes an organizational problem; a historical detour makes improvisation look less like failure than design by accumulation. The interesting part is not whether these systems become autonomous, but how quickly yesterday’s safeguards turn into tomorrow’s assumptions.";

Deno.test("Luna introduction prompt asks for an editorial note rather than a summary", async () => {
  const groups = [
    { section: { name: "AI & Software Engineering" }, items: [article(1, "AI & Software Engineering", "Agents at work"), article(2, "AI & Software Engineering", "Containing tool use")] },
    { section: { name: "Open Discovery" }, items: [article(3, "Open Discovery", "A strange institutional history", { discovery_kind: "open", discovery_reason: "A deliberately distant history essay." })] },
  ];
  let request: any = null;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body || "{}"));
    return Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ paragraph: fixtureParagraph }) }] }],
      usage: { input_tokens: 500, output_tokens: 120 },
    });
  }) as typeof fetch;

  const result = await writeIssueIntroduction(groups, "Software, cities, history, and thoughtful long-form reading.", {
    apiKey: "test-key",
    additionalInstructions: "Keep the note dry and avoid rhetorical questions.",
    fetchImpl,
    deadline: Date.now() + 20_000,
  });

  assert(request?.model === "gpt-6-luna", "introduction must be written by Luna");
  assert(request?.text?.format?.name === "morning_reader_issue_introduction");
  const prompt = String(request?.input?.[0]?.content || "");
  assert(prompt.includes("editor's note, not a summary"), "prompt should define the editorial form");
  assert(prompt.includes("tension, echo, reversal"), "prompt should ask Luna to find a connective idea");
  assert(prompt.includes("70–90 words"), "prompt should explicitly target a one-screen note");
  assert(prompt.includes("Never mention AI, Luna, RSS"), "prompt should hide production mechanics");
  assert(prompt.includes("End with a thought, question, or turn"), "prompt should shape the ending");
  assert(JSON.stringify(request).includes("Open Discovery"), "Luna should see the complete final issue, including discovery");
  assert(JSON.stringify(request).includes("Keep the note dry and avoid rhetorical questions."), "the editor note should receive additional user instructions");
  assert(prompt.includes("subordinate to these form, factuality"), "fixed introduction rules must take precedence over user guidance");
  assert(result.paragraph === fixtureParagraph);
  assert(result.report.status === "written" && result.report.model === "gpt-6-luna");
  assert(result.report.words >= 60 && result.report.words <= 100, "accepted introduction should stay within the one-screen guardrail");
});

Deno.test("introduction failure is non-blocking", async () => {
  const groups = [{ section: { name: "Systems" }, items: [article(1, "Systems", "A systems story")] }];
  const result = await writeIssueIntroduction(groups, "", {
    apiKey: "test-key",
    fetchImpl: (async () => new Response("provider unavailable", { status: 503 })) as typeof fetch,
    deadline: Date.now() + 20_000,
  });
  assert(result.paragraph === null, "failed introduction should not block the issue");
  assert(result.report.status === "fallback");
});
