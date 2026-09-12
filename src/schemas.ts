import { z } from "zod";
import { normalizeSiteUrl } from "./site-url.js";

const httpUrl = z
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "URL must use http or https" });
    }
    if (url.username || url.password) {
      context.addIssue({ code: "custom", message: "URL must not contain embedded credentials" });
    }
  })
  .transform((value) => new URL(value).toString());

const siteUrl = z
  .string()
  .min(1)
  .transform((value, context) => {
    try {
      return normalizeSiteUrl(value);
    } catch (error) {
      context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid siteUrl" });
      return z.NEVER;
    }
  });

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }, "Invalid calendar date");

// Android package names are dotted Java identifiers. Anything else would be
// spliced into a URL path on an authenticated host.
const androidPackageName = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/, "packageName must be an Android package name such as com.example.app")
  .max(200);

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
  dimensions: z
    .array(z.enum(searchDimensions))
    .min(1)
    .refine((values) => new Set(values).size === values.length, "dimensions must be unique")
    .default(["query"])
    .describe("Dimensions used to group results"),
  rowLimit: z.number().int().min(1).max(25_000).default(25).describe("Maximum rows to return"),
  startRow: z.number().int().min(0).default(0).describe("Zero-based row to start from, for paging through a large result"),
  maxTableRows: z.number().int().min(0).max(25_000).default(25).describe("Cap rows shown in the text table; structured rows are always complete. 0 = summary only."),
  dimensionFilterGroups: z.array(dimensionFilterGroup).optional().describe("Search Console dimension filters"),
  type: z
    .enum(["web", "image", "video", "news", "discover", "googleNews"])
    .optional()
    .describe(
      "Result type. discover is the Discover feed and googleNews is the Google News app and news.google.com, not the News tab in Search. Both support fewer dimensions than web: neither reports a query dimension",
    ),
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
  startRow: z.number(),
  truncated: z.boolean().describe("More rows follow this page. False does not mean the result is complete: Search Console returns top rows subject to its own internal limits"),
  rows: z.array(
    z.object({
      rank: z.number(),
      keys: z.record(z.string(), z.string()),
      clicks: z.number(),
      impressions: z.number(),
      ctr: z.number(),
      position: z.number(),
    }),
  ),
  firstIncompleteDate: z.string().optional(),
});

export const keywordIdeaExpansions = ["alphabet", "questions", "prepositions", "comparisons"] as const;
export const keywordIdeaFamilies = ["seed", ...keywordIdeaExpansions] as const;
export const keywordIdeasShape = {
  seed: z.string().trim().min(1).max(100).describe("Seed keyword to expand"),
  siteUrl: siteUrl.optional().describe("Optional Search Console property used to identify queries already ranking"),
  language: z.string().default("en").describe("Autocomplete interface language passed as hl"),
  country: z
    .string()
    .regex(/^[a-z]{2}$/, "country must be a 2-letter lowercase code")
    .optional()
    .describe("Autocomplete country passed as gl"),
  expansions: z
    .array(z.enum(keywordIdeaExpansions))
    .default([...keywordIdeaExpansions])
    .describe("Suggestion expansion families to run beyond the bare seed"),
  days: z.number().int().min(1).max(480).default(90).describe("Search Console lookback window in days"),
  limit: z.number().int().min(1).max(500).default(100).describe("Maximum keyword ideas to return"),
};
export const keywordIdeasInput = z.object(keywordIdeasShape);
export const keywordIdeasOutput = z.object({
  seed: z.string(),
  totalFound: z.number(),
  returned: z.number(),
  requestFailures: z.number(),
  gscMatched: z.number(),
  crossReferenced: z.boolean(),
  ideas: z.array(
    z.object({
      keyword: z.string(),
      family: z.enum(keywordIdeaFamilies),
      gsc: z
        .object({
          position: z.number(),
          clicks: z.number(),
          impressions: z.number(),
        })
        .nullable(),
    }),
  ),
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
  truncated: z.boolean().describe("Whether Search Console held more than 5000 rows for this window, so the list was computed from the top rows only"),
  opportunities: z
    .array(
      z.object({
        keys: insightKeys,
        impressions: z.number().describe("Search impressions"),
        clicks: z.number().describe("Search clicks"),
        ctr: z.number().describe("Click-through rate as a fraction"),
        position: z.number().describe("Average search position"),
        opportunity: z.number().describe("Opportunity score based on impressions and position"),
      }),
    )
    .describe("Highest-value striking-distance rows"),
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
  currentTruncated: z.boolean().describe("Whether Search Console held more than 5000 rows for the current window"),
  previousTruncated: z.boolean().describe("Whether Search Console held more than 5000 rows for the previous window"),
  droppedAsUnknown: z.number().describe("Rows present on only one side whose other side was cut off, and so were excluded rather than counted as zero"),
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
  truncated: z.boolean().describe("Whether Search Console held more than 5000 rows for this window, so the list was computed from the top rows only"),
  gaps: z
    .array(
      z.object({
        keys: insightKeys,
        impressions: z.number().describe("Search impressions"),
        ctr: z.number().describe("Actual click-through rate as a fraction"),
        expectedCtr: z.number().describe("Peer average click-through rate at the rounded position"),
        position: z.number().describe("Average search position"),
        missedClicks: z.number().describe("Estimated clicks missed versus peer CTR"),
      }),
    )
    .describe("Rows underperforming their position peers"),
});

export const queryCannibalizationShape = {
  ...analysisWindowShape,
  minImpressions: z.number().min(0).optional().describe("Minimum impressions per query-page row; defaults to 10"),
};
export const queryCannibalizationInput = z.object(queryCannibalizationShape);
export const queryCannibalizationOutput = z.object({
  siteUrl: z.string().describe("Search Console property analyzed"),
  window: windowOutput.describe("Analysis window"),
  truncated: z.boolean().describe("Whether Search Console held more than 5000 rows for this window, so the list was computed from the top rows only"),
  groups: z
    .array(
      z.object({
        query: z.string().describe("Query served by multiple pages"),
        pages: z
          .array(
            z.object({
              page: z.string().describe("Competing page URL"),
              impressions: z.number().describe("Search impressions"),
              clicks: z.number().describe("Search clicks"),
              position: z.number().describe("Average search position"),
            }),
          )
          .describe("Pages ranking for the query"),
      }),
    )
    .describe("Queries with multiple ranking pages"),
});

export const listPropertiesShape = {};
export const listPropertiesOutput = z.object({
  count: z.number(),
  properties: z.array(
    z.object({
      siteUrl: z.string().nullable(),
      permissionLevel: z.string().nullable(),
    }),
  ),
});

const sitemapOutput = z.object({
  path: z.string().nullable(),
  lastSubmitted: z.string().nullable(),
  lastDownloaded: z.string().nullable(),
  isPending: z.boolean().nullable().describe("Null when Google did not report it, which is not the same as known to be processed"),
  isSitemapsIndex: z.boolean(),
  warnings: z.number().nullable().describe("Null while the sitemap is pending. Zero warnings beside zero errors reads as parsed and clean, which an unprocessed sitemap is not"),
  errors: z.number().nullable(),
  contents: z.array(
    z.object({
      type: z.string().nullable(),
      submitted: z.number(),
      indexed: z.number(),
    }),
  ),
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

export const deleteSitemapShape = {
  siteUrl: siteUrl.describe("Search Console property"),
  feedpath: httpUrl.describe("Absolute URL of the sitemap to remove"),
  dryRun: z.boolean().default(false).describe("If true, report what would be removed without writing to Search Console"),
};
export const deleteSitemapInput = z.object(deleteSitemapShape);
export const deleteSitemapOutput = z.object({
  success: z.boolean(),
  dryRun: z.boolean().optional(),
  siteUrl: z.string(),
  feedpath: z.string(),
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
  mobileUsability: z
    .object({
      verdict: z.string().nullable(),
      issues: z.array(z.record(z.string(), z.unknown())),
    })
    .nullable(),
  richResults: z
    .object({
      verdict: z.string().nullable(),
      detectedItems: z.array(z.record(z.string(), z.unknown())),
    })
    .nullable(),
});

export const indexCoverageShape = {
  siteUrl: siteUrl.describe("Search Console property containing the sitemap URLs"),
  sitemapUrl: httpUrl.describe("Fully qualified sitemap URL to inspect"),
  maxUrls: z.number().int().min(1).max(50).default(20).describe("Maximum URLs to inspect"),
  concurrency: z.number().int().min(1).max(5).default(3).describe("Concurrent URL Inspection requests"),
};
export const indexCoverageInput = z.object(indexCoverageShape);
const indexCoverageResult = z.object({
  url: z.string(),
  coverageState: z.string().nullable(),
  verdict: z.string().nullable(),
  indexed: z.boolean(),
  lastCrawlTime: z.string().nullable(),
  error: z.string().nullable(),
});
export const indexCoverageOutput = z.object({
  siteUrl: z.string(),
  sitemapUrl: z.string(),
  totalDiscovered: z.number(),
  checked: z.number(),
  indexed: z.number(),
  notIndexed: z.array(z.object({ url: z.string(), coverageState: z.string().nullable() })),
  failed: z.number(),
  truncated: z.boolean(),
  childSitemapsSkipped: z.number(),
  results: z.array(indexCoverageResult),
});

export const requestRecrawlShape = {
  siteUrl: siteUrl.describe("Search Console property containing the URLs"),
  urls: z.array(httpUrl).min(1).max(50).optional().describe("Explicit URLs to check; omit to read them from sitemapUrl"),
  sitemapUrl: httpUrl.optional().describe("Sitemap to read URLs from; also the default sitemap to resubmit"),
  feedpath: httpUrl.optional().describe("Sitemap to resubmit when unindexed URLs are found; defaults to sitemapUrl"),
  maxUrls: z.number().int().min(1).max(50).default(20).describe("Maximum sitemap URLs to inspect"),
  concurrency: z.number().int().min(1).max(5).default(3).describe("Concurrent URL Inspection requests"),
  dryRun: z.boolean().default(false).describe("If true, inspect and report without resubmitting the sitemap"),
};
export const requestRecrawlInput = z.object(requestRecrawlShape);
export const requestRecrawlOutput = z.object({
  siteUrl: z.string(),
  checked: z.number(),
  indexed: z.number(),
  notIndexed: z.array(z.object({ url: z.string(), coverageState: z.string().nullable() })),
  failed: z.number(),
  totalDiscovered: z.number(),
  truncated: z.boolean(),
  resubmit: z.object({
    performed: z.boolean(),
    feedpath: z.string().nullable(),
    reason: z.string(),
  }),
  dryRun: z.boolean().optional(),
  results: z.array(indexCoverageResult),
});

export const indexNowEndpoints = ["api.indexnow.org", "www.bing.com", "yandex.com", "searchadvisor.naver.com", "search.seznam.cz", "indexnow.yep.com"] as const;
export const indexNowSubmitShape = {
  urls: z.array(httpUrl).min(1).max(10_000).describe("Changed page URLs; one submission covers one host"),
  key: z
    .string()
    .regex(/^[A-Za-z0-9-]{8,128}$/, "IndexNow keys are 8-128 characters of a-z, A-Z, 0-9, or dash")
    .optional()
    .describe("IndexNow key; defaults to SEO_MCP_INDEXNOW_KEY. The same key must be hosted on the site as a text file at https://<host>/<key>.txt (or at keyLocation) containing only the key"),
  keyLocation: httpUrl.optional().describe("URL of the hosted key file when it is not https://<host>/<key>.txt"),
  endpoint: z.enum(indexNowEndpoints).default("api.indexnow.org").describe("IndexNow endpoint to notify; participating engines share submissions"),
  dryRun: z.boolean().default(false).describe("If true, report what would be submitted without notifying the endpoint"),
};
export const indexNowSubmitInput = z.object(indexNowSubmitShape);
export const indexNowSubmitOutput = z.object({
  success: z.boolean(),
  dryRun: z.boolean().optional(),
  endpoint: z.string(),
  host: z.string(),
  urlCount: z.number(),
  statusCode: z.number().nullable(),
  note: z.string(),
});

export const pageSpeedCategories = ["performance", "seo", "accessibility", "best-practices"] as const;
export const pageSpeedShape = {
  url: httpUrl.describe("Public page URL to analyze"),
  strategy: z.enum(["mobile", "desktop"]).default("mobile").describe("Lighthouse device strategy"),
  category: z
    .array(z.enum(pageSpeedCategories))
    .min(1)
    .default([...pageSpeedCategories])
    .describe("Lighthouse categories to run"),
  apiKey: z.string().min(1).optional().describe("Optional PageSpeed Insights API key; defaults to SEO_MCP_PAGESPEED_KEY"),
};
export const pageSpeedInput = z.object(pageSpeedShape);
export const pageSpeedOutput = z.object({
  url: z.string(),
  strategy: z.string(),
  fieldData: z.record(
    z.string(),
    z.object({
      value: z.number().nullable(),
      category: z.string().nullable(),
    }),
  ),
  scores: z.record(z.string(), z.number().nullable()),
  opportunities: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      savingsMs: z.number(),
    }),
  ),
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
  pages: z.array(
    z.object({
      url: z.string(),
      issues: z.array(z.string()).optional(),
      title: z.string().nullable().optional(),
      metaDescription: z.string().nullable().optional(),
      h1: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
  ),
  rollup: z.record(z.string(), z.number()),
});

export const serverVersionShape = {};
export const serverVersionInput = z.object(serverVersionShape);
export const serverVersionOutput = z.object({
  name: z.string(),
  version: z
    .string()
    .describe("The version of the build answering this call, which is not necessarily what npm calls latest, what the version range resolves to, or what the plugin manifest declares"),
  nodeVersion: z.string(),
  installPath: z.string().describe("Where this build is running from. An npx cache path is what distinguishes the release you expected from whatever npx already had"),
  npxCache: z.boolean().describe("Whether this build is being served out of an npx cache, which reuses a build without re-resolving the version range and without erroring"),
});

export const wporgPluginShape = {
  slug: z.string().trim().min(1).max(200).describe("WordPress.org plugin slug, e.g. akismet"),
  downloadDays: z.number().int().min(0).max(365).default(30).describe("Days of daily download history to fetch; 0 skips it"),
  includeVersionDistribution: z.boolean().default(true).describe("Also fetch the share of active installs on each plugin version"),
};
export const wporgPluginInput = z.object(wporgPluginShape);
export const wporgPluginOutput = z.object({
  slug: z.string(),
  name: z.string().nullable(),
  version: z.string().nullable(),
  activeInstalls: z.number().nullable(),
  downloaded: z.number().nullable(),
  numRatings: z.number().nullable(),
  rating: z.number().nullable(),
  supportThreads: z.number().nullable(),
  supportThreadsResolved: z.number().nullable(),
  tested: z.string().nullable(),
  added: z.string().nullable(),
  lastUpdated: z.string().nullable(),
  requires: z.string().nullable(),
  requiresPhp: z.string().nullable(),
  downloadLink: z.string().nullable(),
  versionCount: z.number().nullable(),
  activeInstallsIsBucketed: z.boolean(),
  ratings: z.record(z.string(), z.number()).nullable(),
  dailyDownloads: z.array(z.object({ date: z.string(), downloads: z.number() })).nullable(),
  downloadSummary: z.record(z.string(), z.number()).nullable(),
  versionDistribution: z.array(z.object({ version: z.string(), percentage: z.number() })).nullable(),
  tags: z.array(z.string()),
  possiblyLagging: z.boolean(),
  notes: z.array(z.string()),
});

const playDimensionReport = z
  .object({
    dimension: z.string(),
    lastDate: z.string().nullable(),
    rows: z.array(
      z.object({
        value: z.string(),
        latest: z.record(z.string(), z.union([z.number(), z.string()])),
        totals: z.record(z.string(), z.number()),
      }),
    ),
  })
  .nullable();

export const playStoreStatsShape = {
  packageName: androidPackageName.describe("Android package name, e.g. app.getpsst"),
  month: z
    .string()
    .regex(/^\d{6}$/, "month must be YYYYMM")
    .optional()
    .describe("Report month as YYYYMM; defaults to the current UTC month. Ignored when startDate and endDate are given"),
  installsDimension: z
    .enum(["overview", "country", "language", "device", "os_version", "carrier", "app_version"])
    .default("overview")
    .describe("Which installs report to read. overview is undocumented by Google but present in real buckets; the others are the documented breakdowns"),
  include: z
    .array(z.enum(["ratings", "crashes", "reviews"]))
    .default([])
    .describe("Extra report families to read. Missing files are normal: Google emits a report only when there is something to report"),
  storePerformanceDimension: z.enum(["traffic_source", "country"]).default("traffic_source").describe("Which store performance breakdown to read"),
  storePerformanceTotals: z
    .boolean()
    .default(false)
    .describe(
      "Read the total_ variant instead. It is a different report, not a rollup of the same one: it carries acquisitions only, with no visitors and no conversion rate, and for some apps it covers far fewer dates and attributes every acquisition to a placeholder source",
    ),
  ratingsDimension: z.enum(["country", "language", "device", "os_version", "carrier", "app_version"]).default("country").describe("Dimension for the ratings report"),
  crashesDimension: z.enum(["device", "os_version", "app_version"]).default("app_version").describe("Dimension for the crashes report"),
  startDate: isoDate.optional().describe("Window start in YYYY-MM-DD. With endDate, reads every month the window touches and filters rows to it"),
  endDate: isoDate.optional().describe("Window end in YYYY-MM-DD"),
};
export const playStoreStatsInput = z.object(playStoreStatsShape);
export const playStoreStatsOutput = z.object({
  packageName: z.string(),
  month: z.string(),
  lastDatePresent: z.string().nullable(),
  activeDeviceInstalls: z.number().nullable(),
  trafficSources: z.array(
    z.object({
      source: z.string(),
      searchTerm: z.string().nullable(),
      utmSource: z.string().nullable(),
      utmCampaign: z.string().nullable(),
      visitors: z.number().nullable(),
      acquisitions: z.number().nullable(),
      conversionRate: z.number().nullable(),
    }),
  ),
  hasPlaySearchRows: z.boolean(),
  window: z.object({ startDate: z.string(), endDate: z.string() }).nullable(),
  monthsRead: z.array(z.string()),
  datesPresent: z.array(z.string()),
  installsLatest: z.record(z.string(), z.union([z.number(), z.string()])).nullable(),
  installsWindowTotals: z.record(z.string(), z.number()),
  installsZeroThroughout: z.array(z.string()),
  installsDimension: z.string(),
  storePerformanceDimension: z.string(),
  storePerformanceTotals: z.boolean(),
  ratings: playDimensionReport,
  crashes: playDimensionReport,
  reviews: z.array(z.record(z.string(), z.string())).nullable(),
  notes: z.array(z.string()),
});

const listingField = z.object({
  text: z.string().nullable(),
  length: z.number(),
  limit: z.number(),
  overLimit: z.boolean(),
});
export const appStoreListingShape = {
  appId: z.string().regex(/^\d+$/, "appId must be the numeric App Store app id").optional().describe("App Store Connect numeric app id; provide this or bundleId"),
  bundleId: z.string().trim().min(1).max(200).optional().describe("Bundle id, resolved to an app id when appId is not given; provide this or appId"),
  platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS").describe("App Store platform whose version is read"),
  state: z.enum(["live", "editable"]).default("live").describe("Read the live listing or the editable one being prepared for release"),
  storefronts: z
    .array(z.string().regex(/^[a-z]{2}$/, "storefronts must be 2-letter lowercase country codes"))
    .min(1)
    .max(10)
    .default(["us"])
    .describe("Storefront country codes for the public ratings lookup"),
};
export const appStoreListingInput = z.object(appStoreListingShape);
export const appStoreListingOutput = z.object({
  appId: z.string(),
  bundleId: z.string().nullable(),
  platform: z.string(),
  requestedState: z.string(),
  fellBack: z.boolean(),
  hasLiveRecord: z.boolean(),
  hasEditableRecord: z.boolean(),
  appInfoState: z.string().nullable(),
  categories: z.object({ primary: z.string().nullable(), secondary: z.string().nullable() }),
  ageRating: z.record(z.string(), z.unknown()).nullable(),
  phasedRelease: z.record(z.string(), z.unknown()).nullable(),
  versionState: z.string().nullable(),
  versionString: z.string().nullable(),
  localeCount: z.number(),
  locales: z.array(
    z.object({
      locale: z.string(),
      indexed: z.object({ name: listingField, subtitle: listingField, keywords: listingField }),
      promotionalText: listingField,
      description: listingField,
      whatsNew: listingField,
      screenshotSets: z.array(z.string()),
      previewSets: z.array(z.string()),
      partial: z.boolean(),
    }),
  ),
  ratings: z.array(
    z.object({
      storefront: z.string(),
      source: z.string(),
      averageUserRating: z.number().nullable(),
      userRatingCount: z.number().nullable(),
    }),
  ),
  overLimit: z.array(z.string()),
  notes: z.array(z.string()),
});

const adsWindow = z.number().int().min(1).max(365).default(30).describe("How many days back to report, ending today");

export const adsCampaignsShape = { days: adsWindow };
export const adsCampaignsInput = z.object(adsCampaignsShape);
export const adsCampaignsOutput = z.object({
  days: z.number(),
  rowCount: z.number(),
  campaigns: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      dailyBudget: z.number().nullable().describe("Null when Google returned no amount, which is not a budget of zero"),
      impressions: z.number(),
      clicks: z.number(),
      cost: z.number(),
      conversions: z.number(),
    }),
  ),
  notes: z.array(z.string()),
});

export const adsKeywordsShape = {
  days: adsWindow,
  status: z
    .enum(["ENABLED", "PAUSED", "REMOVED"])
    .optional()
    .describe(
      "Limit to one keyword state. Omitted, every keyword is returned with its state named, because dropping rows silently is how a count taken from this tool goes wrong the way a console count does",
    ),
};
export const adsKeywordsInput = z.object(adsKeywordsShape);
export const adsKeywordsOutput = z.object({
  days: z.number(),
  rowCount: z.number(),
  keywords: z.array(
    z.object({
      keyword: z.string(),
      adGroup: z.string(),
      bid: z.number().nullable().describe("Null when Google returned no amount. A keyword under an automated bidding strategy has no CPC bid to read, which is not a bid of zero"),
      status: z.string().describe("ENABLED, PAUSED or REMOVED. This is whether the keyword is turned on, which servingStatus does not tell you: a paused keyword still reports ELIGIBLE"),
      approvalStatus: z.string(),
      servingStatus: z.string().describe("Google's system serving status. ELIGIBLE means approved and capable of serving, not currently serving; a paused keyword reads ELIGIBLE"),
      impressions: z.number(),
      clicks: z.number(),
      cost: z.number(),
    }),
  ),
  notes: z.array(z.string()),
});

export const adsAdsShape = { days: adsWindow };
export const adsAdsInput = z.object(adsAdsShape);
export const adsAdsOutput = z.object({
  days: z.number(),
  rowCount: z.number(),
  ads: z.array(
    z.object({
      adId: z.string(),
      adGroup: z.string(),
      status: z.string(),
      adStrength: z.string(),
      approvalStatus: z.string(),
      impressions: z.number(),
      clicks: z.number(),
    }),
  ),
  notes: z.array(z.string()),
});

export const adsAdCopyShape = {
  adGroup: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .optional()
    .describe("Limit to one ad group by name. Omitted, every ad in the account is read, which is what answers whether a headline is repeated across ad groups"),
  adId: z.string().trim().regex(/^\d+$/, "adId is the numeric ad id").max(40).optional().describe("Limit to one ad by its numeric id, for reading back the copy that was supposed to ship"),
  includeRemoved: z.boolean().default(false).describe("Include removed ads. Off by default: a removed ad's copy is history, and it crowds out the ads that are serving"),
};
export const adsAdCopyInput = z.object(adsAdCopyShape);

const adTextAsset = z.object({
  text: z.string(),
  pinned: z
    .string()
    .nullable()
    .describe(
      "The position this asset is pinned to, or null when Google is free to place it. Pinning cuts the combinations Google can build, which is a common reason strength is rated lower than the copy deserves",
    ),
  performance: z.string().nullable().describe("Google's own label for the asset, when it has served enough to have one"),
});

export const adsAdCopyOutput = z.object({
  rowCount: z.number(),
  ads: z.array(
    z.object({
      adId: z.string(),
      adGroup: z.string(),
      campaign: z.string(),
      type: z
        .string()
        .describe(
          "The ad type as Google names it. Only a responsive search ad carries headlines and descriptions in this shape; anything else is reported with its type and empty copy rather than as an ad with no text",
        ),
      status: z.string(),
      adStrength: z.string(),
      approvalStatus: z.string(),
      headlines: z.array(adTextAsset),
      descriptions: z.array(adTextAsset),
      paths: z.array(z.string()).describe("The display-URL path segments, which are part of what the reader sees and are not in the headlines"),
      finalUrls: z.array(z.string()),
      policyTopics: z
        .array(z.object({ topic: z.string(), type: z.string() }))
        .describe("Why approval is limited or refused, named. The approval status word alone says something is wrong without saying what"),
      observations: z
        .array(z.string())
        .describe("What is true of this ad's copy that bears on its strength: how many headlines and descriptions it has, how many are pinned, and text repeated inside the ad"),
    }),
  ),
  duplicateHeadlines: z
    .array(z.object({ text: z.string(), ads: z.array(z.string()), adGroups: z.array(z.string()) }))
    .describe("Headline text appearing in more than one ad, with the ads carrying it. Two ads in one ad group sharing headlines test nothing against each other"),
  notes: z.array(z.string()),
});

export const adsAssetTypes = ["SITELINK", "CALLOUT", "STRUCTURED_SNIPPET", "PROMOTION", "PRICE", "CALL", "IMAGE"] as const;
export const adsAssetsShape = {
  campaign: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .optional()
    .describe("Limit campaign and ad group assets to one campaign by name. Account-level assets are still listed, because they apply to every campaign including this one"),
  type: z.enum(adsAssetTypes).optional().describe("Limit to one asset type. Omitted, every type is listed, including types this tool has no shaped reading for"),
  includeRemoved: z.boolean().default(false).describe("Include links whose status is removed. Off by default: a removed asset is history and crowds out the ones that can serve"),
};
export const adsAssetsInput = z.object(adsAssetsShape);
export const adsAssetsOutput = z.object({
  rowCount: z.number(),
  assets: z.array(
    z.object({
      assetId: z.string(),
      type: z.string(),
      level: z
        .enum(["account", "campaign", "adGroup"])
        .describe("Where the asset is attached. An account-level asset applies to every campaign, so it can serve beside an ad that has none of its own"),
      attachedTo: z.string().describe("The campaign or ad group it is attached to, or the account itself"),
      fieldType: z.string().describe("The slot Google files it under, which is not always the same word as the asset type"),
      status: z.string(),
      summary: z.string().describe("What the asset actually says, in one line. A type and an id do not answer whether the promotion is the right promotion"),
    }),
  ),
  byType: z.record(z.string(), z.number()).describe("How many of each type were found, so an absent type is visible as absent"),
  levelErrors: z
    .array(z.object({ level: z.string(), error: z.string() }))
    .describe("A level that could not be read is recorded here rather than omitted, so an empty list is never mistaken for nothing attached"),
  notes: z.array(z.string()),
});

export const adsQueryShape = {
  query: z.string().trim().min(1).max(4000).describe("A GAQL SELECT statement. GAQL has no other statement, so this cannot change anything"),
};
export const adsQueryInput = z.object(adsQueryShape);
export const adsQueryOutput = z.object({
  query: z.string(),
  rowCount: z.number(),
  rows: z.array(z.record(z.string(), z.unknown())),
});

export const adsSearchTermsShape = {
  days: adsWindow,
  // Money is what the decision is about. Sorting by impressions puts cheap noise
  // at the top of a list whose purpose is deciding what to stop paying for.
  minCost: z.number().min(0).default(0).describe("Drop search terms that cost less than this over the window"),
  minImpressions: z.number().int().min(0).default(0).describe("Drop search terms below this many impressions"),
  zeroConversionsOnly: z.boolean().default(false).describe("Keep only terms that converted nothing, which is the list that feeds negative keywords"),
};
export const adsSearchTermsInput = z.object(adsSearchTermsShape);
export const adsSearchTermsOutput = z.object({
  days: z.number(),
  rowCount: z.number(),
  searchTerms: z.array(
    z.object({
      searchTerm: z.string(),
      matchedKeyword: z.string(),
      matchType: z.string().describe("How the term matched the keyword. A wrong term and a right term in the wrong ad group have different fixes"),
      campaign: z.string(),
      status: z.string(),
      impressions: z.number(),
      clicks: z.number(),
      cost: z.number(),
      conversions: z.number(),
    }),
  ),
  notes: z.array(z.string()),
});

export const adsChangesShape = {
  // Google keeps change history for 30 days and refuses a longer window, so the
  // cap is the API's, not a preference.
  days: z.number().int().min(1).max(30).default(14).describe("How many days of change history to read, ending now. Google keeps 30 days and refuses more"),
  limit: z.number().int().min(1).max(1000).default(100).describe("Most recent changes to return"),
};
export const adsChangesInput = z.object(adsChangesShape);
export const adsChangesOutput = z.object({
  days: z.number(),
  rowCount: z.number(),
  changes: z.array(
    z.object({
      changedAt: z.string(),
      resourceType: z.string(),
      operation: z.string(),
      changedFields: z.string(),
      userEmail: z.string(),
      clientType: z.string().describe("GOOGLE_ADS_API for a change made by a tool, GOOGLE_ADS_WEB_CLIENT for one made in the browser"),
      campaign: z.string(),
    }),
  ),
  notes: z.array(z.string()),
});

export const adsUpdateBatchShape = {
  kind: z
    .enum(["bid", "budget"])
    .describe("One kind per call. A summed guard is only honest inside one kind: bids and budgets sum to dollars, statuses do not, and mixing them makes the total unreadable"),
  changes: z
    .array(z.object({ target: z.string().trim().min(1).max(400), value: z.number().min(0) }))
    .min(1)
    .max(50)
    .describe("A named list of pairs, each with its own value. There is no selector form: enumeration cannot make the mistake that a pattern can"),
  dryRun: z.boolean().default(true).describe("Resolve and price every entry and report the total, without changing anything"),
  confirm: z.boolean().default(false).describe("Perform the batch even though a guard tripped. The dry run lists every reason, so this confirms something already read"),
};
export const adsUpdateBatchInput = z.object(adsUpdateBatchShape);
export const adsUpdateBatchOutput = z.object({
  kind: z.string(),
  customerId: z.string(),
  entries: z.array(
    z.object({
      target: z.string(),
      before: z.number().nullable(),
      after: z.number(),
      guards: z.array(z.string()),
      applied: z.boolean(),
      readBack: z.number().nullable(),
      matches: z.boolean().nullable(),
    }),
  ),
  totalBefore: z.number().nullable().describe("Null when any entry has no current value to read, because a total that counts unknowns as zero is not a total"),
  totalAfter: z.number(),
  totalSummary: z.string().describe("The batch total in words, always present whether or not anything tripped. The sentence is what gets read; the guard is only what stops you when it is not"),
  totalGuards: z.array(z.string()).describe("Guards on the batch as a whole. Five individually reasonable raises are one large spend change, and doing them one at a time is how that gets missed"),
  applied: z.boolean(),
  notes: z.array(z.string()),
});

export const adsNegativesShape = {
  level: z
    .enum(["campaign", "adGroup", "sharedSet", "all"])
    .default("all")
    .describe("Which negatives to read. A term blocked at campaign level is blocked everywhere in it; a shared set applies to every campaign it is attached to"),
};
export const adsNegativesInput = z.object(adsNegativesShape);
export const adsNegativesOutput = z.object({
  rowCount: z.number(),
  negatives: z.array(
    z.object({
      level: z.string(),
      owner: z.string().describe("The campaign, ad group or shared set the negative belongs to"),
      keyword: z.string(),
      matchType: z.string(),
      criterionId: z.string(),
    }),
  ),
  notes: z.array(z.string()),
});

export const adsNegativesUpdateShape = {
  action: z.enum(["add", "remove"]).describe("Add negative keywords or remove existing ones. Removal matters as much as adding: a wrong negative shows up as nothing at all"),
  level: z.enum(["campaign", "adGroup"]).default("campaign").describe("Where the negatives live. A campaign-level negative blocks the term everywhere in that campaign"),
  target: z.string().trim().min(1).max(400).describe("The campaign or ad group name. It must match exactly one or nothing is changed"),
  keywords: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(100)
    .describe("The negative terms, enumerated one by one. There is no pattern or match-all form: a selector is one typo away from blocking a whole campaign"),
  matchType: z
    .enum(["BROAD", "PHRASE", "EXACT"])
    .default("EXACT")
    .describe("How each term blocks. BROAD blocks any query containing all its words, which is the setting that can silently kill a campaign"),
  dryRun: z.boolean().default(true).describe("Report what would change, and which proposed negatives would block a live keyword, without changing anything"),
  confirm: z.boolean().default(false).describe("Perform the batch even though a guard tripped. The dry run lists what tripped, so this confirms something already read"),
};
export const adsNegativesUpdateInput = z.object(adsNegativesUpdateShape);
export const adsNegativesUpdateOutput = z.object({
  action: z.string(),
  level: z.string(),
  target: z.string(),
  matchType: z.string(),
  requested: z.array(z.string()),
  applied: z.boolean(),
  skipped: z.array(z.object({ keyword: z.string(), reason: z.string() })).describe("Terms not sent, because they are already present when adding or absent when removing"),
  collisions: z
    .array(z.object({ negative: z.string(), blocks: z.string(), impressions: z.number() }))
    .describe("Proposed negatives that would stop one of this campaign's own live keywords from serving. This is the error that otherwise produces no evidence at all"),
  guards: z.array(z.string()),
  changed: z.array(z.string()),
  notes: z.array(z.string()),
});

export const adsUpdateShape = {
  kind: z
    .enum(["bid", "budget", "campaignStatus", "adStatus", "keywordStatus"])
    .describe(
      "What to change: a keyword's max CPC bid, a campaign's daily budget, a campaign's status, an ad's status, or a keyword's status. Use keywordStatus to stop one keyword serving; dropping its bid is not the same thing, because the keyword stays eligible and keeps competing for the same budget",
    ),
  target: z.string().trim().min(1).max(400).describe("The keyword text, the campaign name, or the numeric ad id. It must match exactly one thing or the call is refused"),
  value: z.string().trim().min(1).max(40).describe("The new amount in dollars for a bid or budget, or pause or enable for a status"),
  dryRun: z
    .boolean()
    .default(true)
    .describe("Report what would change and which guards it trips, without changing anything. On by default: this tool spends money, so performing a change has to be asked for"),
  confirm: z
    .boolean()
    .default(false)
    .describe("Perform a change that trips a guard. Ignored on a dry run. The dry run lists the guard reasons, so this confirms something already read rather than something unseen"),
};
export const adsUpdateInput = z.object(adsUpdateShape);
export const adsUpdateOutput = z.object({
  kind: z.string(),
  target: z.string(),
  customerId: z.string(),
  before: z.string(),
  after: z.string(),
  guards: z.array(z.string()),
  applied: z.boolean(),
  noOp: z.boolean(),
  readBack: z.string().nullable().describe("The value re-read from the account after the write. An accepted request is not proof of a stored value"),
  matches: z.boolean().nullable().describe("Whether the re-read value equals what was sent"),
});

const snapshotRow = z.object({
  rank: z.number(),
  keys: z.record(z.string(), z.string()),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
});
const snapshotRows = z.object({ rows: z.array(snapshotRow), truncated: z.boolean() });
const snapshotWindow = z.object({ startDate: z.string(), endDate: z.string() });
const snapshotRatings = z.array(
  z.object({
    storefront: z.string(),
    // Optional so a snapshot taken before the source was recorded still parses.
    source: z.string().optional(),
    averageUserRating: z.number().nullable(),
    userRatingCount: z.number().nullable(),
  }),
);

// The shape compare_snapshots accepts. Anything that is not this is refused, so
// the tool cannot be pointed at an unrelated file.
export const snapshotDocument = z.object({
  takenAt: z.string(),
  windowDays: z.number(),
  window: snapshotWindow,
  properties: z.array(
    z.object({
      siteUrl: z.string(),
      error: z.string().optional(),
      totals: z
        .object({
          clicks: z.number(),
          impressions: z.number(),
          ctr: z.number().nullable(),
          position: z.number().nullable(),
          daysWithData: z.number(),
          firstIncompleteDate: z.string().nullable(),
        })
        .optional(),
      topQueries: snapshotRows.optional(),
      topPages: snapshotRows.optional(),
    }),
  ),
  apps: z.array(
    z
      .object({
        app: z.string(),
        error: z.string().optional(),
        versionString: z.string().nullable().optional(),
        localeCount: z.number().optional(),
        hasEditableRecord: z.boolean().optional(),
        ratings: snapshotRatings.optional(),
      })
      .loose(),
  ),
  packages: z.array(
    z
      .object({
        package: z.string(),
        error: z.string().optional(),
        activeDeviceInstalls: z.number().nullable().optional(),
        lastDatePresent: z.string().nullable().optional(),
      })
      .loose(),
  ),
  slugs: z.array(
    z
      .object({
        slug: z.string(),
        error: z.string().optional(),
        activeInstalls: z.number().nullable().optional(),
        downloaded: z.number().nullable().optional(),
        rating: z.number().nullable().optional(),
        numRatings: z.number().nullable().optional(),
      })
      .loose(),
  ),
  surfacesWithErrors: z.array(z.string()),
  writtenTo: z.string().optional(),
});

export const listSnapshotsShape = {
  limit: z.number().int().min(1).max(200).default(50).describe("Maximum snapshots to return, newest first"),
};
export const listSnapshotsInput = z.object(listSnapshotsShape);
export const listSnapshotsOutput = z.object({
  directory: z.string(),
  total: z.number(),
  truncated: z.boolean(),
  snapshots: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      // Null on a file that could not be parsed, which is listed with its error
      // rather than hidden.
      takenAt: z.string().nullable(),
      windowDays: z.number().nullable(),
      surfaces: z.object({ properties: z.number(), apps: z.number(), packages: z.number(), slugs: z.number() }),
      error: z.string().optional(),
    }),
  ),
});

export const snapshotShape = {
  properties: z.array(siteUrl).default([]).describe("Search Console properties to capture"),
  apps: z.array(z.string().trim().min(1)).default([]).describe("App Store apps, each a numeric app id or a bundle id"),
  packages: z.array(z.string().trim().min(1)).default([]).describe("Google Play package names"),
  slugs: z.array(z.string().trim().min(1)).default([]).describe("WordPress.org plugin slugs"),
  windowDays: z.number().int().min(1).max(480).default(28).describe("Search Console window in days, ending today"),
  platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS").describe("App Store platform for the app surfaces"),
  storefronts: z
    .array(z.string().regex(/^[a-z]{2}$/, "storefronts must be 2-letter lowercase country codes"))
    .min(1)
    .max(10)
    .default(["us"])
    .describe("Storefront country codes for App Store ratings"),
  outPath: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "File name or path inside the snapshot directory (SEO_MCP_SNAPSHOT_DIR, default ~/.config/seo-mcp/snapshots); must end in .json, or pass auto to name the file after the moment it was taken. An existing file is not overwritten unless overwrite is true",
    ),
  overwrite: z.boolean().default(false).describe("Replace an existing file at outPath; without it an existing file is left alone and reported"),
};
export const snapshotInput = z.object(snapshotShape);
export const snapshotOutput = snapshotDocument;

export const compareSnapshotsShape = {
  from: z.string().trim().min(1).describe("Snapshot file name or path inside the snapshot directory; latest names the newest snapshot on disk and previous the one before it"),
  to: z.string().trim().min(1).describe("Snapshot file name or path inside the snapshot directory; latest names the newest snapshot on disk and previous the one before it"),
  minImpressions: z.number().int().min(0).default(100).describe("Ignore page position moves below this many impressions on both sides"),
};
export const compareSnapshotsInput = z.object(compareSnapshotsShape);
// A side that was never captured is null rather than zero, and the change is
// null with it: subtracting from an absence is arithmetic on a number nobody
// measured.
const comparedDelta = z.object({ from: z.number().nullable(), to: z.number().nullable(), change: z.number().nullable() });
const comparedHistogram = z.object({ 5: comparedDelta, 4: comparedDelta, 3: comparedDelta, 2: comparedDelta, 1: comparedDelta });
const comparedMover = z.object({ positionFrom: z.number(), positionTo: z.number(), change: z.number(), impressions: z.number() });
export const compareSnapshotsOutput = z.object({
  from: z.object({ takenAt: z.string(), window: snapshotWindow }),
  to: z.object({ takenAt: z.string(), window: snapshotWindow }),
  elapsedHours: z.number().nullable(),
  argumentsReversed: z.boolean(),
  minImpressions: z.number(),
  properties: z.array(
    z
      .object({
        siteUrl: z.string(),
        comparable: z.boolean(),
        // Absent on a property that could not be compared at all, which returns the
        // pair name and nothing else.
        queryMovers: z.array(comparedMover.extend({ query: z.string() })).optional(),
        droppedOutOfTopQueries: z.array(z.string()).optional(),
      })
      .loose(),
  ),
  apps: z.array(
    z
      .object({
        app: z.string(),
        comparable: z.boolean(),
        localesComparable: z.boolean(),
        locales: z.array(
          z.object({
            locale: z.string(),
            name: comparedDelta,
            subtitle: comparedDelta,
            keywords: comparedDelta,
            promotionalText: comparedDelta,
            description: comparedDelta,
          }),
        ),
        overLimit: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
      })
      .loose(),
  ),
  packages: z.array(
    z
      .object({
        package: z.string(),
        comparable: z.boolean(),
        trafficSources: z.array(
          z.object({
            source: z.string(),
            visitors: comparedDelta,
            acquisitions: comparedDelta,
            conversionRate: comparedDelta,
          }),
        ),
        hasPlaySearchRows: z.object({ from: z.boolean().nullable(), to: z.boolean().nullable() }),
      })
      .loose(),
  ),
  slugs: z.array(
    z
      .object({
        slug: z.string(),
        comparable: z.boolean(),
        ratingsHistogram: comparedHistogram,
      })
      .loose(),
  ),
  surfacesWithErrors: z.array(z.string()),
  notes: z.array(z.string()),
});

const cruxFormFactor = z.enum(["PHONE", "TABLET", "DESKTOP"]);
const cruxTargetShape = {
  origin: z.string().trim().min(1).optional().describe("Origin such as https://example.com; aggregates every page under it. Give origin or url, not both"),
  url: z.string().trim().min(1).optional().describe("A single page URL. Give origin or url, not both"),
  formFactor: cruxFormFactor.optional().describe("Device class; omit for all form factors combined"),
  metrics: z.array(z.string().trim().min(1)).max(20).optional().describe("Metric names to request; omit for all available"),
};

export const cruxFieldDataShape = { ...cruxTargetShape };
export const cruxFieldDataInput = z.object(cruxFieldDataShape);
export const cruxFieldDataOutput = z.object({
  origin: z.string().nullable(),
  url: z.string().nullable(),
  formFactor: z.string().nullable(),
  hasData: z.boolean(),
  source: z.string(),
  collectionPeriod: z.object({ firstDate: z.string().nullable(), lastDate: z.string().nullable() }).optional(),
  normalizedUrl: z.string().nullable().optional(),
  metrics: z
    .record(
      z.string(),
      z.object({
        p75: z.number().nullable(),
        histogram: z.array(z.object({ start: z.number().nullable(), end: z.number().nullable(), density: z.number().nullable() })),
      }),
    )
    .or(z.record(z.string(), z.never())),
  notes: z.array(z.string()),
});

export const cruxHistoryShape = {
  ...cruxTargetShape,
  collectionPeriodCount: z.number().int().min(1).max(40).optional().describe("Weekly periods to return, 1 to 40. Documented history is about six months; the API decides what it actually has"),
};
export const cruxHistoryInput = z.object(cruxHistoryShape);
export const cruxHistoryOutput = z.object({
  origin: z.string().nullable(),
  url: z.string().nullable(),
  formFactor: z.string().nullable(),
  hasData: z.boolean(),
  source: z.string(),
  periodCount: z.number().optional(),
  collectionPeriods: z.array(z.object({ firstDate: z.string().nullable(), lastDate: z.string().nullable() })).optional(),
  normalizedUrl: z.string().nullable().optional(),
  metrics: z.record(z.string(), z.object({ p75s: z.array(z.number().nullable()) })).or(z.record(z.string(), z.never())),
  notes: z.array(z.string()),
});

export const appStoreReviewsShape = {
  appId: z.string().regex(/^\d+$/, "appId must be the numeric App Store app id").optional().describe("App Store Connect numeric app id; provide this or bundleId"),
  bundleId: z.string().trim().min(1).max(200).optional().describe("Bundle id; provide this or appId"),
  rating: z.array(z.number().int().min(1).max(5)).max(5).optional().describe("Only these star ratings"),
  territory: z
    .string()
    .regex(/^[A-Z]{3}$/, "territory must be a 3-letter uppercase code such as USA")
    .optional()
    .describe("Only reviews from this storefront"),
  sort: z.enum(["-createdDate", "createdDate", "rating", "-rating"]).default("-createdDate").describe("Sort order; newest first by default"),
  limit: z.number().int().min(1).max(1000).default(100).describe("Maximum reviews to return across pages"),
  maxPages: z.number().int().min(1).max(20).default(5).describe("Maximum pages to follow"),
};
export const appStoreReviewsInput = z.object(appStoreReviewsShape);
export const appStoreReviewsOutput = z.object({
  appId: z.string(),
  bundleId: z.string().nullable(),
  returned: z.number(),
  pagesRead: z.number(),
  meanOfFetched: z.number().nullable(),
  histogramOfFetched: z.record(z.string(), z.number()),
  withoutResponse: z.number(),
  filters: z.object({ rating: z.array(z.number()).nullable(), territory: z.string().nullable(), sort: z.string() }),
  reviews: z.array(
    z.object({
      id: z.string(),
      rating: z.number().nullable(),
      title: z.string().nullable(),
      body: z.string().nullable(),
      reviewerNickname: z.string().nullable(),
      createdDate: z.string().nullable(),
      territory: z.string().nullable(),
      respondedAt: z.string().nullable(),
      responseBody: z.string().nullable(),
    }),
  ),
  notes: z.array(z.string()),
});

export const appStoreDiscoveryShape = {
  appId: z.string().regex(/^\d+$/, "appId must be the numeric App Store app id").optional().describe("App Store Connect numeric app id; provide this or bundleId"),
  bundleId: z.string().trim().min(1).max(200).optional().describe("Bundle id; provide this or appId"),
  include: z
    .array(z.enum(["searchKeywords", "appTags", "experiments", "customProductPages", "appEvents", "availability", "reviewSummarizations"]))
    .default([])
    .describe("Which discovery surfaces to read; empty reads all of them"),
  limit: z.number().int().min(1).max(200).default(50).describe("Rows per resource"),
  locales: z.array(z.string().trim().min(2).max(10)).min(1).max(20).default(["en-US"]).describe("Locales for per-locale resources such as searchKeywords"),
  platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS").describe("Platform for resources that require one"),
  includeRows: z.boolean().default(false).describe("Include every raw row as well as the counts; off by default so a summary call stays small"),
};
export const appStoreDiscoveryInput = z.object(appStoreDiscoveryShape);
export const appStoreDiscoveryOutput = z.object({
  appId: z.string(),
  bundleId: z.string().nullable(),
  locales: z.array(z.string()),
  resources: z.record(
    z.string(),
    z.object({
      available: z.boolean(),
      count: z.number().nullable(),
      rows: z.array(z.record(z.string(), z.unknown())),
      error: z.string().optional(),
    }),
  ),
  notes: z.array(z.string()),
});

export const playVitalsShape = {
  packageName: androidPackageName.describe("Android package name"),
  metricSets: z
    .array(z.enum(["crashRate", "anrRate", "errorCount", "slowStartRate", "excessiveWakeupRate"]))
    .min(1)
    .max(5)
    .default(["crashRate", "anrRate"])
    .describe("Which Android vitals metric sets to query"),
  aggregationPeriod: z.enum(["DAILY", "HOURLY"]).default("DAILY").describe("DAILY is reported in America/Los_Angeles, HOURLY in UTC"),
  days: z.number().int().min(1).max(90).default(28).describe("How many days back to query"),
  dimensions: z.array(z.string().trim().min(1)).max(5).default([]).describe("Breakdown dimensions such as versionCode or countryCode"),
  pageSize: z.number().int().min(1).max(100000).default(1000).describe("Rows per metric set"),
  includeRows: z.boolean().default(false).describe("Include every raw row as well as the counts; off by default so a summary call stays small"),
};
export const playVitalsInput = z.object(playVitalsShape);
export const playVitalsOutput = z.object({
  packageName: z.string(),
  aggregationPeriod: z.string(),
  days: z.number(),
  metricSets: z.record(
    z.string(),
    z.object({
      available: z.boolean(),
      rowCount: z.number().nullable(),
      latestDataAt: z.string().nullable(),
      rows: z.array(z.record(z.string(), z.unknown())),
      error: z.string().optional(),
    }),
  ),
  notes: z.array(z.string()),
});

export const appStoreSalesShape = {
  reportDate: z
    .string()
    .trim()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "reportDate must be YYYY-MM-DD, YYYY-MM, or YYYY")
    .optional()
    .describe(
      "Report date. DAILY and WEEKLY take YYYY-MM-DD (WEEKLY means the week's ending date), MONTHLY takes YYYY-MM, YEARLY takes YYYY. Defaults to the most recent complete period for the frequency",
    ),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).default("DAILY").describe("Report period"),
  reportType: z.enum(["SALES", "PRE_ORDER", "SUBSCRIPTION", "SUBSCRIPTION_EVENT", "SUBSCRIBER", "INSTALLS", "FIRST_ANNUAL"]).default("SALES").describe("Sales and Trends report type"),
  reportSubType: z.enum(["SUMMARY", "DETAILED", "SUMMARY_INSTALL_TYPE", "SUMMARY_TERRITORY", "SUMMARY_CHANNEL"]).default("SUMMARY").describe("Report sub type"),
  version: z.string().trim().min(1).max(10).optional().describe("Report version, such as 1_0 or 1_3, when the default is not accepted"),
  includeRows: z.boolean().default(false).describe("Include every raw report row as well as the per-SKU summary"),
};
export const appStoreSalesInput = z.object(appStoreSalesShape);
export const appStoreSalesOutput = z.object({
  reportDate: z.string(),
  frequency: z.string(),
  reportType: z.string(),
  reportSubType: z.string(),
  vendorNumber: z.string(),
  hasData: z.boolean(),
  rowCount: z.number(),
  totalUnits: z.number(),
  apps: z.array(z.object({ sku: z.string(), title: z.string(), units: z.number(), territories: z.record(z.string(), z.number()) })),
  rows: z.array(z.record(z.string(), z.string())),
  notes: z.array(z.string()),
});
