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
  maxTableRows: z.number().int().min(0).max(25_000).default(25).describe("Cap rows shown in the text table; structured rows are always complete. 0 = summary only."),
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

const analysisWindowShape = {
  siteUrl: siteUrl.describe("Search Console property to analyze"),
  startDate: isoDate.optional().describe("Start date in YYYY-MM-DD; defaults to the latest 28-day window"),
  endDate: isoDate.optional().describe("End date in YYYY-MM-DD; defaults to today"),
};
const windowOutput = z.object({
  startDate: z.string().describe("Inclusive window start date"),
  endDate: z.string().describe("Inclusive window end date"),
});
const insightKeys = z.array(z.string()).describe("Dimension values in request order");

export const searchOpportunitiesShape = {
  ...analysisWindowShape,
  minPosition: z.number().min(0).optional().describe("Lowest average position to include; defaults to 5"),
  maxPosition: z.number().min(0).optional().describe("Highest average position to include; defaults to 20"),
  minImpressions: z.number().min(0).optional().describe("Minimum impressions required; defaults to 10"),
  limit: z.number().int().min(1).max(5000).optional().describe("Maximum opportunities to return; defaults to 50"),
};
export const searchOpportunitiesInput = z.object(searchOpportunitiesShape);
export const searchOpportunitiesOutput = z.object({
  siteUrl: z.string().describe("Search Console property analyzed"),
  window: windowOutput.describe("Analysis window"),
  opportunities: z.array(z.object({
    keys: insightKeys,
    impressions: z.number().describe("Search impressions"),
    clicks: z.number().describe("Search clicks"),
    ctr: z.number().describe("Click-through rate as a fraction"),
    position: z.number().describe("Average search position"),
    opportunity: z.number().describe("Opportunity score based on impressions and position"),
  })).describe("Highest-value striking-distance rows"),
});

export const compareSearchPeriodsShape = {
  ...analysisWindowShape,
  by: z.enum(["query", "page"]).default("query").describe("Dimension used to compare performance"),
  limit: z.number().int().min(1).max(5000).optional().describe("Maximum gainers and losers to return; defaults to 50 each"),
};
export const compareSearchPeriodsInput = z.object(compareSearchPeriodsShape);
const compareItemOutput = z.object({
  keys: insightKeys,
  clicksCurrent: z.number().describe("Clicks in the current window"),
  clicksPrevious: z.number().describe("Clicks in the previous window"),
  clicksDelta: z.number().describe("Current clicks minus previous clicks"),
  impressionsDelta: z.number().describe("Current impressions minus previous impressions"),
  positionDelta: z.number().describe("Current average position minus previous average position"),
});
export const compareSearchPeriodsOutput = z.object({
  siteUrl: z.string().describe("Search Console property analyzed"),
  currentWindow: windowOutput.describe("Current comparison window"),
  previousWindow: windowOutput.describe("Immediately preceding equal-length window"),
  gainers: z.array(compareItemOutput).describe("Rows with increased clicks"),
  losers: z.array(compareItemOutput).describe("Rows with decreased clicks"),
});

export const ctrGapsShape = {
  ...analysisWindowShape,
  by: z.enum(["query", "page"]).default("query").describe("Dimension used to identify CTR gaps"),
  minImpressions: z.number().min(0).optional().describe("Minimum impressions required; defaults to 100"),
  limit: z.number().int().min(1).max(5000).optional().describe("Maximum gaps to return; defaults to 50"),
};
export const ctrGapsInput = z.object(ctrGapsShape);
export const ctrGapsOutput = z.object({
  siteUrl: z.string().describe("Search Console property analyzed"),
  window: windowOutput.describe("Analysis window"),
  gaps: z.array(z.object({
    keys: insightKeys,
    impressions: z.number().describe("Search impressions"),
    ctr: z.number().describe("Actual click-through rate as a fraction"),
    expectedCtr: z.number().describe("Peer average click-through rate at the rounded position"),
    position: z.number().describe("Average search position"),
    missedClicks: z.number().describe("Estimated clicks missed versus peer CTR"),
  })).describe("Rows underperforming their position peers"),
});

export const queryCannibalizationShape = {
  ...analysisWindowShape,
  minImpressions: z.number().min(0).optional().describe("Minimum impressions per query-page row; defaults to 10"),
};
export const queryCannibalizationInput = z.object(queryCannibalizationShape);
export const queryCannibalizationOutput = z.object({
  siteUrl: z.string().describe("Search Console property analyzed"),
  window: windowOutput.describe("Analysis window"),
  groups: z.array(z.object({
    query: z.string().describe("Query served by multiple pages"),
    pages: z.array(z.object({
      page: z.string().describe("Competing page URL"),
      impressions: z.number().describe("Search impressions"),
      clicks: z.number().describe("Search clicks"),
      position: z.number().describe("Average search position"),
    })).describe("Pages ranking for the query"),
  })).describe("Queries with multiple ranking pages"),
});

export const listPropertiesShape = {};
export const listPropertiesOutput = z.object({
  count: z.number(),
  properties: z.array(z.object({
    siteUrl: z.string().nullable(),
    permissionLevel: z.string().nullable(),
  })),
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
  dryRun: z.boolean().default(false).describe("If true, report what would be submitted without writing to Search Console"),
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

export const auditSiteShape = {
  sitemapUrl: httpUrl.describe("Public sitemap URL to audit"),
  maxPages: z.number().int().min(1).max(50).default(20).describe("Maximum pages to audit"),
  concurrency: z.number().int().min(1).max(10).default(5).describe("Maximum page fetches in flight"),
};
export const auditSiteInput = z.object(auditSiteShape);
export const auditSiteOutput = z.object({
  sitemapUrl: z.string(),
  totalDiscovered: z.number(),
  audited: z.number(),
  failed: z.number(),
  truncated: z.boolean(),
  skipped: z.number(),
  childSitemapsSkipped: z.number(),
  childSitemapsFailed: z.number(),
  pages: z.array(z.object({
    url: z.string(),
    issues: z.array(z.string()).optional(),
    title: z.string().nullable().optional(),
    metaDescription: z.string().nullable().optional(),
    h1: z.array(z.string()).optional(),
    error: z.string().optional(),
  })),
  rollup: z.record(z.string(), z.number()),
});
