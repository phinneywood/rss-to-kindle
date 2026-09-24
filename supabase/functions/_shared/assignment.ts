import { plainText } from "./article.ts";
import type { EpubArticle } from "./epub.ts";

export type AssignmentSection = { id: string; name: string; brief?: string | null };

export type AssignmentDecision = {
  id: string;
  label: string;
  confidence: number | null;
  reason: string;
};

export type AssignmentPlan = { articles: AssignmentDecision[] };

export type AssignmentProviderResult = {
  plan: AssignmentPlan;
  provider: string;
  model?: string | null;
  usage?: Record<string, unknown>;
  confidence_kind?: "provider_probability" | "self_reported" | "none";
};

export type AssignmentClassifier = {
  name: string;
  classify(input: {
    sections: AssignmentSection[];
    articles: EpubArticle[];
    deadline: number;
  }): Promise<AssignmentProviderResult>;
};

export type AssignedArticle = EpubArticle & {
  assignment_provider?: string | null;
  assignment_confidence?: number | null;
  assignment_reason?: string | null;
};

export type AssignmentReport = {
  status: "assigned" | "skipped" | "fallback";
  provider: string;
  model?: string | null;
  confidence_kind?: "provider_probability" | "self_reported" | "none";
  included: number;
  omitted: number;
  moved: number;
  other: number;
  error?: string;
  usage?: Record<string, unknown>;
  decisions?: Array<{
    title: string;
    source: string;
    from: string;
    to: string | null;
    include: boolean;
    confidence: number | null;
    reason: string;
  }>;
};

const DEFAULT_MODEL = "gpt-6-luna";
export const MOVE_CONFIDENCE_MIN = 0.85;
export const OMIT_CONFIDENCE_MIN = 0.90;

function candidateId(index: number) {
  return `article-${index + 1}`;
}

function outputText(payload: any): string {
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
      if (part?.type === "refusal") throw new Error("The assignment provider refused the classification request.");
    }
  }
  throw new Error("The assignment provider returned no structured output.");
}

function assignmentSchema(sections: AssignmentSection[]) {
  return {
    type: "object",
    properties: {
      articles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string", enum: ["OMIT", "NO_STRONG_FIT", ...sections.map((section) => section.name)] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
          },
          required: ["id", "label", "confidence", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["articles"],
    additionalProperties: false,
  };
}

export function applyAssignmentPlan(
  sections: AssignmentSection[],
  articles: EpubArticle[],
  plan: AssignmentPlan,
  provider: string,
): {
  articles: AssignedArticle[];
  report: Pick<AssignmentReport, "included" | "omitted" | "moved" | "other" | "decisions">;
} {
  const expected = new Set(articles.map((_article, index) => candidateId(index)));
  const seen = new Set<string>();
  const sectionByName = new Map(sections.map((section) => [section.name, section]));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const output: AssignedArticle[] = [];
  const decisions: NonNullable<AssignmentReport["decisions"]> = [];
  let omitted = 0;
  let moved = 0;
  let other = 0;

  if (!plan || !Array.isArray(plan.articles) || plan.articles.length !== articles.length) {
    throw new Error("Assignment plan did not return exactly one decision for every article.");
  }

  for (const decision of plan.articles) {
    if (!expected.has(decision.id) || seen.has(decision.id)) {
      throw new Error("Assignment plan contained an unknown or duplicate article id.");
    }
    seen.add(decision.id);
    const index = Number(decision.id.slice("article-".length)) - 1;
    const article = articles[index];
    if (!article) throw new Error("Assignment plan referenced an invalid article.");

    const from = sectionById.get(String(article.section_id || ""))?.name || String(article.section_name || "");
    const confidence = Number.isFinite(decision.confidence)
      ? Math.max(0, Math.min(1, Number(decision.confidence)))
      : null;
    const reason = String(decision.reason || "").trim();

    const retainOriginal = (policyReason: string) => {
      const original = sectionById.get(String(article.section_id || ""));
      if (!original) throw new Error("Assignment policy could not preserve an article with no original section.");
      const retainedReason = reason ? `${reason} ${policyReason}` : policyReason;
      output.push({
        ...article,
        section_id: original.id,
        section_name: original.name,
        assignment_provider: provider,
        assignment_confidence: confidence,
        assignment_reason: retainedReason,
      });
      decisions.push({
        title: article.title,
        source: article.source,
        from,
        to: original.name,
        include: true,
        confidence,
        reason: retainedReason,
      });
    };

    if (decision.label === "OMIT") {
      if (confidence == null || confidence < OMIT_CONFIDENCE_MIN) {
        retainOriginal(`Retained in ${from} because omission requires confidence >= ${OMIT_CONFIDENCE_MIN.toFixed(2)}.`);
        continue;
      }
      omitted++;
      decisions.push({
        title: article.title,
        source: article.source,
        from,
        to: null,
        include: false,
        confidence,
        reason,
      });
      continue;
    }

    if (decision.label === "NO_STRONG_FIT") {
      if (confidence == null || confidence < MOVE_CONFIDENCE_MIN) {
        retainOriginal(`Retained in ${from} because moving to Other requires confidence >= ${MOVE_CONFIDENCE_MIN.toFixed(2)}.`);
        continue;
      }
      other++;
      if (article.section_id) moved++;
      output.push({
        ...article,
        section_id: null,
        section_name: "Other",
        assignment_provider: provider,
        assignment_confidence: confidence,
        assignment_reason: reason,
      });
      decisions.push({
        title: article.title,
        source: article.source,
        from,
        to: "Other",
        include: true,
        confidence,
        reason,
      });
      continue;
    }

    const target = sectionByName.get(decision.label);
    if (!target) throw new Error("Assignment plan used an unknown section label.");
    if (article.section_id && article.section_id !== target.id && (confidence == null || confidence < MOVE_CONFIDENCE_MIN)) {
      retainOriginal(`Retained in ${from} because cross-section moves require confidence >= ${MOVE_CONFIDENCE_MIN.toFixed(2)}.`);
      continue;
    }
    if (article.section_id && article.section_id !== target.id) moved++;

    output.push({
      ...article,
      section_id: target.id,
      section_name: target.name,
      assignment_provider: provider,
      assignment_confidence: confidence,
      assignment_reason: reason,
    });
    decisions.push({
      title: article.title,
      source: article.source,
      from,
      to: target.name,
      include: true,
      confidence,
      reason,
    });
  }

  if (seen.size !== expected.size) throw new Error("Assignment plan omitted one or more article decisions.");
  return { articles: output, report: { included: output.length, omitted, moved, other, decisions } };
}

export function lunaAssignmentClassifier(options: {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
} = {}): AssignmentClassifier {
  const model = options.model || DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl || fetch;
  return {
    name: "luna",
    async classify({ sections, articles, deadline }) {
      const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY") ?? "";
      if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");
      const remaining = deadline - Date.now();
      if (remaining < 8_000) throw new Error("Not enough preparation time remained for assignment classification.");

      const candidates = articles.map((article, index) => ({
        id: candidateId(index),
        current_section: sections.find((section) => section.id === article.section_id)?.name || article.section_name || "",
        title: article.title,
        source: article.source,
        author: article.author || "",
        published_at: article.published_at || "",
        canonical_url: article.canonical_url || article.url,
        excerpt: article.excerpt || "",
        text: plainText(article.body).slice(0, 2200),
      }));

      const system = [
        "You are the assignment desk for Morning Reader, a personal daily newspaper.",
        "Classify every candidate into exactly one supplied section or OMIT.",
        "A candidate's current section is only a discovery hint from its feed. Judge the linked article itself.",
        "Reposts and links discovered through a person's feed must be classified by the linked article's actual subject and publisher metadata, not the feed owner's identity.",
        "NO_STRONG_FIT is exceptional, not a catch-all. Use it only when the article remains clearly relevant to the reader's overall publication themes but does not naturally belong in any supplied section.",
        "Judge overall relevance from the article's substance and the themes implied by the supplied sections. Source identity or subscription alone is never sufficient reason to keep an article.",
        "Use OMIT when the article is unrelated to the publication's overall themes, even if it came from a subscribed feed.",
        "Examples that should normally be OMIT when unrelated to the supplied themes: recreational trail-planning tools, generic job-search trackers, unrelated general-science papers, political commentary, entertainment, and promotions.",
        "A practical consumer-technology article may use NO_STRONG_FIT when technology or engineering is substantively adjacent to the supplied themes; do not force it into TPM merely because it came from a management-oriented feed.",
        "Only move an article between supplied sections when the article's subject clearly fits the destination better than its current section; borderline cases should stay put or use NO_STRONG_FIT.",
        "Return every input id exactly once.",
        "Confidence is your own 0-1 estimate of classification certainty. It is diagnostic only and is not a calibrated probability.",
      ].join("\n");

      const response = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: AbortSignal.timeout(Math.max(5_000, Math.min(25_000, remaining - 3_000))),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          store: false,
          reasoning: { effort: "low" },
          max_output_tokens: 8_000,
          input: [
            { role: "system", content: system },
            {
              role: "user",
              content: JSON.stringify({
                sections: sections.map((section) => ({ name: section.name, brief: section.brief || section.name })),
                candidates,
              }),
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "morning_reader_assignment_plan",
              strict: true,
              schema: assignmentSchema(sections),
            },
          },
        }),
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`OpenAI assignment request failed (${response.status}): ${raw.slice(0, 300)}`);
      const payload = JSON.parse(raw);
      return {
        plan: JSON.parse(outputText(payload)) as AssignmentPlan,
        provider: "luna",
        model,
        usage: payload.usage || undefined,
        confidence_kind: "self_reported",
      };
    },
  };
}

export async function assignIssue(
  sections: AssignmentSection[],
  articles: EpubArticle[],
  options: {
    classifier?: AssignmentClassifier;
    apiKey?: string;
    model?: string;
    deadline?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ articles: AssignedArticle[]; report: AssignmentReport }> {
  const classifier = options.classifier || lunaAssignmentClassifier({
    apiKey: options.apiKey,
    model: options.model,
    fetchImpl: options.fetchImpl,
  });
  const deadline = options.deadline ?? Date.now() + 30_000;

  if (!articles.length || !sections.length) {
    return {
      articles,
      report: {
        status: "skipped",
        provider: classifier.name,
        model: options.model || DEFAULT_MODEL,
        confidence_kind: "none",
        included: articles.length,
        omitted: 0,
        moved: 0,
        other: 0,
      },
    };
  }

  try {
    const result = await classifier.classify({ sections, articles, deadline });
    const applied = applyAssignmentPlan(sections, articles, result.plan, result.provider || classifier.name);
    return {
      articles: applied.articles,
      report: {
        status: "assigned",
        provider: result.provider || classifier.name,
        model: result.model || null,
        confidence_kind: result.confidence_kind || "none",
        ...applied.report,
        usage: result.usage,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      articles,
      report: {
        status: message.includes("not configured") || message.includes("Not enough preparation time") ? "skipped" : "fallback",
        provider: classifier.name,
        model: options.model || DEFAULT_MODEL,
        confidence_kind: "none",
        included: articles.length,
        omitted: 0,
        moved: 0,
        other: 0,
        error: message.slice(0, 500),
      },
    };
  }
}
