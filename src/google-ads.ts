import { readFileSync } from "node:fs";
import { USER_AGENT } from "./version.js";

// Google Ads is the one surface here that spends money. Everything in this file
// is built so a caller cannot reach a mutation without having seen what it would
// change, and cannot believe a mutation landed without the value being read back.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_HOST = "https://googleads.googleapis.com";
const DEFAULT_API_VERSION = "v25";
const REQUEST_TIMEOUT_MS = 30_000;

export interface AdsCredentials {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  apiVersion: string;
}

export interface AdsDeps {
  fetchImpl?: typeof fetch;
  credentials?: AdsCredentials;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

// GAQL has only three DURING literals for trailing windows, LAST_7_DAYS,
// LAST_14_DAYS and LAST_30_DAYS, and any other number is rejected as an invalid
// argument rather than as an unknown literal. An explicit range honours whatever
// window was actually asked for.
export function dateRange(days: number, now: Date): { startDate: string; endDate: string } {
  const end = new Date(now.getTime());
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

export function duringWindow(days: number, now: Date): string {
  const { startDate, endDate } = dateRange(days, now);
  return `segments.date BETWEEN '${startDate}' AND '${endDate}'`;
}

// A .env-shaped file, so a refresh token that already lives somewhere can be
// read in place. Duplicating a secret to save a path lookup is how it ends up in
// two places and gets rotated in one.
function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Could not read the file named by GOOGLE_ADS_ENV_FILE. Contents are never logged.`);
  }
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function resolveAdsCredentials(env: NodeJS.ProcessEnv = process.env): AdsCredentials {
  // An explicit file is read first and the process environment wins over it, so
  // a one-off override does not mean editing a shared file.
  const fromFile = env.GOOGLE_ADS_ENV_FILE ? readEnvFile(env.GOOGLE_ADS_ENV_FILE) : {};
  const read = (name: string): string | undefined => env[name] ?? fromFile[name];

  let clientId = read("GOOGLE_ADS_CLIENT_ID");
  let clientSecret = read("GOOGLE_ADS_CLIENT_SECRET");
  // An OAuth client downloaded from Google Cloud is a JSON file, so accept it
  // rather than making someone unpack two fields out of it by hand.
  const secretPath = read("GOOGLE_ADS_CLIENT_SECRET_PATH");
  if (secretPath && (!clientId || !clientSecret)) {
    let parsed: { installed?: { client_id?: string; client_secret?: string }; web?: { client_id?: string; client_secret?: string } };
    try {
      parsed = JSON.parse(readFileSync(secretPath, "utf8"));
    } catch {
      throw new Error("Could not read the OAuth client named by GOOGLE_ADS_CLIENT_SECRET_PATH. Contents are never logged.");
    }
    const block = parsed.installed ?? parsed.web;
    clientId ??= block?.client_id;
    clientSecret ??= block?.client_secret;
  }

  const developerToken = read("GOOGLE_ADS_DEVELOPER_TOKEN");
  const refreshToken = read("GOOGLE_ADS_REFRESH_TOKEN");
  // Google writes the account number with dashes and the API path takes it
  // without, so accept either rather than failing on a copy and paste.
  const customerId = read("GOOGLE_ADS_CUSTOMER_ID")?.replace(/-/g, "");

  const missing = [
    ["GOOGLE_ADS_DEVELOPER_TOKEN", developerToken],
    ["GOOGLE_ADS_CLIENT_ID", clientId],
    ["GOOGLE_ADS_CLIENT_SECRET", clientSecret],
    ["GOOGLE_ADS_REFRESH_TOKEN", refreshToken],
    ["GOOGLE_ADS_CUSTOMER_ID", customerId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `Google Ads credentials are incomplete. Missing: ${missing.join(", ")}. Set them in the environment, or point GOOGLE_ADS_ENV_FILE at a file that holds them and GOOGLE_ADS_CLIENT_SECRET_PATH at the OAuth client JSON. A server reads its environment once at startup, so if you have just set these, restart it.`,
    );
  }
  if (!/^\d+$/.test(customerId as string)) {
    throw new Error("GOOGLE_ADS_CUSTOMER_ID must be the account number, digits only, with or without dashes.");
  }

  return {
    developerToken: developerToken as string,
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    refreshToken: refreshToken as string,
    customerId: customerId as string,
    apiVersion: read("GOOGLE_ADS_API_VERSION") ?? DEFAULT_API_VERSION,
  };
}

// A GAQL string literal, escaped. The prototype this came from stripped quotes
// instead, which silently changed the thing being searched for: a keyword with
// an apostrophe matched nothing rather than failing, and "exactly one match or
// refuse" cannot protect a caller whose target was rewritten on the way in.
export function quoteGaql(value: string): string {
  if (/[\u0000-\u001f]/.test(value)) {
    throw new Error("A GAQL value cannot contain control characters or newlines.");
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export interface AdsClient {
  customerId: string;
  gaql(query: string): Promise<Array<Record<string, any>>>;
  mutate(service: string, operations: unknown[]): Promise<unknown>;
}

export function createAdsClient(credentials: AdsCredentials, fetchImpl: typeof fetch = fetch): AdsClient {
  // One token per client, because a single tool call makes several requests and
  // refreshing per request would spend quota on nothing.
  let cached: Promise<string> | undefined;

  async function accessToken(): Promise<string> {
    cached ??= (async () => {
      const response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as { access_token?: string; error_description?: string; error?: string } | null;
      if (!response.ok || !body?.access_token) {
        // The description names the actual problem, an expired grant or a
        // revoked client, and neither the token nor the secret is in it.
        throw new Error(`Google Ads rejected the refresh token (HTTP ${response.status})${body?.error_description ? `: ${body.error_description}` : "."} Credentials are never logged.`);
      }
      return body.access_token;
    })();
    try {
      return await cached;
    } catch (error) {
      // A failed refresh must not be remembered, or every later call in the
      // same tool invocation reports the first failure instead of retrying.
      cached = undefined;
      throw error;
    }
  }

  async function call(path: string, payload: unknown): Promise<any> {
    const token = await accessToken();
    const response = await fetchImpl(`${API_HOST}/${credentials.apiVersion}/customers/${credentials.customerId}/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "developer-token": credentials.developerToken,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      // Google returns its real message inside an array for searchStream and at
      // the top level for mutate, and the message is the whole diagnostic value.
      const detail = body?.[0]?.error?.message ?? body?.error?.message ?? (typeof body === "string" ? body : "");
      throw new Error(`Google Ads returned HTTP ${response.status} for ${path}${detail ? `: ${detail}` : "."}`);
    }
    return body;
  }

  return {
    customerId: credentials.customerId,
    async gaql(query) {
      const body = await call("googleAds:searchStream", { query });
      return (Array.isArray(body) ? body : []).flatMap((chunk: { results?: Array<Record<string, unknown>> }) => chunk.results ?? []);
    },
    mutate(service, operations) {
      return call(`${service}:mutate`, { operations });
    },
  };
}

// For METRICS this is right: Google omits a metric that is zero, so an absent
// impression count really is zero impressions.
export const money = (micros: unknown): number => Number(micros ?? 0) / 1e6;

// For SETTINGS it is not. A keyword under an automated bidding strategy has no
// CPC bid at all and Google omits the field, so coercing it to zero reports a
// bid of $0.00 for something that has no bid. That is an absence dressed as a
// finding, and worse, a guard written as `before > 0 && after > before * 3`
// silently stops firing when before is unknown.
export const moneyOrNull = (micros: unknown): number | null => (micros === undefined || micros === null || micros === "" ? null : Number(micros) / 1e6);
export const toMicros = (dollars: number): string => String(Math.round(dollars * 1e6));
