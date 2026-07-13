import { describe, expect, it } from "vitest";
import {
  indexNowSubmitInput,
  inspectUrlInput,
  keywordIdeasInput,
  listSitemapsInput,
  pageSpeedInput,
  requestRecrawlInput,
  searchAnalyticsInput,
  seoAuditInput,
  submitSitemapInput,
} from "../src/schemas.js";
import { normalizeSiteUrl } from "../src/site-url.js";

describe("normalizeSiteUrl", () => {
  it("normalizes URL-prefix properties", () => {
    expect(normalizeSiteUrl("https://Example.com/path")).toBe("https://example.com/path/");
  });

  it("accepts domain properties", () => {
    expect(normalizeSiteUrl("sc-domain:Example.COM")).toBe("sc-domain:example.com");
  });

  it.each(["example.com", "ftp://example.com", "sc-domain:https://example.com", "javascript:alert(1)"])(
    "rejects invalid property %s",
    (value) => expect(() => normalizeSiteUrl(value)).toThrow(),
  );
});

describe("tool input schemas", () => {
  it("accepts search analytics defaults and filters", () => {
    const parsed = searchAnalyticsInput.parse({
      siteUrl: "sc-domain:example.com",
      dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "query", operator: "contains", expression: "mcp" }] }],
    });
    expect(parsed.dimensions).toEqual(["query"]);
    expect(parsed.rowLimit).toBe(25);
  });

  it("accepts search analytics data state and aggregation type", () => {
    const parsed = searchAnalyticsInput.parse({
      siteUrl: "sc-domain:example.com",
      dataState: "all",
      aggregationType: "byPage",
    });
    expect(parsed.dataState).toBe("all");
    expect(parsed.aggregationType).toBe("byPage");
  });

  it("rejects an invalid search analytics data state", () => {
    expect(() => searchAnalyticsInput.parse({
      siteUrl: "sc-domain:example.com",
      dataState: "weekly",
    })).toThrow();
  });

  it("rejects invalid search analytics inputs", () => {
    expect(() => searchAnalyticsInput.parse({ siteUrl: "example.com", rowLimit: 25001 })).toThrow();
    expect(() => searchAnalyticsInput.parse({ siteUrl: "https://example.com", dimensions: ["invalid"] })).toThrow();
    expect(() => searchAnalyticsInput.parse({ siteUrl: "https://example.com", startDate: "2026-99-01" })).toThrow();
  });

  it("rejects duplicate search analytics dimensions", () => {
    expect(() => searchAnalyticsInput.parse({
      siteUrl: "https://example.com",
      dimensions: ["query", "query"],
    })).toThrow("dimensions must be unique");
  });

  it("validates list_sitemaps", () => {
    expect(listSitemapsInput.parse({ siteUrl: "https://example.com" }).siteUrl).toBe("https://example.com/");
    expect(() => listSitemapsInput.parse({ siteUrl: "example.com" })).toThrow();
  });

  it("validates submit_sitemap", () => {
    expect(submitSitemapInput.parse({ siteUrl: "sc-domain:example.com", feedpath: "https://example.com/sitemap.xml" })).toBeTruthy();
    expect(() => submitSitemapInput.parse({ siteUrl: "https://example.com", feedpath: "not-a-url" })).toThrow();
  });

  it("validates inspect_url", () => {
    expect(inspectUrlInput.parse({ siteUrl: "https://example.com", inspectionUrl: "https://example.com/page" })).toBeTruthy();
    expect(() => inspectUrlInput.parse({ siteUrl: "https://example.com", inspectionUrl: "ftp://example.com" })).toThrow();
  });

  it("validates pagespeed defaults and categories", () => {
    const parsed = pageSpeedInput.parse({ url: "https://example.com" });
    expect(parsed.strategy).toBe("mobile");
    expect(parsed.category).toEqual(["performance", "seo", "accessibility", "best-practices"]);
    expect(() => pageSpeedInput.parse({ url: "file:///tmp/page", strategy: "tablet" })).toThrow();
  });

  it("rejects URLs with embedded credentials", () => {
    expect(pageSpeedInput.parse({ url: "https://example.com/" }).url).toBe("https://example.com/");
    expect(() => pageSpeedInput.parse({ url: "https://user:pass@example.com/" }))
      .toThrow("URL must not contain embedded credentials");
  });

  it("validates seo_audit", () => {
    expect(seoAuditInput.parse({ url: "https://example.com" }).url).toBe("https://example.com/");
    expect(() => seoAuditInput.parse({ url: "javascript:alert(1)" })).toThrow();
  });

  it("validates request_recrawl defaults", () => {
    const parsed = requestRecrawlInput.parse({ siteUrl: "sc-domain:example.com", sitemapUrl: "https://example.com/sitemap.xml" });
    expect(parsed).toMatchObject({ maxUrls: 20, concurrency: 3, dryRun: false });
    expect(() => requestRecrawlInput.parse({ siteUrl: "https://example.com", urls: [] })).toThrow();
  });

  it("validates indexnow_submit keys and defaults", () => {
    const parsed = indexNowSubmitInput.parse({ urls: ["https://example.com/a"], key: "a1b2c3d4e5f6" });
    expect(parsed).toMatchObject({ endpoint: "api.indexnow.org", dryRun: false });
    expect(() => indexNowSubmitInput.parse({ urls: ["https://example.com/a"], key: "short" }))
      .toThrow("8-128 characters");
  });

  it("validates keyword_ideas defaults and bounds", () => {
    const parsed = keywordIdeasInput.parse({ seed: "  SEO tools  ", siteUrl: "sc-domain:Example.COM" });
    expect(parsed).toMatchObject({
      seed: "SEO tools",
      siteUrl: "sc-domain:example.com",
      language: "en",
      expansions: ["alphabet", "questions", "prepositions", "comparisons"],
      days: 90,
      limit: 100,
    });
    expect(() => keywordIdeasInput.parse({ seed: " ", country: "usa" })).toThrow();
    expect(() => keywordIdeasInput.parse({ seed: "seo", days: 481, limit: 501 })).toThrow();
  });
});
