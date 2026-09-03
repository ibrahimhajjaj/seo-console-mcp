import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { appStoreDiscoveryInput } from "./schemas.js";
import { ascGet, resolveAppId, readCredentialsFromEnv, createAscToken, asArray, type AscCredentials } from "./app-store-listing.js";
import { mapWithConcurrency } from "./concurrency.js";

// App Store Connect rate-limits, and a full discovery run over 13 locales is 19
// calls. The point of the pool is to stop paying for those round trips one at a
// time, not to fire them all at once, so the ceiling stays low.
const CONCURRENCY = 4;

type DiscoveryParams = z.output<typeof appStoreDiscoveryInput>;

interface DiscoveryDeps {
  fetchImpl?: typeof fetch;
  credentials?: AscCredentials;
  now?: Date;
}

interface JobResult {
  name: string;
  rows?: Array<Record<string, unknown>>;
  error?: string;
}

interface ResourceSpec {
  segment: string;
  // Each resource has its own required parameters. Sending a list query to a
  // to-one relationship, or omitting a required filter, returns a 400 that reads
  // like "unavailable" when it really means "asked wrongly".
  query: (params: DiscoveryParams) => string;
  perLocale?: boolean;
}

// The App Store surfaces a listing through more than its name and keywords.
const RESOURCES: Record<string, ResourceSpec> = {
  // Keywords are held per locale, so an app with several localized listings has
  // a separate set for each and one call cannot cover them all.
  searchKeywords: { segment: "searchKeywords", query: (p) => `limit=${p.limit}&filter%5Bplatform%5D=${encodeURIComponent(p.platform)}`, perLocale: true },
  appTags: { segment: "appTags", query: (p) => `limit=${p.limit}` },
  experiments: { segment: "appStoreVersionExperimentsV2", query: (p) => `limit=${p.limit}` },
  customProductPages: { segment: "appCustomProductPages", query: (p) => `limit=${p.limit}` },
  appEvents: { segment: "appEvents", query: (p) => `limit=${p.limit}` },
  // A to-one relationship: it rejects limit outright.
  availability: { segment: "appAvailabilityV2", query: () => "" },
  reviewSummarizations: { segment: "customerReviewSummarizations", query: (p) => `filter%5Bplatform%5D=${encodeURIComponent(p.platform)}` },
};

export async function appStoreDiscovery(params: DiscoveryParams, deps: DiscoveryDeps = {}): Promise<ToolResult> {
  if (!params.appId && !params.bundleId) {
    throw new Error("Provide appId or bundleId to identify the app.");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const credentials = deps.credentials ?? readCredentialsFromEnv();
  const token = createAscToken(credentials, deps.now ?? new Date());
  const appId = params.appId ?? (await resolveAppId(params.bundleId as string, token, fetchImpl));

  // Deduplicated: the same surface asked for twice is still one entry in the
  // output, and folding a repeat back in would report double the rows it has.
  const requested = [...new Set<string>(params.include?.length ? params.include : Object.keys(RESOURCES))];
  const notes: string[] = [];
  const resources: Record<string, unknown> = {};

  // One flat list of every call the run needs, so a per-locale resource does not
  // hold the pool open while a single-call resource waits behind it.
  const jobs: Array<{ name: string; spec: ResourceSpec; locale: string | null }> = [];
  for (const name of requested) {
    const spec = RESOURCES[name];
    if (!spec) continue;
    const locales: Array<string | null> = spec.perLocale ? [...params.locales] : [null];
    jobs.push(...locales.map((locale) => ({ name, spec, locale })));
  }

  const settled = await mapWithConcurrency(jobs, CONCURRENCY, async ({ name, spec, locale }): Promise<JobResult> => {
    try {
      const parts = [spec.query(params), ...(locale ? [`filter%5Blocale%5D=${encodeURIComponent(locale)}`] : [])].filter(Boolean);
      const suffix = parts.length ? `?${parts.join("&")}` : "";
      const response = await ascGet(`/v1/apps/${appId}/${spec.segment}${suffix}`, token, fetchImpl);
      const rows = asArray(response.data).map((entry) => ({ id: entry.id, type: entry.type, ...(locale ? { locale } : {}), ...(entry.attributes ?? {}) }));
      return { name, rows };
    } catch (error) {
      return { name, error: error instanceof Error ? error.message : String(error) };
    }
  });

  let withheldRows = false;
  // Folded back in requested order, and within a resource in locale order,
  // because the pool preserves its input order and the jobs were built that way.
  for (const name of requested) {
    if (!RESOURCES[name]) continue;
    const own = settled.filter((entry) => entry.name === name);
    const message = own.find((entry) => entry.error !== undefined)?.error;
    if (message !== undefined) {
      // A resource this key or app cannot serve is recorded as unavailable, not
      // as an empty list: "no experiments" and "cannot read experiments" are
      // different answers and must not render the same. One failed locale still
      // condemns the whole resource: a partial keyword set read as complete
      // would be a quieter wrong answer than none at all.
      resources[name] = { available: false, count: null, rows: [], error: message };
      notes.push(`${name} could not be read (${message.split(".")[0]}), so it is unknown rather than empty.`);
      continue;
    }
    const rows = own.flatMap((entry) => entry.rows ?? []);
    if (!params.includeRows && rows.length) withheldRows = true;
    // Counted off the full list even when the rows themselves are held back, so
    // a withheld resource still reads as "there is something here".
    resources[name] = { available: true, count: rows.length, rows: params.includeRows ? rows : [] };
  }
  if (withheldRows) notes.push("Rows were not returned; pass includeRows to see them.");

  const structuredContent = {
    appId,
    bundleId: params.bundleId ?? null,
    locales: params.locales,
    resources,
    notes,
  };

  const lines = [`App Store discovery surfaces for app ${appId}`];
  for (const name of requested) {
    const entry = resources[name] as { available: boolean; count: number | null } | undefined;
    if (entry) lines.push(`- ${name}: ${entry.available ? String(entry.count) : "unavailable"}`);
  }
  lines.push("An unavailable resource is one this key or app could not serve; that is not the same as having none.");
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent };
}
