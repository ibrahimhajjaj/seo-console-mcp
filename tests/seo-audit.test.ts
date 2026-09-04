import { describe, expect, it } from "vitest";
import { parseSeoHtml } from "../src/seo-audit.js";

const COMPLETE_HTML = `<!doctype html>
<html lang="en"><head>
  <title>Production SEO Guide</title>
  <meta name="description" content="A practical guide to production SEO.">
  <link rel="canonical" href="/guide">
  <meta name="robots" content="index,follow">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta property="og:title" content="Production SEO Guide">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":["Article","TechArticle"]}</script>
</head><body>
  <h1>Production SEO</h1><h2>Measure</h2><h3>Field data</h3>
  <p>This is a practical guide with enough visible words for counting accurately.</p>
  <img src="hero.jpg" alt="SEO dashboard"><img src="chart.jpg">
  <a href="/about">About</a><a href="https://other.example/page">External</a><a href="#measure">Jump</a>
</body></html>`;

describe("parseSeoHtml", () => {
  it("extracts metadata, headings, schema, images, links, and text", () => {
    const result = parseSeoHtml(COMPLETE_HTML, "https://example.com/start");
    expect(result.title).toMatchObject({ text: "Production SEO Guide", count: 1, length: 20 });
    expect(result.metaDescription.text).toBe("A practical guide to production SEO.");
    expect(result.canonical).toBe("https://example.com/guide");
    expect(result.h1).toEqual({ count: 1, texts: ["Production SEO"] });
    expect(result.headingOutline.map((heading) => heading.level)).toEqual([1, 2, 3]);
    expect(result.openGraph).toMatchObject({ title: "Production SEO Guide", type: "article" });
    expect(result.twitter).toMatchObject({ card: "summary_large_image" });
    expect(result.schemaTypes).toEqual(["Article", "TechArticle"]);
    expect(result.images).toEqual({ count: 2, withAlt: 1, altPercentage: 50 });
    expect(result.links).toEqual({ internal: 2, external: 1 });
    expect(result.lang).toBe("en");
    expect(result.viewport).toContain("width=device-width");
    expect(result.issues).toEqual([]);
  });

  it("flags missing and duplicate fundamentals", () => {
    const result = parseSeoHtml("<html><head><title>One</title><title>Two</title></head><body><h1>A</h1><h1>B</h1></body></html>", "https://example.com");
    expect(result.issues).toEqual(expect.arrayContaining(["Multiple title elements (2)", "Missing meta description", "Multiple H1 headings (2)", "Missing canonical URL", "No JSON-LD schema found"]));
  });

  it("handles invalid JSON-LD without failing the audit", () => {
    const result = parseSeoHtml("<html><head><script type='application/ld+json'>{oops</script></head><body></body></html>", "https://example.com");
    expect(result.schemaTypes).toEqual([]);
    expect(result.issues).toContain("Invalid JSON-LD block (1)");
  });

  it("ignores SVG <title> elements", () => {
    const result = parseSeoHtml("<html><head><title>Real</title></head><body><svg><title>Icon label</title></svg></body></html>", "https://example.com");
    expect(result.title).toEqual({ text: "Real", count: 1, length: 4 });
    const multipleTitlesIssue = result.issues.find((i) => i.startsWith("Multiple title elements"));
    expect(multipleTitlesIssue).toBeUndefined();
  });

  it("reports missing title when the only title is inside an SVG", () => {
    const result = parseSeoHtml("<html><body><svg><title>Icon label</title></svg></body></html>", "https://example.com");
    expect(result.title.text).toBeNull();
    expect(result.issues).toContain("Missing title element");
  });

  it("counts only non-empty alt text for images", () => {
    const result = parseSeoHtml(`<html><body><img alt="good"><img alt=""><img alt="   "><img></body></html>`, "https://example.com");
    expect(result.images).toEqual({ count: 4, withAlt: 1, altPercentage: 25 });
  });

  it("classifies links by hostname (ignoring scheme)", () => {
    const result = parseSeoHtml(`<html><body><a href="http://example.com/legacy">A</a><a href="https://other.example/">B</a></body></html>`, "https://example.com/");
    expect(result.links).toEqual({ internal: 1, external: 1 });
  });
});
