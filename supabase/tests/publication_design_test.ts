import JSZip from "npm:jszip@3.10.1";
import jpeg from "npm:jpeg-js@0.4.4";
import { makeEpub, type EpubArticle } from "../functions/_shared/epub.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function article(index: number, section: string, title: string): EpubArticle {
  return {
    title,
    url: `https://example.com/${index}`,
    canonical_url: `https://example.com/${index}`,
    source: "Example",
    author: null,
    published_at: "2026-09-25T12:00:00Z",
    excerpt: `${title} excerpt`,
    body: `<p>Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. Substantial reading text. </p>`,
    assets: [],
    warnings: [],
    article_hash: `hash-${index}`,
    feed_id: `feed-${index}`,
    section_id: null,
    section_name: section,
    editorial_topic: null,
  };
}

Deno.test("publication design uses a Kindle-proportioned cover and editorial section language", async () => {
  const intro = "Tools acquire boundaries, teams acquire rituals, and systems become legible when something pushes against their edges. The stories here circle that pressure from different directions: software needs supervision, organizations reveal their shape through failure, and a quieter detour makes structure easier to see from the side. The recurring question is simple enough to state and harder to answer: once a system starts acting on its own, who decides where it stops?";
  const articles = [
    article(1, "AI & Software Engineering", "Agents move into ordinary software work"),
    article(2, "Developer Tools & Infrastructure", "A very long infrastructure headline that still belongs on the cover"),
    article(3, "Other", "A story that resists the larger clusters"),
    article(4, "Related Discovery", "An outside piece that extends the issue"),
    article(5, "Open Discovery", "A deliberate detour into something unexpected"),
  ];
  const bytes = await makeEpub({
    name: "Morning Reader",
    displayDate: "September 25, 2026",
    date: new Date("2026-09-25T12:00:00Z"),
    timezone: "UTC",
    introduction: intro,
  }, articles);
  const zip = await JSZip.loadAsync(bytes);

  const coverBytes = await zip.file("OEBPS/cover.jpg")!.async("uint8array");
  const cover = jpeg.decode(coverBytes, { useTArray: true });
  assert(cover.width === 1200 && cover.height === 1920, "cover should use a 1.6:1 Kindle portrait ratio");

  const css = await zip.file("OEBPS/style.css")!.async("string");
  assert(css.includes("text-decoration:none!important"), "contents links should not look like blue web-directory links");
  assert(css.includes(".section-deck"), "section decks should have publication styling");

  const contents = await zip.file("OEBPS/contents.xhtml")!.async("string");
  assert(contents.includes("Elsewhere"), "reader-facing contents should rename Other to Elsewhere");
  assert(!contents.includes(">Other<"), "reader-facing contents must not expose the Other fallback label");

  const introPage = await zip.file("OEBPS/introduction.xhtml")!.async("string");
  assert(!introPage.includes('<h1 class="publication-title">Morning Reader</h1>'), "editor note should avoid repeating the masthead and wasting a screen");
  assert(introPage.includes("Editor's note"), "editor note identity should remain visible");

  const related = await zip.file("OEBPS/section-4.xhtml")!.async("string");
  const open = await zip.file("OEBPS/section-5.xhtml")!.async("string");
  assert(related.includes("Further reading on ideas running through this issue."), "Related Discovery should explain its editorial role");
  assert(open.includes("A deliberate detour."), "Open Discovery should explain its editorial role");

  const longSection = await zip.file("OEBPS/section-2.xhtml")!.async("string");
  assert(longSection.includes('style="font-size:2.02em"'), "long divider titles should scale down instead of wrapping at oversized display type");
});
