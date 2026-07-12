import { z } from "zod";
import { normalizeSiteUrl } from "./site-url.js";

const httpUrl = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "URL must use http or https" });
  }
  if (url.username || url.password) {
    context.addIssue({ code: "custom", message: "URL must not contain embedded credentials" });
  }
}).transform((value) => new URL(value).toString());

const siteUrl = z.string().min(1).transform((value, context) => {
  try {
    return normalizeSiteUrl(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid siteUrl" });
    return z.NEVER;
  }
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");

export const searchDimensions = ["query", "page", "country", "device", "date", "searchAppearance"] as const;
const filterOperator = z.enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"]);
const dimensionFilter = z.object({
  dimension: z.enum(searchDimensions),
  operator: filterOperator.default("equals"),
  expression: z.string().min(1),
});
const dimensionFilterGroup = z.object({
  groupType: z.enum(["and"]).default("and"),
  filters: z.array(dimensionFilter).min(1),
});

export const searchAnalyticsShape = {
  siteUrl: siteUrl.describe("Search Console property, such as https://example.com/ or sc-domain:example.com"),
  startDate: isoDate.optional().describe("Start date in YYYY-MM-DD; defaults to 28 days ago"),
  endDate: isoDate.optional().describe("End date in YYYY-MM-DD; defaults to today"),
  dimensions: z.array(z.enum(searchDimensions)).min(1)
    .refine((values) => new Set(values).size === values.length, "dimensions must be unique")
    .default(["query"]).describe("Dimensions used to group results"),
  rowLimit: z.number().int().min(1).max(25_000).default(25).describe("Maximum rows to return"),
  dimensionFilterGroups: z.array(dimensionFilterGroup).optional().describe("Search Console dimension filters"),
  type: z.enum(["web", "image", "video", "news"]).optional().describe("Search result type"),
  dataState: z.enum(["full", "all"]).optional().describe("full = finalized data (default, ~2-3 day lag); all = include recent partial data"),
  aggregationType: z.enum(["auto", "byProperty", "byPage"]).optional().describe("How Search Console aggregates rows"),
};
export const searchAnalyticsInput = z.object(searchAnalyticsShape);
export const searchAnalyticsOutput = z.object({
  siteUrl: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  dimensions: z.array(z.string()),
  rowCount: z.number(),
  rows: z.array(z.object({
    rank: z.number(),
    keys: z.record(z.string(), z.string()),
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number(),
    position: z.number(),
  })),
  firstIncompleteDate: z.string().optional(),
});

const sitemapOutput = z.object({
  path: z.string().nullable(),
  lastSubmitted: z.string().nullable(),
  lastDownloaded: z.string().nullable(),
  isPending: z.boolean(),
  isSitemapsIndex: z.boolean(),
  warnings: z.number(),
  errors: z.number(),
  contents: z.array(z.object({
    type: z.string().nullable(),
    submitted: z.number(),
    indexed: z.number(),
  })),
});

export const listSitemapsShape = {
  siteUrl: siteUrl.describe("Search Console property"),
};
export const listSitemapsInput = z.object(listSitemapsShape);
export const listSitemapsOutput = z.object({
  siteUrl: z.string(),
  count: z.number(),
  sitemaps: z.array(sitemapOutput),
});

export const submitSitemapShape = {
  siteUrl: siteUrl.describe("Search Console property"),
  feedpath: httpUrl.describe("Absolute URL of the sitemap to submit"),
};
export const submitSitemapInput = z.object(submitSitemapShape);
export const submitSitemapOutput = z.object({
  success: z.boolean(),
  siteUrl: z.string(),
  feedpath: z.string(),
  dryRun: z.boolean().optional(),
  sitemap: sitemapOutput.nullable(),
  stateRefreshError: z.string().nullable(),
});

export const inspectUrlShape = {
  siteUrl: siteUrl.describe("Search Console property containing the inspected URL"),
  inspectionUrl: httpUrl.describe("Fully qualified URL to inspect"),
};
export const inspectUrlInput = z.object(inspectUrlShape);
export const inspectUrlOutput = z.object({
  siteUrl: z.string(),
  inspectionUrl: z.string(),
  indexStatus: z.object({
    coverageState: z.string().nullable(),
    verdict: z.string().nullable(),
    robotsTxtState: z.string().nullable(),
    indexingState: z.string().nullable(),
    lastCrawlTime: z.string().nullable(),
    googleCanonical: z.string().nullable(),
    userCanonical: z.string().nullable(),
    pageFetchState: z.string().nullable(),
  }),
  mobileUsability: z.object({
    verdict: z.string().nullable(),
    issues: z.array(z.record(z.string(), z.unknown())),
  }).nullable(),
  richResults: z.object({
    verdict: z.string().nullable(),
    detectedItems: z.array(z.record(z.string(), z.unknown())),
  }).nullable(),
});

export const pageSpeedCategories = ["performance", "seo", "accessibility", "best-practices"] as const;
export const pageSpeedShape = {
  url: httpUrl.describe("Public page URL to analyze"),
  strategy: z.enum(["mobile", "desktop"]).default("mobile").describe("Lighthouse device strategy"),
  category: z.array(z.enum(pageSpeedCategories)).min(1).default([...pageSpeedCategories]).describe("Lighthouse categories to run"),
  apiKey: z.string().min(1).optional().describe("Optional PageSpeed Insights API key; defaults to SEO_MCP_PAGESPEED_KEY"),
};
export const pageSpeedInput = z.object(pageSpeedShape);
export const pageSpeedOutput = z.object({
  url: z.string(),
  strategy: z.string(),
  fieldData: z.record(z.string(), z.object({
    value: z.number().nullable(),
    category: z.string().nullable(),
  })),
  scores: z.record(z.string(), z.number().nullable()),
  opportunities: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    savingsMs: z.number(),
  })),
});

export const seoAuditShape = {
  url: httpUrl.describe("Public page URL to audit"),
};
export const seoAuditInput = z.object(seoAuditShape);
export const seoAuditOutput = z.object({
  url: z.string(),
  title: z.object({ text: z.string().nullable(), count: z.number(), length: z.number() }),
  metaDescription: z.object({ text: z.string().nullable(), length: z.number() }),
  canonical: z.string().nullable(),
  metaRobots: z.string().nullable(),
  h1: z.object({ count: z.number(), texts: z.array(z.string()) }),
  headingOutline: z.array(z.object({ level: z.number(), text: z.string() })),
  openGraph: z.record(z.string(), z.string()),
  twitter: z.record(z.string(), z.string()),
  schemaTypes: z.array(z.string()),
  images: z.object({ count: z.number(), withAlt: z.number(), altPercentage: z.number() }),
  links: z.object({ internal: z.number(), external: z.number() }),
  wordCount: z.number(),
  lang: z.string().nullable(),
  viewport: z.string().nullable(),
  issues: z.array(z.string()),
  httpStatus: z.number(),
});
