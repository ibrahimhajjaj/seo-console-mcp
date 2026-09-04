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
  ratings?: Record<string, number>;
  support_threads?: number;
  support_threads_resolved?: number;
  tested?: string;
  requires?: string | false;
  requires_php?: string | false;
  added?: string;
  last_updated?: string;
  short_description?: string;
  download_link?: string;
  versions?: Record<string, string>;
  icons?: Record<string, string>;
  tags?: Record<string, string>;
  error?: string;
}

export async function wporgPlugin(params: WporgPluginParams, deps: { fetchImpl?: typeof fetch; now?: Date } = {}): Promise<ToolResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const query = new URLSearchParams({ action: "plugin_information", "request[slug]": params.slug });
  const url = `https://api.wordpress.org/plugins/info/1.2/?${query.toString()}`;
  const response = await fetchImpl(url, {
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

  const notes: string[] = [];
  const [downloads, versionDistribution] = await Promise.all([
    params.downloadDays > 0 ? fetchDownloads(params.slug, params.downloadDays, fetchImpl, notes) : Promise.resolve(null),
    params.includeVersionDistribution ? fetchVersionDistribution(params.slug, fetchImpl, notes) : Promise.resolve(null),
  ]);

  const structuredContent = {
    slug: params.slug,
    name: body.name ?? null,
    version: body.version ?? null,
    activeInstalls: body.active_installs ?? null,
    // active_installs is bucketed by wp.org (nearest 100k at scale), so it moves
    // in steps and is not a growth series. The download history below is the
    // finer-grained signal.
    activeInstallsIsBucketed: true,
    downloaded: body.downloaded ?? null,
    numRatings: body.num_ratings ?? null,
    rating: body.rating ?? null,
    // The full 5-to-1 histogram, not just the average: an average of 90 hides
    // whether it came from steady fours or a split of fives and ones.
    ratings: normalizeHistogram(body.ratings),
    supportThreads: body.support_threads ?? null,
    supportThreadsResolved: body.support_threads_resolved ?? null,
    tested: body.tested ?? null,
    requires: typeof body.requires === "string" ? body.requires : null,
    requiresPhp: typeof body.requires_php === "string" ? body.requires_php : null,
    downloadLink: body.download_link ?? null,
    versionCount: body.versions ? Object.keys(body.versions).length : null,
    added: body.added ?? null,
    lastUpdated: body.last_updated ?? null,
    tags: body.tags ? Object.values(body.tags) : [],
    dailyDownloads: downloads?.daily ?? null,
    downloadSummary: downloads?.summary ?? null,
    versionDistribution,
    possiblyLagging,
    notes,
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

// The stats endpoints are a separate, undocumented-in-practice service from the
// plugin info API, so a failure there must not cost the plugin data that did
// arrive. Each records a note instead.
async function fetchDownloads(
  slug: string,
  days: number,
  fetchImpl: typeof fetch,
  notes: string[],
): Promise<{ daily: Array<{ date: string; downloads: number }>; summary: Record<string, number> | null } | null> {
  const base = "https://api.wordpress.org/stats/plugin/1.0/downloads.php";
  try {
    const [historyResponse, summaryResponse] = await Promise.all([
      fetchImpl(`${base}?${new URLSearchParams({ slug, limit: String(days) })}`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      fetchImpl(`${base}?${new URLSearchParams({ slug, historical_summary: "1" })}`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    ]);
    if (!historyResponse.ok) {
      notes.push(`The download history for "${slug}" returned HTTP ${historyResponse.status}, so it is unknown rather than zero.`);
      return null;
    }
    // The endpoint returns date-keyed strings, and returns junk for a malformed
    // request rather than an error, so anything unexpected is treated as absent.
    const history = (await historyResponse.json()) as Record<string, string> | null;
    if (!history || typeof history !== "object" || Array.isArray(history)) {
      notes.push(`The download history for "${slug}" was not a date-keyed object, so it is unknown rather than zero.`);
      return null;
    }
    const daily = Object.entries(history)
      .filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .map(([date, count]) => ({ date, downloads: Number(count) }))
      .filter((entry) => Number.isFinite(entry.downloads))
      .sort((left, right) => left.date.localeCompare(right.date));
    let summary: Record<string, number> | null = null;
    if (summaryResponse.ok) {
      const raw = (await summaryResponse.json()) as Record<string, string> | null;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        summary = Object.fromEntries(
          Object.entries(raw)
            .map(([key, value]) => [key, Number(value)])
            .filter(([, value]) => Number.isFinite(value as number)),
        );
      }
    }
    return { daily, summary };
  } catch {
    notes.push(`The download history for "${slug}" could not be fetched, so it is unknown rather than zero.`);
    return null;
  }
}

async function fetchVersionDistribution(slug: string, fetchImpl: typeof fetch, notes: string[]): Promise<Array<{ version: string; percentage: number }> | null> {
  try {
    const response = await fetchImpl(`https://api.wordpress.org/stats/plugin/1.0/?${new URLSearchParams({ slug })}`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      notes.push(`The version distribution for "${slug}" returned HTTP ${response.status}, so it is unknown rather than absent.`);
      return null;
    }
    const raw = (await response.json()) as Record<string, number> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    // These are percentages of the plugin's own active installs, not counts.
    return Object.entries(raw)
      .map(([version, percentage]) => ({ version, percentage: Number(percentage) }))
      .filter((entry) => Number.isFinite(entry.percentage))
      .sort((left, right) => right.percentage - left.percentage);
  } catch {
    notes.push(`The version distribution for "${slug}" could not be fetched, so it is unknown rather than absent.`);
    return null;
  }
}

function normalizeHistogram(ratings: Record<string, number> | undefined): Record<string, number> | null {
  if (!ratings || typeof ratings !== "object") return null;
  const histogram: Record<string, number> = {};
  for (const star of ["1", "2", "3", "4", "5"]) {
    const value = Number(ratings[star]);
    histogram[star] = Number.isFinite(value) ? value : 0;
  }
  return histogram;
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
