import type { EpubArticle } from "./epub.ts";

export type IssueIntroductionReport = {
  status: "written" | "skipped" | "fallback";
  model: string;
  words: number;
  error?: string;
  usage?: Record<string, unknown>;
};

const DEFAULT_MODEL = "gpt-6-luna";

function outputText(payload: any): string {
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
      if (part?.type === "refusal") throw new Error("OpenAI refused the issue introduction request.");
    }
  }
  throw new Error("OpenAI returned no structured issue introduction.");
}

function compactIssue(groups: Array<{ section: { name?: string | null }; items: EpubArticle[] }>) {
  let remaining = 60;
  return groups.map((group) => {
    const stories = group.items.slice(0, remaining).map((article, index) => ({
      title: article.title,
      source: article.source,
      topic: article.editorial_topic || null,
      excerpt: index < 3 ? String(article.excerpt || "").slice(0, 320) : "",
      discovery_kind: article.discovery_kind || null,
      discovery_reason: article.discovery_reason ? String(article.discovery_reason).slice(0, 420) : null,
    }));
    remaining = Math.max(0, remaining - stories.length);
    return {
      section: String(group.section?.name || "Other"),
      stories,
    };
  }).filter((group) => group.stories.length);
}

function cleanParagraph(value: unknown) {
  const paragraph = String(value || "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = paragraph ? paragraph.split(/\s+/).length : 0;
  if (words < 55 || words > 180) {
    throw new Error(`Issue introduction was ${words} words; expected a compact single paragraph.`);
  }
  return { paragraph, words };
}

export async function writeIssueIntroduction(
  groups: Array<{ section: { name?: string | null }; items: EpubArticle[] }>,
  editorialBrief: string,
  options: {
    apiKey?: string;
    model?: string;
    deadline?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ paragraph: string | null; report: IssueIntroductionReport }> {
  const model = options.model || DEFAULT_MODEL;
  const issue = compactIssue(groups);
  if (!issue.length) {
    return { paragraph: null, report: { status: "skipped", model, words: 0 } };
  }

  const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) {
    return {
      paragraph: null,
      report: { status: "skipped", model, words: 0, error: "OPENAI_API_KEY is not configured." },
    };
  }

  const deadline = options.deadline ?? Date.now() + 20_000;
  const remaining = deadline - Date.now();
  if (remaining < 7_000) {
    return {
      paragraph: null,
      report: { status: "skipped", model, words: 0, error: "Not enough preparation time remained for the issue introduction." },
    };
  }

  const system = [
    "You are writing page one of a small, serious personal morning publication for one intelligent reader.",
    "Write exactly one paragraph, ideally 90–140 words. No heading, bullets, markdown, salutation, sign-off, or meta commentary.",
    "This is an editor's note, not a summary. Find the live wire in the issue: a tension, echo, reversal, recurring question, or surprising juxtaposition across two to four parts of the publication, and build the paragraph around it.",
    "If one subject dominates the issue, widen the aperture rather than reciting variations on that subject.",
    "Treat every section as part of one publication, including externally discovered pieces. Do not call out internal labels such as Related Discovery or Open Discovery.",
    "You may allude to article ideas, writers, institutions, or section themes, but avoid a laundry list of titles.",
    "Never begin with phrases like 'In today's issue', 'This morning', 'Today's Morning Reader', or 'This issue includes'.",
    "Never mention AI, Luna, RSS, feeds, algorithms, personalization, selection, curation mechanics, or that you organized the issue.",
    "Do not invent facts, motives, or causal connections beyond the supplied titles, excerpts, and discovery reasons.",
    "Aim for the confidence of a magazine editor: concrete, curious, slightly dry, and willing to notice an odd connection without overselling it.",
    "Prefer varied sentence rhythm and one memorable turn of phrase over adjectives. Avoid hype, generic praise, and clickbait.",
    "End with a thought, question, or turn that opens the door into the reading rather than telling the reader what to do.",
  ].join("\n");

  const fetchImpl = options.fetchImpl || fetch;
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(Math.max(5_000, Math.min(16_000, remaining - 2_000))),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: "medium" },
        max_output_tokens: 1_500,
        input: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              editorial_brief: String(editorialBrief || "").trim().slice(0, 3000),
              issue,
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "morning_reader_issue_introduction",
            strict: true,
            schema: {
              type: "object",
              properties: {
                paragraph: { type: "string", minLength: 180, maxLength: 1600 },
              },
              required: ["paragraph"],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    const raw = await response.text();
    if (!response.ok) throw new Error(`OpenAI issue introduction request failed (${response.status}): ${raw.slice(0, 300)}`);
    const payload = JSON.parse(raw);
    const parsed = JSON.parse(outputText(payload));
    const cleaned = cleanParagraph(parsed?.paragraph);
    return {
      paragraph: cleaned.paragraph,
      report: {
        status: "written",
        model,
        words: cleaned.words,
        usage: payload.usage || undefined,
      },
    };
  } catch (error) {
    return {
      paragraph: null,
      report: {
        status: "fallback",
        model,
        words: 0,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      },
    };
  }
}
