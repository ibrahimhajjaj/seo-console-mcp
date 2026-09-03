import { auth as googleAuth } from "@googleapis/searchconsole";
import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { playVitalsInput } from "./schemas.js";
import { USER_AGENT } from "./version.js";

type VitalsParams = z.output<typeof playVitalsInput>;

interface VitalsDeps {
  fetchImpl?: typeof fetch;
  accessToken?: string;
  now?: Date;
}

const API = "https://playdeveloperreporting.googleapis.com/v1beta1";
const SCOPE = "https://www.googleapis.com/auth/playdeveloperreporting";
const REQUEST_TIMEOUT_MS = 30_000;

// Each metric set names its own metrics; asking a set for a metric it does not
// have is a 400, so the pairing is fixed here rather than left to the caller.
const METRIC_SETS = {
  crashRate: { path: "crashRateMetricSet", metrics: ["crashRate", "distinctUsers"] },
  anrRate: { path: "anrRateMetricSet", metrics: ["anrRate", "distinctUsers"] },
  errorCount: { path: "errorCountMetricSet", metrics: ["errorReportCount", "distinctUsers"] },
  slowStartRate: { path: "slowStartRateMetricSet", metrics: ["slowStartRate", "distinctUsers"] },
  excessiveWakeupRate: { path: "excessiveWakeupRateMetricSet", metrics: ["excessiveWakeupRate", "distinctUsers"] },
} as const;

export async function playVitals(params: VitalsParams, deps: VitalsDeps = {}): Promise<ToolResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = deps.accessToken ?? (await accessToken());
  const now = deps.now ?? new Date();
  const notes: string[] = [];
  const results: Record<string, unknown> = {};

  for (const name of params.metricSets) {
    const set = METRIC_SETS[name];
    try {
      // freshnessInfo says how current the data actually is, which is the only
      // way to tell "nothing happened yesterday" from "yesterday is not in yet".
      const meta = await request(`${API}/apps/${params.packageName}/${set.path}`, { method: "GET" }, token, fetchImpl);
      const freshness = (meta as { freshnessInfo?: { freshnesses?: Array<{ aggregationPeriod?: string; latestEndTime?: Record<string, number> }> } }).freshnessInfo;
      const latest = freshness?.freshnesses?.find((entry) => entry.aggregationPeriod === params.aggregationPeriod);
      if (!latest) notes.push(`${name} reported no freshness for ${params.aggregationPeriod}, so the window was not clamped.`);

      // The API refuses an end date past its own freshness, so the window has
      // to be clamped to what it actually holds rather than to today.
      const freshEnd = latest?.latestEndTime ? isoFromApiTime(latest.latestEndTime) : null;
      const requestedEnd = asApiTime(now);
      const endTime = freshEnd ? asApiTime(new Date(`${freshEnd}T00:00:00Z`)) : requestedEnd;
      if (freshEnd && freshEnd < isoFromApiTime(requestedEnd)!) {
        notes.push(`${name} is fresh only through ${freshEnd}, so the window ends there rather than today.`);
      }
      const body = {
        timelineSpec: {
          aggregationPeriod: params.aggregationPeriod,
          startTime: asApiTime(shiftDays(now, -params.days)),
          endTime,
        },
        metrics: [...set.metrics],
        ...(params.dimensions.length ? { dimensions: [...params.dimensions] } : {}),
        pageSize: params.pageSize,
      };
      const queried = await request(`${API}/apps/${params.packageName}/${set.path}:query`, {
        method: "POST",
        body: JSON.stringify(body),
      }, token, fetchImpl);

      const rows = ((queried as { rows?: Array<Record<string, unknown>> }).rows ?? []).map((row) => ({
        startTime: row.startTime ?? null,
        dimensions: row.dimensions ?? [],
        metrics: row.metrics ?? [],
      }));
      results[name] = {
        available: true,
        rowCount: rows.length,
        latestDataAt: latest?.latestEndTime ? isoFromApiTime(latest.latestEndTime) : null,
        rows,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results[name] = { available: false, rowCount: null, latestDataAt: null, rows: [], error: message };
      notes.push(`${name} could not be read (${message.split(".")[0]}), so it is unknown rather than zero.`);
    }
  }

  const structuredContent = {
    packageName: params.packageName,
    aggregationPeriod: params.aggregationPeriod,
    days: params.days,
    metricSets: results,
    notes: [
      ...notes,
      "These are Android vitals. This API carries no acquisition or conversion data; use play_store_stats for that.",
    ],
  };

  const lines = [`Android vitals for ${params.packageName} over the last ${params.days} day(s), ${params.aggregationPeriod}`];
  for (const name of params.metricSets) {
    const entry = results[name] as { available: boolean; rowCount: number | null; latestDataAt: string | null };
    lines.push(entry.available
      ? `- ${name}: ${entry.rowCount} row(s), data through ${entry.latestDataAt ?? "unknown"}`
      : `- ${name}: unavailable`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent };
}

async function accessToken(): Promise<string> {
  const keyFile = process.env.SEO_MCP_PLAY_CREDENTIALS ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const auth = new googleAuth.GoogleAuth({ ...(keyFile ? { keyFile } : {}), scopes: [SCOPE] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw new Error("Could not obtain a Play Developer Reporting token. Set SEO_MCP_PLAY_CREDENTIALS to a service account linked in Play Console with report access.");
  }
  return token.token;
}

async function request(url: string, init: RequestInit, token: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 403 || response.status === 401) {
    throw new Error(`Play Developer Reporting rejected the credentials (HTTP ${response.status}). The service account must be invited in Play Console with permission to view app quality.`);
  }
  if (!response.ok) {
    // Carry the API's own message through: it names the actual problem, and
    // hiding it turns a fixable request into an opaque failure.
    const detail = await response.text().then(
      (body) => { try { return (JSON.parse(body).error?.message as string) ?? ""; } catch { return body.slice(0, 200); } },
      () => "",
    );
    throw new Error(`Play Developer Reporting returned HTTP ${response.status} for ${url.split("?")[0]?.replace(API, "")}${detail ? `: ${detail}` : "."}`);
  }
  return response.json();
}

function shiftDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function asApiTime(date: Date): Record<string, number> {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function isoFromApiTime(time: Record<string, number>): string | null {
  if (time.year === undefined || time.month === undefined || time.day === undefined) return null;
  return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}
