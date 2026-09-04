import { readFileSync } from "node:fs";
import { createPrivateKey, sign as signWithKey } from "node:crypto";
import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { appStoreListingInput } from "./schemas.js";
import { USER_AGENT } from "./version.js";

type AppStoreListingParams = z.output<typeof appStoreListingInput>;

export interface AscCredentials {
  keyId: string;
  issuerId?: string | undefined;
  privateKey: string;
}

interface AscDeps {
  fetchImpl?: typeof fetch;
  credentials?: AscCredentials;
  now?: Date;
}

// Apple indexes the app name, the subtitle and the keyword field. It does not
// index the description, so its length is reported but never scored. A field one
// character over its limit is dropped silently rather than rejected, which is why
// every field is reported against its limit. Lengths are UTF-16 code units, which
// is what NSString and the App Store Connect UI count.
const LIMITS = { name: 30, subtitle: 30, keywords: 100, promotionalText: 170, description: 4000, whatsNew: 4000 } as const;

// An app can hold a live record and an editable one at the same time. Selecting
// the wrong one reports draft copy as if it were live, so the choice is explicit.
const LIVE_STATES = new Set(["READY_FOR_DISTRIBUTION", "READY_FOR_SALE"]);

// A record actually being worked on. This has to be an explicit list rather than
// "not live": a superseded version carries REPLACED_WITH_NEW_VERSION, so negating
// the live set would make any app that has shipped twice look like it always has
// a draft in preparation.
const IN_PROGRESS_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "PENDING_DEVELOPER_RELEASE",
  "PENDING_APPLE_RELEASE",
  "PROCESSING_FOR_DISTRIBUTION",
  "PROCESSING_FOR_APP_STORE",
  "WAITING_FOR_EXPORT_COMPLIANCE",
  "ACCEPTED",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);

function isLiveState(state: string | undefined): boolean {
  return Boolean(state && LIVE_STATES.has(state));
}

// An unreadable state is neither, so a missing attribute never reads as a draft.
function isInProgressState(state: string | undefined): boolean {
  return Boolean(state && IN_PROGRESS_STATES.has(state));
}

const API = "https://api.appstoreconnect.apple.com";
const REQUEST_TIMEOUT_MS = 20_000;
const PUBLIC_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 50;

export interface JsonApiResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id?: string; type?: string } | Array<{ id?: string; type?: string }> }>;
}

export interface JsonApiResponse {
  data?: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
  links?: { next?: string };
}

export async function appStoreListing(params: AppStoreListingParams, deps: AscDeps = {}): Promise<ToolResult> {
  if (!params.appId && !params.bundleId) {
    throw new Error("Provide appId or bundleId to identify the app.");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const credentials = deps.credentials ?? readCredentialsFromEnv();
  const token = createAscToken(credentials, deps.now ?? new Date());
  const notes: string[] = [];

  const appId = params.appId ?? (await resolveAppId(params.bundleId as string, token, fetchImpl));

  // Pick the record first, then read only that record's localizations. Reading
  // an `include=` bundle would mix the live and editable copies together.
  const versionQuery = `/v1/apps/${appId}/appStoreVersions?limit=${PAGE_LIMIT}&filter%5Bplatform%5D=${encodeURIComponent(params.platform)}&include=appStoreVersionPhasedRelease`;
  // Neither list is derived from the other; only the localization reads below
  // need the ids these two settle on.
  const [infos, versions] = await Promise.all([
    ascGet(`/v1/apps/${appId}/appInfos?limit=${PAGE_LIMIT}&include=primaryCategory,secondaryCategory,ageRatingDeclaration`, token, fetchImpl),
    ascGet(versionQuery, token, fetchImpl),
  ]);

  const infoResources = asArray(infos.data);
  const info = pickByState(infoResources, params.state);
  if (!info) throw new Error(`No app info record found for app ${appId}.`);
  if (info.fellBack) notes.push(`No ${params.state} app info exists; reported the ${describeState(info.state)} record instead.`);

  const versionResources = asArray(versions.data);
  const version = pickByState(versionResources, params.state);
  if (version?.fellBack) notes.push(`No ${params.state} ${params.platform} version exists; reported the ${describeState(version.state)} version instead.`);
  if (!version) notes.push(`No ${params.platform} app store version was returned, so keywords, promotional text and description are unavailable.`);

  const infoLocalizations = await ascGet(`/v1/appInfos/${info.resource.id}/appInfoLocalizations?limit=${PAGE_LIMIT}`, token, fetchImpl);
  const versionLocalizations = version
    ? await ascGet(`/v1/appStoreVersions/${version.resource.id}/appStoreVersionLocalizations?limit=${PAGE_LIMIT}&include=appScreenshotSets,appPreviewSets`, token, fetchImpl)
    : { data: [] };

  interface LocaleFields {
    name?: string | undefined;
    subtitle?: string | undefined;
    keywords?: string | undefined;
    promotionalText?: string | undefined;
    description?: string | undefined;
    whatsNew?: string | undefined;
    fromInfo?: boolean;
    fromVersion?: boolean;
  }
  const byLocale = new Map<string, LocaleFields>();
  for (const resource of asArray(infoLocalizations.data)) {
    const locale = resource.attributes?.locale as string | undefined;
    if (!locale) continue;
    const entry = byLocale.get(locale) ?? {};
    entry.name = resource.attributes?.name as string | undefined;
    entry.subtitle = resource.attributes?.subtitle as string | undefined;
    entry.fromInfo = true;
    byLocale.set(locale, entry);
  }
  for (const resource of asArray(versionLocalizations.data)) {
    const locale = resource.attributes?.locale as string | undefined;
    if (!locale) continue;
    const entry = byLocale.get(locale) ?? {};
    entry.keywords = resource.attributes?.keywords as string | undefined;
    entry.promotionalText = resource.attributes?.promotionalText as string | undefined;
    entry.description = resource.attributes?.description as string | undefined;
    entry.whatsNew = resource.attributes?.whatsNew as string | undefined;
    entry.fromVersion = true;
    byLocale.set(locale, entry);
  }

  // The linkage lives on the localization, not on the set: a set carries no
  // back-reference to the locale it belongs to. A locale with no sets falls back
  // to another locale's screenshots in the store, so an empty list is a finding.
  const includedById = new Map((versionLocalizations.included ?? []).map((resource) => [resource.id, resource]));
  const assetsByLocale = new Map<string, { screenshotSets: string[]; previewSets: string[] }>();
  for (const resource of asArray(versionLocalizations.data)) {
    const locale = resource.attributes?.locale as string | undefined;
    if (!locale) continue;
    const displayTypes = (name: string): string[] => {
      const linked = resource.relationships?.[name]?.data;
      const entries = Array.isArray(linked) ? linked : linked ? [linked] : [];
      return entries.map((entry) => {
        const set = entry.id ? includedById.get(entry.id) : undefined;
        return (set?.attributes?.screenshotDisplayType as string | undefined) ?? (set?.attributes?.previewType as string | undefined) ?? entry.id ?? "unknown";
      });
    };
    assetsByLocale.set(locale, { screenshotSets: displayTypes("appScreenshotSets"), previewSets: displayTypes("appPreviewSets") });
  }

  const categories = readCategories(infos, info.resource);
  const ageRating = readAgeRating(infos, info.resource);
  const phasedRelease = readPhasedRelease(versions, version?.resource);

  const locales = [...byLocale.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([locale, entry]) => ({
      locale,
      indexed: {
        name: measure(entry.name, LIMITS.name),
        subtitle: measure(entry.subtitle, LIMITS.subtitle),
        keywords: measure(entry.keywords, LIMITS.keywords),
      },
      promotionalText: measure(entry.promotionalText, LIMITS.promotionalText),
      description: measure(entry.description, LIMITS.description),
      whatsNew: measure(entry.whatsNew, LIMITS.whatsNew),
      screenshotSets: assetsByLocale.get(locale)?.screenshotSets ?? [],
      previewSets: assetsByLocale.get(locale)?.previewSets ?? [],
      partial: !(entry.fromInfo && entry.fromVersion),
    }));

  const withoutScreenshots = locales.filter((entry) => entry.screenshotSets.length === 0).map((entry) => entry.locale);
  if (withoutScreenshots.length && withoutScreenshots.length < locales.length) {
    notes.push(`These locales have no screenshots of their own and fall back to another locale's: ${withoutScreenshots.join(", ")}.`);
  }

  const partialLocales = locales.filter((entry) => entry.partial).map((entry) => entry.locale);
  if (partialLocales.length) {
    notes.push(`Some locales are present in only one record, so their missing fields are unknown rather than empty: ${partialLocales.join(", ")}.`);
  }

  const ratings = await lookupRatings(appId, params.storefronts, fetchImpl, notes);
  if (ratings.length) {
    notes.push(
      "Ratings come from the public App Store storefront lookup, not from App Store Connect, whose API exposes no aggregate rating at all. Every other field here is read from App Store Connect, so the two sit side by side from different sources.",
    );
  }
  const overLimit = locales.flatMap((entry) => [
    ...(entry.indexed.name.overLimit ? [`${entry.locale} name`] : []),
    ...(entry.indexed.subtitle.overLimit ? [`${entry.locale} subtitle`] : []),
    ...(entry.indexed.keywords.overLimit ? [`${entry.locale} keywords`] : []),
    ...(entry.promotionalText.overLimit ? [`${entry.locale} promotionalText`] : []),
    ...(entry.description.overLimit ? [`${entry.locale} description`] : []),
  ]);

  // Whether the other record exists is derivable from the lists already fetched,
  // so a caller can tell "no draft prepared" from "a draft exists" without a
  // second call and without reading the prose notes.
  const bothLists = [...infoResources, ...versionResources];
  const hasLiveRecord = bothLists.some((resource) => isLiveState(stateOf(resource)));
  const hasEditableRecord = bothLists.some((resource) => isInProgressState(stateOf(resource)));

  const structuredContent = {
    appId,
    bundleId: params.bundleId ?? null,
    platform: params.platform,
    requestedState: params.state,
    fellBack: Boolean(info.fellBack || version?.fellBack),
    hasLiveRecord,
    hasEditableRecord,
    appInfoState: info.state ?? null,
    categories,
    ageRating,
    phasedRelease,
    versionState: version?.state ?? null,
    versionString: (version?.resource.attributes?.versionString as string | undefined) ?? null,
    localeCount: locales.length,
    locales,
    ratings,
    overLimit,
    notes,
  };

  return { content: [{ type: "text", text: formatListing(structuredContent) }], structuredContent };
}

// The signing key never leaves this process; only the short-lived token is sent,
// and neither is ever put in output or an error. Team keys carry an issuer id;
// individual keys have none and identify themselves with sub: "user" instead.
export function createAscToken(credentials: AscCredentials, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = { alg: "ES256", kid: credentials.keyId, typ: "JWT" };
  const payload = {
    ...(credentials.issuerId ? { iss: credentials.issuerId } : { sub: "user" }),
    iat: issuedAt,
    exp: issuedAt + 600,
    aud: "appstoreconnect-v1",
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  // ES256 needs the raw r||s signature, not the DER form Node produces by default.
  const signature = signWithKey("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(credentials.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

export function readCredentialsFromEnv(): AscCredentials {
  const keyPath = process.env.SEO_MCP_ASC_KEY_PATH;
  const keyId = process.env.SEO_MCP_ASC_KEY_ID;
  const issuerId = process.env.SEO_MCP_ASC_ISSUER_ID;
  if (!keyPath || !keyId) {
    throw new Error(
      "App Store Connect credentials are required. Set SEO_MCP_ASC_KEY_PATH to the .p8 private key and SEO_MCP_ASC_KEY_ID to its key id, plus SEO_MCP_ASC_ISSUER_ID for a team key (individual keys have no issuer id). A team key reaches every app on the team; what limits it is its role, and a role cannot be changed after the key is created.",
    );
  }
  let privateKey: string;
  try {
    privateKey = readFileSync(keyPath, "utf8");
  } catch {
    throw new Error("Could not read the App Store Connect private key named by SEO_MCP_ASC_KEY_PATH. Key contents are never logged.");
  }
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new Error("The file named by SEO_MCP_ASC_KEY_PATH is not a readable PKCS8 private key; App Store Connect issues these as a .p8 file.");
  }
  return { keyId, privateKey, ...(issuerId ? { issuerId } : {}) };
}

function pickByState(resources: JsonApiResource[], want: "live" | "editable"): { resource: JsonApiResource; state: string | undefined; fellBack: boolean } | undefined {
  if (resources.length === 0) return undefined;
  const described = resources.map((resource) => ({ resource, state: stateOf(resource) }));
  const live = described.find((entry) => isLiveState(entry.state));
  const editable = described.find((entry) => isInProgressState(entry.state));
  const preferred = want === "live" ? live : editable;
  const fallback = want === "live" ? editable : live;
  const chosen = preferred ?? fallback;
  if (!chosen) return undefined;
  return { ...chosen, fellBack: !preferred };
}

// appVersionState and state are the current attributes; appStoreState is the
// deprecated spelling still returned by older API versions.
function stateOf(resource: JsonApiResource): string | undefined {
  const attributes = resource.attributes ?? {};
  for (const key of ["appVersionState", "state", "appStoreState"]) {
    const value = attributes[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function relatedId(resource: JsonApiResource | undefined, name: string): string | null {
  const data = resource?.relationships?.[name]?.data;
  const id = Array.isArray(data) ? data[0]?.id : data?.id;
  return id ?? null;
}

function findIncluded(response: JsonApiResponse, id: string | null): JsonApiResource | undefined {
  if (!id) return undefined;
  return (response.included ?? []).find((resource) => resource.id === id);
}

// The category a listing sits in is an ASO lever, and it is only visible here as
// a relationship rather than an attribute.
function readCategories(response: JsonApiResponse, info: JsonApiResource): { primary: string | null; secondary: string | null } {
  const primary = findIncluded(response, relatedId(info, "primaryCategory"));
  const secondary = findIncluded(response, relatedId(info, "secondaryCategory"));
  return {
    primary: (primary?.id as string | undefined) ?? null,
    secondary: (secondary?.id as string | undefined) ?? null,
  };
}

function readAgeRating(response: JsonApiResponse, info: JsonApiResource): Record<string, unknown> | null {
  const declaration = findIncluded(response, relatedId(info, "ageRatingDeclaration"));
  return declaration?.attributes ?? null;
}

function readPhasedRelease(response: JsonApiResponse, version: JsonApiResource | undefined): Record<string, unknown> | null {
  if (!version) return null;
  const phased = findIncluded(response, relatedId(version, "appStoreVersionPhasedRelease"));
  return phased?.attributes ?? null;
}

function describeState(state: string | undefined): string {
  return state ?? "unknown-state";
}

export async function resolveAppId(bundleId: string, token: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await ascGet(`/v1/apps?filter%5BbundleId%5D=${encodeURIComponent(bundleId)}&limit=1`, token, fetchImpl);
  const app = asArray(response.data)[0];
  if (!app) throw new Error(`No App Store Connect app found for bundle id "${bundleId}".`);
  return app.id;
}

export async function ascGet(path: string, token: string, fetchImpl: typeof fetch): Promise<JsonApiResponse> {
  const response = await fetchImpl(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`App Store Connect rejected the credentials (HTTP ${response.status}). Check the key id, the issuer id if this is a team key, and that the key has access to this app.`);
  }
  if (!response.ok) {
    throw new Error(`App Store Connect returned HTTP ${response.status} for ${path.split("?")[0]}.`);
  }
  return (await response.json()) as JsonApiResponse;
}

const RATINGS_SOURCE = "itunes-lookup";

async function lookupRatings(
  appId: string,
  storefronts: string[],
  fetchImpl: typeof fetch,
  notes: string[],
): Promise<Array<{ storefront: string; source: string; averageUserRating: number | null; userRatingCount: number | null }>> {
  // Every entry carries its source. App Store Connect has no aggregate rating
  // resource at all, only age ratings, so the star rating has to come from the
  // public storefront lookup instead. That is a different pipeline reporting a
  // number that looks identical, and a caller holding both a listing and a
  // rating would otherwise have no way to tell they were read from two places.
  return Promise.all(
    storefronts.map(async (storefront) => {
      const empty = { storefront, source: RATINGS_SOURCE, averageUserRating: null, userRatingCount: null };
      try {
        const response = await fetchImpl(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(storefront)}`, {
          headers: { "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS),
        });
        if (!response.ok) {
          notes.push(`The ratings lookup for ${storefront} failed with HTTP ${response.status}, so its ratings are unknown rather than absent.`);
          return empty;
        }
        const body = (await response.json()) as { results?: Array<Record<string, unknown>> };
        const entry = body.results?.[0];
        if (!entry) return empty;
        return {
          storefront,
          source: RATINGS_SOURCE,
          averageUserRating: typeof entry.averageUserRating === "number" ? entry.averageUserRating : null,
          userRatingCount: typeof entry.userRatingCount === "number" ? entry.userRatingCount : null,
        };
      } catch {
        notes.push(`The ratings lookup for ${storefront} could not be completed, so its ratings are unknown rather than absent.`);
        return empty;
      }
    }),
  );
}

function measure(text: string | undefined, limit: number) {
  const value = text ?? null;
  const length = value === null ? 0 : value.length;
  return { text: value, length, limit, overLimit: length > limit };
}

export function asArray(data: JsonApiResponse["data"]): JsonApiResource[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

type Measured = ReturnType<typeof measure>;

function formatListing(listing: {
  appId: string;
  platform: string;
  requestedState: string;
  appInfoState: string | null;
  versionState: string | null;
  versionString: string | null;
  localeCount: number;
  locales: Array<{ locale: string; indexed: { name: Measured; subtitle: Measured; keywords: Measured }; promotionalText: Measured; partial: boolean }>;
  ratings: Array<{ storefront: string; source: string; averageUserRating: number | null; userRatingCount: number | null }>;
  overLimit: string[];
  notes: string[];
}): string {
  const lines = [
    `App Store listing for app ${listing.appId} (${listing.platform}, requested the ${listing.requestedState} record)`,
    `App info state ${listing.appInfoState ?? "unknown"}; version ${listing.versionString ?? "unknown"} state ${listing.versionState ?? "unknown"}`,
    `${listing.localeCount} locale(s). Apple indexes name, subtitle and keywords only; the description is not indexed.`,
  ];
  for (const entry of listing.locales.slice(0, 10)) {
    lines.push(
      `- ${entry.locale}${entry.partial ? " (partial)" : ""}: name ${entry.indexed.name.length}/${entry.indexed.name.limit}, subtitle ${entry.indexed.subtitle.length}/${entry.indexed.subtitle.limit}, keywords ${entry.indexed.keywords.length}/${entry.indexed.keywords.limit}, promo ${entry.promotionalText.length}/${entry.promotionalText.limit}`,
    );
  }
  if (listing.locales.length > 10) lines.push(`- ...and ${listing.locales.length - 10} more locale(s)`);
  lines.push(listing.overLimit.length ? `Over limit (Apple drops these silently): ${listing.overLimit.join(", ")}` : "No field is over its character limit.");
  lines.push("promotionalText is the only field above that can be changed on a live version without a review.");
  for (const rating of listing.ratings) {
    lines.push(`Ratings (${rating.storefront}, via ${rating.source}): ${rating.averageUserRating ?? "none"} from ${rating.userRatingCount ?? 0} rating(s)`);
  }
  lines.push(...listing.notes.map((note) => `Note: ${note}`));
  return lines.join("\n");
}
