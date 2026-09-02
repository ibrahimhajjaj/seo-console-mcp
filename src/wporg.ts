import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { wporgPluginInput } from "./schemas.js";
import { USER_AGENT } from "./version.js";

type WporgPluginParams = z.output<typeof wporgPluginInput>;

const REQUEST_TIMEOUT_MS = 15_000;
const LAG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// The wp.org API answers an unknown slug with `false` or `null`, or an object
// carrying an `error` string, rather than an HTTP error.
interface PluginInfo {
  name?: string;
  version?: string;
  active_installs?: number;
  downloaded?: number;
  num_ratings?: number;
  rating?: number;
  support_threads?: number;
  support_threads_resolved?: number;
  tested?: string;
  added?: string;
  last_updated?: string;
  short_description?: string;
  icons?: Record<string, string>;
  tags?: Record<string, string>;
  error?: string;
}

export async function wporgPlugin(
  params: WporgPluginParams,
  deps: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<ToolResult> {
  const query = new URLSearchParams({ action: "plugin_information", "request[slug]": params.slug });
  const url = `https://api.wordpress.org/plugins/info/1.2/?${query.toString()}`;
  const response = await (deps.fetchImpl ?? fetch)(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`WordPress.org returned HTTP ${response.status} for plugin "${params.slug}".`);
  }
  const body = (await response.json()) as PluginInfo | false | null;
  if (!body || body.error) {
    throw new Error(`No WordPress.org plugin found for slug "${params.slug}".`);
  }

  const iconMissing = !body.icons || Object.keys(body.icons).length === 0;
  const descriptionEmpty = !body.short_description?.trim();
  const recentlyAdded = withinLagWindow(body.added, deps.now ?? new Date());
  const possiblyLagging = recentlyAdded && (iconMissing || descriptionEmpty);

  const structuredContent = {
    slug: params.slug,
    name: body.name ?? null,
    version: body.version ?? null,
    activeInstalls: body.active_installs ?? null,
    downloaded: body.downloaded ?? null,
    numRatings: body.num_ratings ?? null,
    rating: body.rating ?? null,
    supportThreads: body.support_threads ?? null,
    supportThreadsResolved: body.support_threads_resolved ?? null,
    tested: body.tested ?? null,
    added: body.added ?? null,
    lastUpdated: body.last_updated ?? null,
    tags: body.tags ? Object.values(body.tags) : [],
    possiblyLagging,
  };

  const lines = [
    `WordPress.org plugin "${structuredContent.name ?? params.slug}" (${params.slug})`,
    `Active installs: ${format(structuredContent.activeInstalls)}; downloads: ${format(structuredContent.downloaded)}`,
    `Rating: ${format(structuredContent.rating)}/100 from ${format(structuredContent.numRatings)} rating(s)`,
    `Support: ${format(structuredContent.supportThreadsResolved)}/${format(structuredContent.supportThreads)} threads resolved`,
    `Version ${structuredContent.version ?? "unknown"}; tested up to ${structuredContent.tested ?? "unknown"}; last updated ${structuredContent.lastUpdated ?? "unknown"}`,
  ];
  if (possiblyLagging) {
    lines.push("Note: this plugin was added recently and the wp.org API under-reports fresh plugins, so a missing icon or short description here may not reflect the live listing.");
  }

  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent };
}

function withinLagWindow(added: string | undefined, now: Date): boolean {
  if (!added) return false;
  const addedTime = Date.parse(added);
  if (Number.isNaN(addedTime)) return false;
  return now.getTime() - addedTime <= LAG_WINDOW_MS;
}

function format(value: number | null): string {
  return value === null ? "unknown" : String(value);
}
