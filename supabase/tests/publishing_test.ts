import JSZip from "npm:jszip@3.10.1";
import jpeg from "npm:jpeg-js@0.4.4";
import { extractArticle, extractArticleDocument, extractMediumFeedArticle, extractionBudget, hydrateArticleImages, plainText, sanitizeArticleHtml, textValue, type Article } from "../functions/_shared/article.ts";
import { makeEpub, repairArticleAnchors, validateEpub, type EpubArticle } from "../functions/_shared/epub.ts";

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

Deno.test("recovers original publisher URLs from Substack image transformation paths", () => {
  const html = sanitizeArticleHtml(
    '<img src="fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fexample_1600x140.png" alt="Notebook">',
    "https://newsletter.pragmaticengineer.com/p/example",
  );
  assert(
    html.includes('src="https://substack-post-media.s3.amazonaws.com/public/images/example_1600x140.png"'),
    "encoded Substack origin URLs should be recovered before article-relative resolution",
  );
  assert(!html.includes("newsletter.pragmaticengineer.com/p/fl_progressive"), "broken article-relative image URLs must not survive sanitization");
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

Deno.test("embeds a valid image larger than the previous 1.5 MB ceiling", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array(1_600_000);
  bytes.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a], 0);
  globalThis.fetch = (async () => new Response(bytes)) as typeof fetch;
  try {
    const article: Article = {
      title: "Large but bounded image",
      url: "https://8.8.8.8/article",
      canonical_url: "https://8.8.8.8/article",
      source: "Example",
      author: null,
      published_at: null,
      excerpt: "",
      body: '<p>Article text survives.</p><img src="https://8.8.8.8/large.png" alt="Large image">',
      assets: [],
      warnings: [],
      article_hash: "large-image",
    };
    const hydrated = await hydrateArticleImages(article, extractionBudget(Date.now() + 10_000));
    assert(hydrated.assets.length === 1, "a 1.6 MB supported image should fit within the per-image ceiling");
    assert(hydrated.media?.embedded === 1 && hydrated.media?.failed === 0, "large but bounded media should embed cleanly");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("prefers Kindle-safe picture fallbacks over WebP sources", async () => {
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    fetched.push(url.pathname);
    if (url.pathname === "/fallback.jpg") return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    if (url.pathname === "/modern.webp") return new Response(new Uint8Array([0x52,0x49,0x46,0x46,0x00,0x00,0x00,0x00,0x57,0x45,0x42,0x50]));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const body = sanitizeArticleHtml('<picture><source type="image/jpeg" srcset="https://8.8.8.8/fallback.jpg 2x"><source type="image/webp" srcset="https://8.8.8.8/modern.webp 2x"><img src="https://8.8.8.8/modern.webp" alt="Diagram"></picture>', "https://8.8.8.8/article");
    const article: Article = {
      title: "Fallback image",
      url: "https://8.8.8.8/article",
      canonical_url: "https://8.8.8.8/article",
      source: "Example",
      author: null,
      published_at: null,
      excerpt: "",
      body,
      assets: [],
      warnings: [],
      article_hash: "fallback",
    };
    const hydrated = await hydrateArticleImages(article, extractionBudget(Date.now() + 10_000));
    assert(fetched.includes("/fallback.jpg"), "supported picture fallback should be fetched");
    assert(!fetched.includes("/modern.webp"), "WebP should not be fetched when a JPEG fallback exists");
    assert(hydrated.media?.embedded === 1 && hydrated.media?.failed === 0, "fallback should count as a successful embedded image");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("transcodes WebP-only publisher images to packaged PNG", async () => {
  const originalFetch = globalThis.fetch;
  const webp = Uint8Array.from(
    atob("UklGRjoAAABXRUJQVlA4IC4AAADwAQCdASoCAAIAAUAmJaACdLoB+AAEyAAA/q4X/zYEDND6YP/SbPE2eJs+OYAA"),
    (char) => char.charCodeAt(0),
  );
  globalThis.fetch = (async () => new Response(webp)) as typeof fetch;
  try {
    const article: Article = {
      title: "WebP image",
      url: "https://8.8.8.8/article",
      canonical_url: "https://8.8.8.8/article",
      source: "Example",
      author: null,
      published_at: null,
      excerpt: "",
      body: '<p>Article text survives.</p><img src="https://8.8.8.8/only.webp" alt="WebP only">',
      assets: [],
      warnings: [],
      article_hash: "webp",
    };
    const hydrated = await hydrateArticleImages(article, extractionBudget(Date.now() + 10_000));
    assert(
      hydrated.media?.discovered === 1 && hydrated.media?.embedded === 1 && hydrated.media?.failed === 0,
      "WebP media should be embedded after transcoding: " + JSON.stringify({ media: hydrated.media, warnings: hydrated.warnings }),
    );
    assert(hydrated.assets.length === 1 && hydrated.assets[0].mediaType === "image/png", "WebP should be packaged as a Kindle-safe PNG");
    assert(hydrated.assets[0].bytes[0] === 0x89 && hydrated.assets[0].bytes[1] === 0x50, "transcoded bytes should have a PNG signature");
    assert(!hydrated.warnings.some((warning) => warning.includes("only.webp")), "successful WebP transcoding should not emit an omission warning");
    assert(plainText(hydrated.body).includes("Article text survives."), "transcoding must not alter article text");
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
  assert(nav.includes('epub:type="toc"'), "EPUB 3 navigation must identify its table of contents");
  assert(opf.includes('properties="cover-image"'), "cover image should be identified in the package");
  assert(opf.includes('<meta name="cover" content="cover-image"/>'), "legacy cover metadata must reference the same image");
  assert(opf.includes('href="cover.jpg" media-type="image/jpeg"'), "the cover must use the tested JPEG packaging");
  assert(!zip.file("OEBPS/cover.xhtml") && !opf.includes('idref="cover"'), "do not add a second HTML cover page");
  const cover = jpeg.decode(await zip.file("OEBPS/cover.jpg")!.async("uint8array"), { useTArray: true, maxResolutionInMP: 2 });
  assert(cover.width === 1200 && cover.height === 1600, "cover must decode at the approved resolution");
  assert(page.includes('id="reader-anchor-1"') && page.includes('href="#reader-anchor-1"'), "packaging must repair invalid cached publisher anchors and links");
  assert(opf.includes('href="images/example.png" media-type="image/png"'), "embedded images should be listed in the manifest");
  assert(page.includes('<img src="images/example.png" alt="Example" />'), "article images should be valid XHTML");
  assert(Boolean(zip.file("OEBPS/toc.ncx")), "legacy Kindle navigation should be included");
});


Deno.test("publisher metadata overrides curator feed attribution when the linked article is fetched", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assert(url.hostname === "8.8.8.8", "unexpected network host");
    return new Response(`<!doctype html><html><head>
      <title>Actual linked article | Original Journal</title>
      <meta property="og:title" content="Actual linked article">
      <meta property="og:site_name" content="Original Journal">
      <meta name="author" content="Actual Writer">
      <meta property="article:published_time" content="2026-09-23T08:00:00Z">
      <link rel="canonical" href="https://8.8.8.8/story">
    </head><body><article><h1>Actual linked article</h1>
      <p>This is a deliberately substantial linked article used to verify that the publisher page wins over discovery-feed attribution.</p>
      <p>The item was surfaced through another person's feed, but the original publication and author must appear in Morning Reader.</p>
      <p>Enough additional prose is included to satisfy the readability threshold and exercise the same extraction path used in production.</p>
    </article></body></html>`);
  }) as typeof fetch;
  try {
    const result = await extractArticle({
      url: "https://8.8.8.8/story",
      title: "Shared by Mustafa Suleyman",
      source: "Mustafa Suleyman",
      author: "Mustafa Suleyman",
      publishedAt: "2026-09-23T07:00:00Z",
      feedHtml: "<p>A short feed summary that should trigger publisher-page extraction.</p>",
      feedKind: "summary",
      includeImages: false,
    });
    assert(result.title === "Actual linked article", "publisher title should replace repost/feed framing");
    assert(result.source === "Original Journal", "publisher should replace curator feed as source");
    assert(result.author === "Actual Writer", "actual article author should replace curator feed author");
    assert(result.published_at === "2026-09-23T08:00:00.000Z", "publisher publication date should be authoritative");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


Deno.test("resolves HNRSS link-post wrappers to the linked publisher article", async () => {
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    fetched.push(url.toString());
    assert(url.hostname === "8.8.8.8" && url.pathname === "/story", "link-post extraction should fetch the Article URL, not the wrapper/comments page");
    return new Response(`<!doctype html><html><head>
      <title>Actual linked story | Original Journal</title>
      <meta property="og:title" content="Actual linked story">
      <meta property="og:site_name" content="Original Journal">
      <meta name="author" content="Actual Writer">
      <link rel="canonical" href="https://8.8.8.8/story">
    </head><body><article><h1>Actual linked story</h1>
      <p>This is the opening paragraph of the real linked publisher article and is deliberately substantial enough for readable extraction.</p>
      <p>It proves that Morning Reader follows the Article URL carried inside a link-post feed instead of packaging the discovery wrapper metadata as reading content.</p>
      <p>A final paragraph provides enough additional prose to behave like an ordinary article page and pass the extraction threshold reliably.</p>
    </article></body></html>`);
  }) as typeof fetch;

  try {
    const wrapper = `<p>Article URL: <a href="https://8.8.8.8/story">https://8.8.8.8/story</a></p>
      <p>Comments URL: <a href="https://news.ycombinator.com/item?id=123">https://news.ycombinator.com/item?id=123</a></p>
      <p>Points: 212</p><p># Comments: 89</p>`;
    const result = await extractArticle({
      url: "https://news.ycombinator.com/item?id=123",
      title: "Actual linked story",
      source: "Mustafa Suleyman — via Hacker News",
      feedHtml: wrapper,
      feedKind: "full",
      includeImages: false,
    });

    assert(fetched.length === 1, "link-post extraction should make exactly one publisher-page request");
    assert(result.canonical_url === "https://8.8.8.8/story", "canonical URL should be the linked publisher article");
    assert(result.source === "Original Journal", "publisher metadata should replace the discovery feed as source");
    assert(result.author === "Actual Writer", "publisher author should replace discovery metadata");
    assert(plainText(result.body).includes("real linked publisher article"), "the publisher article body should become the reading copy");
    assert(!plainText(result.body).includes("Comments URL") && !plainText(result.body).includes("Points: 212"), "HNRSS wrapper metadata must never become article content");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("does not fall back to HNRSS wrapper metadata when the publisher article is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("publisher unavailable", { status: 503 })) as typeof fetch;
  try {
    const wrapper = `<p>Article URL: <a href="https://8.8.8.8/unavailable">https://8.8.8.8/unavailable</a></p>
      <p>Comments URL: <a href="https://news.ycombinator.com/item?id=456">https://news.ycombinator.com/item?id=456</a></p>
      <p>Points: 99</p><p># Comments: 12</p>`;

    let threw = false;
    try {
      await extractArticle({
        url: "https://news.ycombinator.com/item?id=456",
        title: "Unavailable publisher story",
        source: "Mustafa Suleyman — via Hacker News",
        feedHtml: wrapper,
        feedKind: "full",
        includeImages: false,
      });
    } catch {
      threw = true;
    }
    assert(threw, "link-post wrappers should be omitted when the real publisher article cannot be extracted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("renders a book-native linear edition with hierarchical native navigation", async () => {
  const articles: EpubArticle[] = [
    {
      title: "Reliability for production agents",
      url: "https://example.com/one",
      canonical_url: "https://example.com/one",
      source: "Engineering Journal",
      author: "Ada Writer",
      published_at: "2026-09-23T12:00:00Z",
      excerpt: "",
      body: "<p>SENTINEL-ONE original article body.</p>",
      assets: [],
      warnings: [],
      article_hash: "one",
      section_id: "ai",
      section_name: "AI",
      editorial_topic: "Production agents",
    },
    {
      title: "Observability for long-running agents",
      url: "https://example.com/two",
      canonical_url: "https://example.com/two",
      source: "Systems Review",
      author: "B. Writer",
      published_at: "2026-09-23T11:00:00Z",
      excerpt: "",
      body: "<p>SENTINEL-TWO original article body.</p>",
      assets: [],
      warnings: [],
      article_hash: "two",
      section_id: "ai",
      section_name: "AI",
      editorial_topic: "Production agents",
    },
    {
      title: "Design Engineering with Maggie Appleton",
      url: "https://example.com/three",
      canonical_url: "https://example.com/three",
      source: "Pragmatic Engineer",
      author: "C. Writer",
      published_at: "2026-09-23T10:00:00Z",
      excerpt: "",
      body: "<p>SENTINEL-THREE original article body.</p>",
      assets: [],
      warnings: [],
      article_hash: "three",
      section_id: "ai",
      section_name: "AI",
      editorial_topic: "Designing with AI",
    },
    {
      title: "Database internals in practice",
      url: "https://example.com/four",
      canonical_url: "https://example.com/four",
      source: "Systems Review",
      author: "D. Writer",
      published_at: "2026-09-23T09:00:00Z",
      excerpt: "",
      body: "<p>SENTINEL-FOUR original article body.</p>",
      assets: [],
      warnings: [],
      article_hash: "four",
      section_id: "systems",
      section_name: "Systems",
      editorial_topic: "Database architecture",
    },
  ];

  const bytes = await makeEpub({
    name: "Morning Reader",
    displayDate: "September 23, 2026",
    date: new Date("2026-09-23T12:00:00Z"),
    timezone: "America/Los_Angeles",
  }, articles);

  const zip = await JSZip.loadAsync(bytes);
  const contents = await zip.file("OEBPS/contents.xhtml")!.async("string");
  const sectionOne = await zip.file("OEBPS/section-1.xhtml")!.async("string");
  const sectionTwo = await zip.file("OEBPS/section-2.xhtml")!.async("string");
  const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
  const ncx = await zip.file("OEBPS/toc.ncx")!.async("string");
  const opf = await zip.file("OEBPS/content.opf")!.async("string");
  const pageOne = await zip.file("OEBPS/article-1.xhtml")!.async("string");
  const pageTwo = await zip.file("OEBPS/article-2.xhtml")!.async("string");
  const pageThree = await zip.file("OEBPS/article-3.xhtml")!.async("string");
  const pageFour = await zip.file("OEBPS/article-4.xhtml")!.async("string");

  assert(contents.includes('<span class="section-index-name">AI</span>') && contents.includes('<span class="section-index-name">Systems</span>'), "visible contents should retain clear section hierarchy");
  assert(!/<(?:ol|li)(?:\s|>)/.test(contents), "reader-facing contents should avoid Kindle auto-numbered list markup");
  assert(contents.includes('<h3 class="contents-topic-name">Production agents</h3>'), "visible contents should expose topic labels");
  assert(contents.includes('href="article-1.xhtml">Reliability for production agents</a>'), "visible contents should link each article title directly to its article");
  assert(contents.includes('href="article-2.xhtml">Observability for long-running agents</a>') && contents.includes('href="article-3.xhtml">Design Engineering with Maggie Appleton</a>') && contents.includes('href="article-4.xhtml">Database internals in practice</a>'), "every retained article title must appear in the opening contents");
  assert(sectionOne.includes('<h1 class="section-name">AI</h1>') && sectionOne.includes("3 stories"), "section divider should name the section and story count");
  assert(!sectionOne.includes("<a ") && !sectionOne.includes("Begin section"), "section divider should contain no navigation chrome");
  assert(!sectionOne.includes("Reliability for production agents") && !sectionOne.includes("Production agents"), "section divider should not list articles or topics");
  assert(sectionTwo.includes('<h1 class="section-name">Systems</h1>'), "next section should have its own divider");
  assert(!pageOne.includes("Production agents") && !pageTwo.includes("Production agents"), "topic labels should not appear in visible article pages");
  assert(!pageThree.includes("Designing with AI") && !pageFour.includes("Database architecture"), "topic labels should remain native-navigation-only");
  assert(!pageOne.includes("article-nav") && !pageOne.includes('href="contents.xhtml"') && !pageOne.includes('href="section-1.xhtml"'), "article pages should contain no visible internal navigation chrome");
  assert(pageOne.includes('<hr class="article-rule" />'), "article metadata should be separated from the body by a restrained rule");
  assert(pageOne.includes("SENTINEL-ONE original article body") && pageFour.includes("SENTINEL-FOUR original article body"), "original article bodies must remain unchanged");
  assert(!pageOne.includes("topic-intro") && !sectionOne.includes("topic-intro"), "no generated topic prose should appear in visible reading pages");

  assert(nav.includes('href="section-1.xhtml">AI</a>'), "EPUB nav should expose section entries");
  assert(nav.includes('href="article-1.xhtml">Production agents</a>'), "EPUB nav should expose topic entries");
  assert(nav.includes('href="article-1.xhtml">Reliability for production agents</a>'), "EPUB nav should expose article entries");
  assert(ncx.includes("<text>AI</text>") && ncx.includes("<text>Production agents</text>") && ncx.includes("<text>Reliability for production agents</text>"), "legacy Kindle NCX should preserve section-topic-article hierarchy");
  assert(opf.includes('<spine toc="ncx"><itemref idref="contents"/><itemref idref="section-1"/><itemref idref="article-1"/><itemref idref="article-2"/><itemref idref="article-3"/><itemref idref="section-2"/><itemref idref="article-4"/>'), "reading spine should remain linear by section");
  const qa = await validateEpub(bytes, articles);
  assert(qa.articles === 4 && qa.contentsEntries === 4, "pre-send EPUB QA should prove every retained article is represented in the opening contents");
});
