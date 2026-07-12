import { accessSync, constants } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  inspectUrlOutput,
  inspectUrlShape,
  listSitemapsOutput,
  listSitemapsShape,
  pageSpeedOutput,
  pageSpeedShape,
  searchAnalyticsOutput,
  searchAnalyticsShape,
  seoAuditOutput,
  seoAuditShape,
  submitSitemapOutput,
  submitSitemapShape,
} from "./schemas.js";
import {
  createGoogleClients,
  inspectUrl,
  listSitemaps,
  runPageSpeed,
  searchAnalytics,
  submitSitemap,
  type GoogleClients,
  type ToolResult,
} from "./google-tools.js";
import { fetchHtml } from "./fetch-page.js";
import { parseSeoHtml } from "./seo-audit.js";
import { formatToolError } from "./errors.js";

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

  server.registerTool("search_analytics", {
    description: "Query Google Search Console search analytics and return ranked clicks, impressions, CTR, and position",
    inputSchema: searchAnalyticsShape,
    outputSchema: searchAnalyticsOutput,
  },
    async (params) => safely(() => searchAnalytics(getAuthenticatedClients(), params)),
  );

  server.registerTool("list_sitemaps", {
    description: "List sitemaps submitted for a Google Search Console property",
    inputSchema: listSitemapsShape,
    outputSchema: listSitemapsOutput,
  },
    async (params) => safely(() => listSitemaps(getAuthenticatedClients(), params)),
  );

  server.registerTool("submit_sitemap", {
    description: "Submit a sitemap to Google Search Console and return its current state",
    inputSchema: submitSitemapShape,
    outputSchema: submitSitemapOutput,
  },
    async (params) => safely(() => submitSitemap(getAuthenticatedClients(), params)),
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
