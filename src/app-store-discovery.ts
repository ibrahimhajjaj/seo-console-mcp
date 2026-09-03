import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { appStoreDiscoveryInput } from "./schemas.js";
import { ascGet, resolveAppId, readCredentialsFromEnv, createAscToken, type AscCredentials } from "./app-store-listing.js";

type DiscoveryParams = z.output<typeof appStoreDiscoveryInput>;

interface DiscoveryDeps {
  fetchImpl?: typeof fetch;
  credentials?: AscCredentials;
  now?: Date;
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

  const requested = params.include?.length ? params.include : Object.keys(RESOURCES);
  const notes: string[] = [];
  const resources: Record<string, unknown> = {};

  for (const name of requested) {
    const spec = RESOURCES[name];
    if (!spec) continue;
    try {
      const rows: Array<Record<string, unknown>> = [];
      const locales: Array<string | null> = spec.perLocale ? [...params.locales] : [null];
      for (const locale of locales) {
        const parts = [spec.query(params), ...(locale ? [`filter%5Blocale%5D=${encodeURIComponent(locale)}`] : [])].filter(Boolean);
        const suffix = parts.length ? `?${parts.join("&")}` : "";
        const response = await ascGet(`/v1/apps/${appId}/${spec.segment}${suffix}`, token, fetchImpl);
        for (const entry of asArray(response.data)) {
          rows.push({ id: entry.id, type: entry.type, ...(locale ? { locale } : {}), ...(entry.attributes ?? {}) });
        }
      }
      resources[name] = { available: true, count: rows.length, rows };
    } catch (error) {
      // A resource this key or app cannot serve is recorded as unavailable, not
      // as an empty list: "no experiments" and "cannot read experiments" are
      // different answers and must not render the same.
      const message = error instanceof Error ? error.message : String(error);
      resources[name] = { available: false, count: null, rows: [], error: message };
      notes.push(`${name} could not be read (${message.split(".")[0]}), so it is unknown rather than empty.`);
    }
  }

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

function asArray(data: unknown): Array<{ type: string; id: string; attributes?: Record<string, unknown> }> {
  if (!data) return [];
  return (Array.isArray(data) ? data : [data]) as Array<{ type: string; id: string; attributes?: Record<string, unknown> }>;
}
