import { describe, expect, it } from "vitest";
import {
  inspectUrlInput,
  listSitemapsInput,
  pageSpeedInput,
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

  it("rejects invalid search analytics inputs", () => {
    expect(() => searchAnalyticsInput.parse({ siteUrl: "example.com", rowLimit: 25001 })).toThrow();
    expect(() => searchAnalyticsInput.parse({ siteUrl: "https://example.com", dimensions: ["invalid"] })).toThrow();
    expect(() => searchAnalyticsInput.parse({ siteUrl: "https://example.com", startDate: "2026-99-01" })).toThrow();
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

  it("validates seo_audit", () => {
    expect(seoAuditInput.parse({ url: "https://example.com" }).url).toBe("https://example.com/");
    expect(() => seoAuditInput.parse({ url: "javascript:alert(1)" })).toThrow();
  });
});
