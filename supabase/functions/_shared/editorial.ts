import { plainText } from "./article.ts";
import type { EpubArticle } from "./epub.ts";

export type EditorialSection = { id: string; name: string };

export type EditorialDecision = {
  id: string;
  include: boolean;
  section_name: string;
  topic_name: string;
  topic_intro: string;
  article_note: string;
  decision_reason: string;
};

export type EditorialPlan = { articles: EditorialDecision[] };

export type EditorialReport = {
  status: "edited" | "skipped" | "fallback";
  model: string;
  included: number;
  omitted: number;
  moved: number;
  topics: number;
  error?: string;
  usage?: Record<string, unknown>;
  decisions?: Array<{
    title: string;
    source: string;
    from: string;
    to: string | null;
    include: boolean;
    reason: string;
  }>;
};

export type EditorializedArticle = EpubArticle & {
  editorial_topic?: string | null;
  editorial_topic_intro?: string | null;
  editorial_note?: string | null;
  editorial_decision_reason?: string | null;
  editorial_position?: number | null;
};

const DEFAULT_MODEL = "gpt-6-luna";

function candidateId(index: number) {
  return `article-${index + 1}`;
}

function outputText(payload: any): string {
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
      if (part?.type === "refusal") throw new Error("OpenAI refused the editorial request.");
    }
  }
  throw new Error("OpenAI returned no structured editorial output.");
}

function schemaFor(sections: EditorialSection[]) {
  const names = sections.map((section) => section.name);
  return {
    type: "object",
    properties: {
      articles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            include: { type: "boolean" },
            section_name: { type: "string", enum: ["", ...names] },
            topic_name: { type: "string" },
            topic_intro: { type: "string" },
            article_note: { type: "string" },
            decision_reason: { type: "string" },
          },
          required: ["id", "include", "section_name", "topic_name", "topic_intro", "article_note", "decision_reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["articles"],
    additionalProperties: false,
  };
}

export function applyEditorialPlan(
  sections: EditorialSection[],
  articles: EpubArticle[],
  plan: EditorialPlan,
): { articles: EditorializedArticle[]; report: Omit<EditorialReport, "status" | "model" | "usage" | "error"> } {
  const sectionByName = new Map(sections.map((section) => [section.name, section]));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const expected = new Set(articles.map((_article, index) => candidateId(index)));
  const seen = new Set<string>();
  const output: EditorializedArticle[] = [];
  const decisions: NonNullable<EditorialReport["decisions"]> = [];
  let omitted = 0;
  let moved = 0;
  const topics = new Set<string>();

  if (!plan || !Array.isArray(plan.articles) || plan.articles.length !== articles.length) {
    throw new Error("Editorial plan did not return exactly one decision for every article.");
  }

  for (const decision of plan.articles) {
    if (!expected.has(decision.id) || seen.has(decision.id)) {
      throw new Error("Editorial plan contained an unknown or duplicate article id.");
    }
    seen.add(decision.id);
    const index = Number(decision.id.slice("article-".length)) - 1;
    const article = articles[index];
    if (!article) throw new Error("Editorial plan referenced an invalid article.");
    const fromSection = sectionById.get(String(article.section_id || ""))?.name || String(article.section_name || "");

    if (!decision.include) {
      omitted++;
      decisions.push({
        title: article.title,
        source: article.source,
        from: fromSection,
        to: null,
        include: false,
        reason: decision.decision_reason.trim(),
      });
      continue;
    }

    const target = sectionByName.get(decision.section_name);
    if (!target) throw new Error("Editorial plan assigned an article to an unknown section.");
    const topic = decision.topic_name.trim();
    const topicIntro = decision.topic_intro.trim();
    const note = decision.article_note.trim();
    if (!topic || !topicIntro || !note) throw new Error("Editorial plan omitted required reader-facing editorial copy.");
    if (article.section_id && article.section_id !== target.id) moved++;
    topics.add(`${target.id}:${topic}`);

    const edited: EditorializedArticle = {
      ...article,
      section_id: target.id,
      section_name: target.name,
      editorial_topic: topic,
      editorial_topic_intro: topicIntro,
      editorial_note: note,
      editorial_decision_reason: decision.decision_reason.trim(),
      editorial_position: output.length,
    };
    output.push(edited);
    decisions.push({
      title: article.title,
      source: article.source,
      from: fromSection,
      to: target.name,
      include: true,
      reason: decision.decision_reason.trim(),
    });
  }

  if (seen.size !== expected.size) throw new Error("Editorial plan omitted one or more article decisions.");
  return {
    articles: output,
    report: {
      included: output.length,
      omitted,
      moved,
      topics: topics.size,
      decisions,
    },
  };
}

export async function editorializeIssue(
  sections: EditorialSection[],
  articles: EpubArticle[],
  options: {
    apiKey?: string;
    model?: string;
    deadline?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ articles: EditorializedArticle[]; report: EditorialReport }> {
  const model = options.model || DEFAULT_MODEL;
  if (!articles.length || !sections.length) {
    return { articles, report: { status: "skipped", model, included: articles.length, omitted: 0, moved: 0, topics: 0 } };
  }

  const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) {
    return { articles, report: { status: "skipped", model, included: articles.length, omitted: 0, moved: 0, topics: 0, error: "OPENAI_API_KEY is not configured." } };
  }

  const deadline = options.deadline ?? Date.now() + 30_000;
  const remaining = deadline - Date.now();
  if (remaining < 8_000) {
    return { articles, report: { status: "skipped", model, included: articles.length, omitted: 0, moved: 0, topics: 0, error: "Not enough preparation time remained for editorial processing." } };
  }

  const candidates = articles.map((article, index) => ({
    id: candidateId(index),
    current_section: sections.find((section) => section.id === article.section_id)?.name || article.section_name || "",
    title: article.title,
    source: article.source,
    author: article.author || "",
    published_at: article.published_at || "",
    canonical_url: article.canonical_url || article.url,
    excerpt: article.excerpt || "",
    text: plainText(article.body).slice(0, 2800),
  }));

  const system = [
    "You are the editorial desk for Morning Reader, a personal daily newspaper.",
    "The supplied section names are editorial charters. A candidate's current section is only a discovery hint from its feed, not a guarantee that the article belongs there.",
    "For every candidate, decide whether it belongs in one of the supplied sections. You may keep it, move it to another supplied section, or omit it when it does not fit any section.",
    "Then organize included articles within each section into specific topical clusters. A topic should describe the concrete development, question, or idea connecting the articles, not a generic category.",
    "Singleton topics are valid. Never force unrelated articles together.",
    "Write a brief 1-2 sentence topic introduction explaining why the articles are grouped and what the group covers. Write one short sentence for each article explaining what that article specifically covers or contributes.",
    "Do not synthesize the sources into a replacement article. Do not rewrite article bodies. Do not add facts that are not supported by the supplied candidate text.",
    "Prefer omission to weak section fit. Reposts or links discovered through a person's feed must be judged by the linked article's actual subject and publisher metadata, not by the feed owner's identity.",
    "Return every input id exactly once. For omitted articles, set section_name, topic_name, topic_intro, and article_note to empty strings.",
    "Order included article decisions in the reading order you recommend within the existing section order.",
  ].join("\n");

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(5_000, Math.min(30_000, remaining - 4_000));
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 12_000,
        input: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify({ sections: sections.map((section) => section.name), candidates }) },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "morning_reader_editorial_plan",
            strict: true,
            schema: schemaFor(sections),
          },
        },
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`OpenAI editorial request failed (${response.status}): ${raw.slice(0, 300)}`);
    const payload = JSON.parse(raw);
    const plan = JSON.parse(outputText(payload)) as EditorialPlan;
    const applied = applyEditorialPlan(sections, articles, plan);
    return {
      articles: applied.articles,
      report: {
        status: "edited",
        model,
        ...applied.report,
        usage: payload.usage || undefined,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      articles,
      report: {
        status: "fallback",
        model,
        included: articles.length,
        omitted: 0,
        moved: 0,
        topics: 0,
        error: message.slice(0, 500),
      },
    };
  }
}
