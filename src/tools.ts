import { accessSync, constants } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  auditSiteOutput,
  auditSiteShape,
  compareSearchPeriodsOutput,
  compareSearchPeriodsShape,
  ctrGapsOutput,
  ctrGapsShape,
  deleteSitemapOutput,
  deleteSitemapShape,
  inspectUrlOutput,
  inspectUrlShape,
  listPropertiesOutput,
  listPropertiesShape,
  listSitemapsOutput,
  listSitemapsShape,
  pageSpeedOutput,
  pageSpeedShape,
  queryCannibalizationOutput,
  queryCannibalizationShape,
  searchAnalyticsOutput,
  searchAnalyticsShape,
  searchOpportunitiesOutput,
  searchOpportunitiesShape,
  seoAuditOutput,
  seoAuditShape,
  submitSitemapOutput,
  submitSitemapShape,
} from "./schemas.js";
import { auditSite } from "./audit-site.js";
import {
  compareSearchPeriods,
  createGoogleClients,
  ctrGapsTool,
  deleteSitemap,
  inspectUrl,
  listProperties,
  listSitemaps,
  queryCannibalization,
  runPageSpeed,
  searchAnalytics,
  searchOpportunities,
  submitSitemap,
  type GoogleClients,
  type ToolResult,
} from "./google-tools.js";
import { fetchHtml } from "./fetch-page.js";
import { parseSeoHtml } from "./seo-audit.js";
import { formatToolError } from "./errors.js";
import { registerPrompts } from "./prompts.js";

export interface ToolDependencies {
  credentialsPath?: string;
  clients?: GoogleClients;
}

export function registerTools(server: McpServer, dependencies: ToolDependencies = {}): void {
  let clients: GoogleClients | undefined = dependencies.clients;
  const getClients = (): GoogleClients => clients ??= createGoogleClients(dependencies.credentialsPath);
  const getAuthenticatedClients = (): GoogleClients => {
    if (!dependencies.clients) validateCredentials(dependencies.credentialsPath);
    return getClients();
  };

  server.registerResource("properties", "seo://properties", {
    title: "Search Console properties",
    description: "Live list of Google Search Console properties available to the service account",
    mimeType: "application/json",
  }, async (uri) => {
    try {
      const properties = await listProperties(getAuthenticatedClients());
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(properties.structuredContent) }] };
    } catch (error) {
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: formatToolError(error) }) }] };
    }
  });

  server.registerTool("search_analytics", {
    description: "Query Google Search Console search analytics and return ranked clicks, impressions, CTR, and position",
    inputSchema: searchAnalyticsShape,
    outputSchema: searchAnalyticsOutput,
  },
    async (params) => safely(() => searchAnalytics(getAuthenticatedClients(), params)),
  );

  server.registerTool("search_opportunities", {
    description: "Find queries ranking just off page 1 with high impressions, the highest-ROI keywords to improve",
    inputSchema: searchOpportunitiesShape,
    outputSchema: searchOpportunitiesOutput,
  },
    async (params) => safely(() => searchOpportunities(getAuthenticatedClients(), params)),
  );

  server.registerTool("compare_search_periods", {
    description: "Compare an analysis window with the preceding equal period to identify search gainers and losers",
    inputSchema: compareSearchPeriodsShape,
    outputSchema: compareSearchPeriodsOutput,
  },
    async (params) => safely(() => compareSearchPeriods(getAuthenticatedClients(), params)),
  );

  server.registerTool("ctr_gaps", {
    description: "Find high-impression queries or pages whose CTR trails peers at the same position for snippet rewrite prioritization",
    inputSchema: ctrGapsShape,
    outputSchema: ctrGapsOutput,
  },
    async (params) => safely(() => ctrGapsTool(getAuthenticatedClients(), params)),
  );

  server.registerTool("query_cannibalization", {
    description: "Find queries served by multiple pages to prioritize consolidation and internal-linking decisions",
    inputSchema: queryCannibalizationShape,
    outputSchema: queryCannibalizationOutput,
  },
    async (params) => safely(() => queryCannibalization(getAuthenticatedClients(), params)),
  );

  server.registerTool("list_sitemaps", {
    description: "List sitemaps submitted for a Google Search Console property",
    inputSchema: listSitemapsShape,
    outputSchema: listSitemapsOutput,
  },
    async (params) => safely(() => listSitemaps(getAuthenticatedClients(), params)),
  );

  server.registerTool("list_properties", {
    description: "List Google Search Console properties the service account can access, with permission levels",
    inputSchema: listPropertiesShape,
    outputSchema: listPropertiesOutput,
  },
    async () => safely(() => listProperties(getAuthenticatedClients())),
  );

  server.registerTool("submit_sitemap", {
    description: "Submit a sitemap to Google Search Console and return its current state",
    inputSchema: submitSitemapShape,
    outputSchema: submitSitemapOutput,
  },
    async (params) => safely(() => submitSitemap(getAuthenticatedClients(), params)),
  );

  server.registerTool("delete_sitemap", {
    description: "Remove a submitted sitemap from a Search Console property (write; supports dryRun)",
    inputSchema: deleteSitemapShape,
    outputSchema: deleteSitemapOutput,
  },
    async (params) => safely(() => deleteSitemap(getAuthenticatedClients(), params)),
  );

  server.registerTool("inspect_url", {
    description: "Inspect a URL's Google index status, canonical selection, mobile usability, and rich results",
    inputSchema: inspectUrlShape,
    outputSchema: inspectUrlOutput,
  },
    async (params) => safely(() => inspectUrl(getAuthenticatedClients(), params)),
  );

  server.registerTool("pagespeed", {
    description: "Run PageSpeed Insights for field Core Web Vitals, Lighthouse scores, and top opportunities",
    inputSchema: pageSpeedShape,
    outputSchema: pageSpeedOutput,
  },
    async (params) => safely(() => runPageSpeed(getClients(), params)),
  );

  server.registerTool("seo_audit", {
    description: "Fetch and audit a web page's on-page SEO without Google credentials",
    inputSchema: seoAuditShape,
    outputSchema: seoAuditOutput,
  },
    async (params) => safely(async () => {
      const page = await fetchHtml(params.url);
      const audit = parseSeoHtml(page.html, page.finalUrl);
      const text = formatAudit(audit);
      return { content: [{ type: "text", text }], structuredContent: { ...audit, httpStatus: page.status } };
    }),
  );

  server.registerTool("audit_site", {
    description: "Audit the on-page SEO of up to N pages from a sitemap and roll up the most common issues across the site.",
    inputSchema: auditSiteShape,
    outputSchema: auditSiteOutput,
  },
    async (params) => safely(async () => {
      const result = await auditSite(params.sitemapUrl, params);
      return {
        content: [{ type: "text", text: formatSiteAudit(result) }],
        structuredContent: { ...result },
      };
    }),
  );

  registerPrompts(server);
}

async function safely(operation: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    return { content: [{ type: "text", text: formatToolError(error) }], isError: true };
  }
}

function validateCredentials(credentialsPath: string | undefined): void {
  if (!credentialsPath) {
    throw new Error("Google service account credentials are not configured. Set GOOGLE_APPLICATION_CREDENTIALS or SEO_MCP_CREDENTIALS, or start seo-mcp with --credentials /absolute/path/key.json. The seo_audit and pagespeed tools do not require service account credentials.");
  }
  try {
    accessSync(credentialsPath, constants.R_OK);
  } catch {
    throw new Error(`Google service account credentials are unreadable at ${credentialsPath}. Check the path and file permissions. Key contents are never logged.`);
  }
}

function formatAudit(audit: ReturnType<typeof parseSeoHtml>): string {
  return [
    `SEO audit for ${audit.url}`,
    `Title: ${audit.title.text ?? "missing"} (${audit.title.length} characters, ${audit.title.count} element(s))`,
    `Meta description: ${audit.metaDescription.text ?? "missing"} (${audit.metaDescription.length} characters)`,
    `Canonical: ${audit.canonical ?? "missing"}`,
    `H1: ${audit.h1.count} (${audit.h1.texts.join(" | ") || "missing"})`,
    `Schema types: ${audit.schemaTypes.join(", ") || "none"}`,
    `Images with alt: ${audit.images.withAlt}/${audit.images.count} (${audit.images.altPercentage}%)`,
    `Links: ${audit.links.internal} internal, ${audit.links.external} external`,
    `Words: ${audit.wordCount}; lang: ${audit.lang ?? "missing"}; viewport: ${audit.viewport ? "present" : "missing"}`,
    "Issues:",
    ...(audit.issues.length ? audit.issues.map((issue) => `- ${issue}`) : ["- None of the checked common issues found"]),
  ].join("\n");
}

function formatSiteAudit(audit: Awaited<ReturnType<typeof auditSite>>): string {
  const summary = `Audited ${audit.audited} of ${audit.totalDiscovered} discovered pages; ${audit.failed} failed`;
  const truncation = audit.truncated
    ? `Truncated: ${audit.skipped} discovered page(s) and ${audit.childSitemapsSkipped} child sitemap(s) skipped`
    : "Truncated: no";
  const issues = Object.entries(audit.rollup)
    .sort((left, right) => right[1] - left[1])
    .map(([issue, count]) => `- ${issue}: ${count}`);
  return [summary, truncation, "Issue rollup:", ...(issues.length ? issues : ["- No issues found"])].join("\n");
}
