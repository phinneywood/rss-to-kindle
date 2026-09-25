import { extractArticle } from "../functions/_shared/article.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("article cleanup removes a redundant leading date when the title is a dated note", async () => {
  const body = `
    <h2>24th September 2026</h2>
    <p>Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. Substantial original article text follows the date heading. </p>
  `;
  const article = await extractArticle({
    url: "https://example.com/note",
    title: "Note on 24th September 2026",
    source: "Example",
    publishedAt: "2026-09-24T10:00:00Z",
    feedHtml: body,
    feedKind: "full",
    includeImages: false,
  });
  assert(!article.body.includes("24th September 2026"), "redundant body date should be removed");
  assert(article.body.includes("Substantial original article text"), "article body must remain intact");
});

Deno.test("article cleanup preserves a meaningful non-date opening heading", async () => {
  const body = `
    <h2>A question worth asking</h2>
    <p>Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. Substantial original article text follows the meaningful heading. </p>
  `;
  const article = await extractArticle({
    url: "https://example.com/essay",
    title: "Note on 24th September 2026",
    source: "Example",
    publishedAt: "2026-09-24T10:00:00Z",
    feedHtml: body,
    feedKind: "full",
    includeImages: false,
  });
  assert(article.body.includes("A question worth asking"), "meaningful body headings must not be stripped");
});
