import JSZip from "npm:jszip@3.10.1";
import { extractArticleDocument, plainText, sanitizeArticleHtml, textValue, type Article } from "../functions/_shared/article.ts";
import { makeEpub } from "../functions/_shared/epub.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("joins array-valued RSS and Atom content", () => {
  const value = { __cdata: ["<p>First</p>", "<p>Second</p>"] };
  assert(textValue(value) === "<p>First</p><p>Second</p>", "CDATA arrays should be joined in order");
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

Deno.test("builds an EPUB with navigation, images, and reflowable articles", async () => {
  const article: Article = {
    title: "Example article",
    url: "https://example.com/article",
    canonical_url: "https://example.com/article",
    source: "Example",
    author: "A. Writer",
    published_at: "2026-09-19T12:00:00Z",
    excerpt: "Example excerpt",
    body: '<p>Opening text.</p><figure><img src="images/example.png" alt="Example"><figcaption>Caption</figcaption></figure>',
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
  assert(nav.includes('epub:type="toc"'), "EPUB 3 navigation must identify its table of contents");
  assert(opf.includes('properties="cover-image"'), "cover image should be identified in the package");
  assert(opf.includes('href="images/example.png" media-type="image/png"'), "embedded images should be listed in the manifest");
  assert(page.includes('<img src="images/example.png" alt="Example" />'), "article images should be valid XHTML");
  assert(Boolean(zip.file("OEBPS/toc.ncx")), "legacy Kindle navigation should be included");
});
