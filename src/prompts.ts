import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const siteUrlArgs = { siteUrl: z.string() };

export function registerPrompts(server: McpServer): void {
  server.registerPrompt("seo_triage", {
    title: "SEO triage",
    description: "Triage an SEO property and produce an impact-ranked action plan",
    argsSchema: siteUrlArgs,
  }, ({ siteUrl }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Act as a senior SEO and product-marketing manager for ${siteUrl}.

1. Run \`list_properties\` to confirm the property.
2. Run \`search_analytics\` for the last 28 days, then \`compare_search_periods\` against the prior 28 days.
3. Run \`search_opportunities\`, \`ctr_gaps\`, and \`query_cannibalization\`, and use \`keyword_ideas\` to surface net-new topics beyond what Search Console already shows.
4. Run \`audit_site\` on the property's sitemap, or \`seo_audit\` on its top pages, and run \`pagespeed\` on the homepage.
5. Run \`index_coverage\` on the sitemap to see how many pages Google has actually indexed. If pages are missing, offer \`request_recrawl\` to resubmit the sitemap and \`indexnow_submit\` for Bing/Yandex-family engines.
6. If the property belongs to a product that also ships on the App Store, Google Play or WordPress.org, run \`app_store_listing\`, \`play_store_stats\` or \`wporg_plugin\` for it: search is one of four places it gets discovered. For quality signals beside acquisition, \`play_vitals\` (crash and ANR rates) and \`app_store_reviews\` are the equivalents of \`pagespeed\` for a store listing.\n7. Run \`snapshot\` with an \`outPath\` to record where things stand, so the next triage can diff against today with \`compare_snapshots\` instead of relying on memory.\n8. Produce a prioritized action plan ranked by impact versus effort, with specific next steps and the numbers that justify each action.`,
      },
    }],
  }));

  server.registerPrompt("content_opportunities", {
    title: "Content opportunities",
    description: "Find content to create or improve from Search Console evidence",
    argsSchema: siteUrlArgs,
  }, ({ siteUrl }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `For ${siteUrl}, find what content to create or improve. Use \`search_opportunities\` for near-page-1 keywords, \`ctr_gaps\` for rewrite targets, and \`query_cannibalization\` for pages competing with each other; these find queries the property already ranks for. Use \`keyword_ideas\` for net-new keyword and question ideas to create pages for, passing ${siteUrl} as \`siteUrl\` so ideas are cross-referenced against current rankings. If the product also ships on an app store or WordPress.org, run \`app_store_listing\` (its indexed fields are the name, subtitle and keyword field, not the description) and \`app_store_discovery\` for the keywords Apple actually indexes per locale, \`play_store_stats\` (which traffic sources convert) or \`wporg_plugin\`. Group recommendations into create-new versus improve-existing. For each Search Console-backed recommendation, include the query, current position, and impressions that justify it.`,
      },
    }],
  }));

  server.registerPrompt("launch_seo_check", {
    title: "Launch SEO check",
    description: "Assess technical and indexing readiness before a launch",
    argsSchema: siteUrlArgs,
  }, ({ siteUrl }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `For ${siteUrl}, perform a launch or pre-launch SEO check. Run \`seo_audit\` and \`pagespeed\` on the key pages, and \`crux_field_data\` for real-user Core Web Vitals once the origin has enough traffic to appear in the Chrome UX Report. Use \`index_coverage\` on the sitemap (or \`inspect_url\` for a specific page) to confirm indexing, and run \`list_sitemaps\` to confirm a sitemap is submitted. Offer to run \`submit_sitemap\` if it is missing, \`request_recrawl\` if key pages are not indexed yet, and \`indexnow_submit\` to notify Bing/Yandex-family engines (it needs an IndexNow key hosted on the site). Output a go/no-go checklist covering technical and indexing readiness, since SEO analytics will not have data yet at launch.`,
      },
    }],
  }));
}
