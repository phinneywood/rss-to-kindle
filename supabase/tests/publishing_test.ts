import JSZip from "npm:jszip@3.10.1";
import jpeg from "npm:jpeg-js@0.4.4";
import { extractArticle, extractArticleDocument, extractMediumFeedArticle, extractionBudget, hydrateArticleImages, plainText, sanitizeArticleHtml, textValue, type Article } from "../functions/_shared/article.ts";
import { makeEpub, repairArticleAnchors, type EpubArticle } from "../functions/_shared/epub.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("repairs publisher anchors that EPUB rejects without breaking fragment links", () => {
  const html = '<p id="reader-anchor-1">Reserved</p><figure id="Non-linear presentation.png">Diagram</figure><a href="#Non-linear%20presentation.png">Encoded link</a><a href="#Non-linear presentation.png">Raw link</a><p id="">Empty</p><p id="literal%20id">Literal</p><p id="literal id">Spaced</p><a href="#literal%20id">Literal link</a><a href="#bad%ZZ">Malformed link</a>';
  const repaired = repairArticleAnchors(html);
  assert(repaired.includes('id="reader-anchor-2"'), "generated anchors must avoid existing IDs");
  assert((repaired.match(/href="#reader-anchor-2"/g) || []).length === 2, "raw and encoded fragment links must follow their repaired target");
  assert(!repaired.includes('id=""'), "empty IDs must be removed");
  assert(repaired.includes('href="#literal%20id"'), "literal percent-encoded targets must remain usable");
  assert(repaired.includes('href="#bad%ZZ"'), "malformed fragments must not fail the build");
  assert(repairArticleAnchors(repaired) === repaired, "anchor repair must be idempotent");
});

Deno.test("joins array-valued RSS and Atom content", () => {
  const value = { __cdata: ["<p>First</p>", "<p>Second</p>"] };
  assert(textValue(value) === "<p>First</p><p>Second</p>", "CDATA arrays should be joined in order");
});

Deno.test("uses a matching Medium publication-feed item when the article page is blocked", () => {
  const requested = "https://tpmstories.medium.com/tpm-stories-divya-bhagavan-from-target-237c6eb1c542";
  const body = "<p>This is a deliberately substantial Medium article body used to verify the feed fallback when the publisher page rejects the worker request.</p><p>It contains enough text to pass the readability threshold while preserving the original article URL, title, author, publication name, and date.</p><p>The real worker fetches this content from the publication RSS feed only after the article-page request fails.</p>";
  const feed = `<?xml version="1.0"?><rss><channel><title>TPM Stories</title><item><title>TPM Stories — Divya Bhagavan from Target</title><link>${requested}?source=rss</link><guid>${requested}?source=rss</guid><dc:creator>TPM Stories</dc:creator><pubDate>Thu, 14 May 2026 12:00:00 GMT</pubDate><content:encoded><![CDATA[${body}]]></content:encoded></item></channel></rss>`;
  const article = extractMediumFeedArticle(feed, requested);
  assert(article !== null, "matching Medium feed entries should be found by article ID");
  assert(article.title === "TPM Stories — Divya Bhagavan from Target", "feed title should be retained");
  assert(article.source === "TPM Stories", "publication title should become the source");
  assert(article.author === "TPM Stories", "feed creator should become the author");
  assert(article.publishedAt === "2026-05-14T12:00:00.000Z", "feed publication date should be normalized");
  assert(article.canonicalUrl === requested, "RSS tracking parameters should be removed from the canonical URL");
  assert(plainText(article.html).includes("publisher page rejects the worker request"), "full feed content should be preserved");
});

Deno.test("preserves reading structure and repairs URLs", () => {
  const html = sanitizeArticleHtml(`
    <article>
      <h1 id="start">Example</h1>
      <p><a href="/story">Story</a> and <a href="#note">footnote</a>.</p>
      <figure><img src="/image.jpg" alt="Diagram"><figcaption>A useful diagram</figcaption></figure>
      <table><thead><tr><th>Plan</th><th>Cost</th></tr></thead><tbody><tr><td>A</td><td>$5</td></tr></tbody></table>
      <iframe src="/video"></iframe>
      <script>alert('no')</script>
    </article>
  `, "https://example.com/posts/one");
  assert(html.includes('href="https://example.com/story"'), "relative article links should become absolute");
  assert(html.includes('href="#note"'), "internal footnote links should survive");
  assert(html.includes('id="start"'), "footnote and heading targets should survive");
  assert(html.includes('src="https://example.com/image.jpg"'), "image URLs should become absolute");
  assert(html.includes("<figcaption>A useful diagram</figcaption>"), "captions should remain structured");
  assert(html.includes("<table>"), "tables should remain structured");
  assert(html.includes('href="https://example.com/video"'), "unsupported embeds should become links");
  assert(!html.includes("script"), "scripts must be removed");
  assert(plainText(html).includes("Plan Cost A $5"), "table text should remain readable");
});

Deno.test("extracts visible and structured article metadata", () => {
  const article = extractArticleDocument(`<!doctype html><html><head>
    <title>An investigation | Example Journal</title>
    <link rel="canonical" href="/investigation">
    <meta property="og:title" content="An investigation | Example Journal">
    <script type="application/ld+json">{"@graph":[{"@type":"WebPage","datePublished":"2026-09-18T08:00:00Z"},{"@type":"WebSite","name":"Example Journal"}]}</script>
  </head><body><article><h1>An investigation</h1><div><a class="author url fn" rel="author">Ada Writer</a></div>
  <p>This is the opening paragraph of a deliberately substantial article used to verify readable extraction.</p>
  <p>It includes enough additional prose for the readability threshold and confirms that publisher metadata remains attached to the clean reading copy without duplicating the publication name in the title.</p>
  <p>A final paragraph makes the article long enough to behave like an ordinary publisher page rather than a short status message or navigation fragment.</p></article></body></html>`, "https://example.com/original");
  assert(article.title === "An investigation", "publication suffixes should not be repeated in titles");
  assert(article.source === "Example Journal", "JSON-LD website names should supply the source");
  assert(article.author === "Ada Writer", "visible author names should take precedence over noisy bylines");
  assert(article.publishedAt === "2026-09-18T08:00:00.000Z", "JSON-LD publish dates should be retained");
  assert(article.canonicalUrl === "https://example.com/investigation", "relative canonical URLs should resolve");
});



Deno.test("hydrates article images only when explicitly requested after text extraction", async () => {
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    fetched.push(url.pathname);
    if (url.hostname === "8.8.8.8" && url.pathname === "/diagram.png") {
      return new Response(new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const article: Article = {
      title: "Text-first article",
      url: "https://8.8.8.8/article",
      canonical_url: "https://8.8.8.8/article",
      source: "Example",
      author: null,
      published_at: null,
      excerpt: "",
      body: '<p>Text remains available before media work.</p><img src="https://8.8.8.8/diagram.png" alt="Diagram">',
      assets: [],
      warnings: [],
      article_hash: "text-first",
    };
    assert(article.assets.length === 0, "text-first article should begin without fetched assets");
    assert(fetched.length === 0, "constructing a text-first article must not fetch images");
    const hydrated = await hydrateArticleImages(article, extractionBudget(Date.now() + 10_000));
    assert(fetched.includes("/diagram.png"), "explicit hydration should fetch the image");
    assert(hydrated.assets.length === 1, "hydration should attach the fetched image asset");
    assert(!hydrated.body.includes("https://8.8.8.8/diagram.png"), "hydrated article body should reference the packaged local image");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("builds an EPUB with navigation, images, and reflowable articles", async () => {
  const article: Article = {
    title: "Example article",
    url: "https://example.com/article",
    canonical_url: "https://example.com/article",
    source: "Example",
    author: "A. Writer",
    published_at: "2026-09-19T12:00:00Z",
    excerpt: "Example excerpt",
    body: '<p>Opening text.</p><figure id="Example diagram"><img src="images/example.png" alt="Example"><figcaption>Caption</figcaption></figure><a href="#Example%20diagram">See diagram</a>',
    assets: [{ href: "images/example.png", mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]), sourceUrl: "https://example.com/example.png" }],
    warnings: [],
    article_hash: "example",
  };
  const bytes = await makeEpub({
    name: "Technology & consequences",
    displayDate: "September 19, 2026",
    date: new Date("2026-09-19T12:00:00Z"),
    timezone: "America/Los_Angeles",
  }, [article]);
  const zip = await JSZip.loadAsync(bytes);
  const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
  const opf = await zip.file("OEBPS/content.opf")!.async("string");
  const page = await zip.file("OEBPS/article-1.xhtml")!.async("string");
  assert(nav.includes('epub:type="toc"') && nav.includes("<ol>"), "machine navigation should remain a standards-compliant EPUB nav document");
  assert(contents.includes('href="section-1.xhtml">AI</a>') && contents.includes('href="section-2.xhtml">Systems</a>'), "front page should make sections explicit and navigable");
  assert(!contents.includes("Reliability for production agents"), "front page should not collapse section content into one long page");
  assert(sectionOne.includes('<header class="section-banner">') && sectionOne.includes('<h1 class="section-name">AI</h1>'), "AI should have its own unmistakable section front");
  assert(sectionTwo.includes('<header class="section-banner">') && sectionTwo.includes('<h1 class="section-name">Systems</h1>'), "Systems should have its own unmistakable section front");
  assert(sectionOne.includes("Reliability for production agents") && !sectionOne.includes("Database internals in practice"), "section fronts must not leak articles across sections");
  assert(sectionTwo.includes("Database internals in practice") && !sectionTwo.includes("Reliability for production agents"), "each section front should contain only its assigned articles");
  assert(!/<ol\\b/i.test(sectionOne) && !/<li\\b/i.test(sectionOne), "reader-facing section fronts must avoid Kindle-renumberable list markup");
  assert(opf.includes('<item id="section-1" href="section-1.xhtml" media-type="application/xhtml+xml"/>'), "section fronts must be packaged as first-class EPUB documents");
  assert(opf.includes('<spine toc="ncx"><itemref idref="contents"/><itemref idref="section-1"/><itemref idref="article-1"/>'), "spine should place each section front immediately before its articles");
  assert(css.includes("section-banner") && css.includes("background:#111") && css.includes("color:#fff"), "section fronts should use a high-contrast masthead");
  assert(css.includes("text-align:left") && css.includes("hyphens:none"), "topic notes should avoid Kindle justification and hyphenation");
  assert(pageOne.includes('href="section-1.xhtml"') && pageTwo.includes('href="section-1.xhtml"'), "AI articles should link back to the AI section front");
  assert(pageOne.includes(bodyOne) && pageTwo.includes(bodyTwo), "original article bodies must remain intact");
  assert(!pageOne.includes("Two articles examine the operational demands"), "generated topic copy must stay outside original article pages");
  assert(!pageTwo.includes("Two articles examine the operational demands"), "generated topic copy must stay outside original article pages");
});
