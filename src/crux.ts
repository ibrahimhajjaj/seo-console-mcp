import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { cruxFieldDataInput, cruxHistoryInput } from "./schemas.js";
import { USER_AGENT } from "./version.js";

type FieldDataParams = z.output<typeof cruxFieldDataInput>;
type HistoryParams = z.output<typeof cruxHistoryInput>;

interface CruxDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

const API = "https://chromeuxreport.googleapis.com/v1/records";
const REQUEST_TIMEOUT_MS = 20_000;

interface CruxDate {
  year?: number;
  month?: number;
  day?: number;
}

interface CruxMetric {
  histogram?: Array<{ start?: unknown; end?: unknown; density?: number }>;
  percentiles?: { p75?: unknown };
  histogramTimeseries?: Array<{ start?: unknown; end?: unknown; densities?: Array<number | string> }>;
  percentilesTimeseries?: { p75s?: Array<number | string | null> };
  fractions?: Record<string, number>;
}

interface CruxResponse {
  record?: {
    key?: Record<string, string>;
    metrics?: Record<string, CruxMetric>;
    collectionPeriod?: { firstDate?: CruxDate; lastDate?: CruxDate };
    collectionPeriods?: Array<{ firstDate?: CruxDate; lastDate?: CruxDate }>;
  };
  urlNormalizationDetails?: { originalUrl?: string; normalizedUrl?: string };
  error?: { code?: number; status?: string; message?: string };
}

export async function cruxFieldData(params: FieldDataParams, deps: CruxDeps = {}): Promise<ToolResult> {
  requireOneTarget(params);
  const outcome = await queryCrux("queryRecord", body(params), deps);
  if (!outcome.hasData) return noData(params, "There is no Chrome UX Report data for this origin or URL.");

  const record = outcome.response.record ?? {};
  const metrics = Object.fromEntries(Object.entries(record.metrics ?? {}).map(([name, metric]) => [name, {
    p75: numberOrNull(metric.percentiles?.p75),
    histogram: (metric.histogram ?? []).map((bin) => ({
      start: numberOrNull(bin.start),
      end: bin.end === undefined ? null : numberOrNull(bin.end),
      density: typeof bin.density === "number" ? bin.density : null,
    })),
  }]));

  const structuredContent = {
    ...target(params),
    formFactor: params.formFactor ?? null,
    hasData: true,
    source: "field_crux_daily",
    collectionPeriod: {
      firstDate: isoDate(record.collectionPeriod?.firstDate),
      lastDate: isoDate(record.collectionPeriod?.lastDate),
    },
    normalizedUrl: outcome.response.urlNormalizationDetails?.normalizedUrl ?? null,
    metrics,
    notes: [] as string[],
  };

  const lines = [
    `Field data for ${describeTarget(params)}${params.formFactor ? ` on ${params.formFactor}` : ""}`,
    `28-day window ending ${structuredContent.collectionPeriod.lastDate ?? "unknown"}`,
    ...Object.entries(metrics).map(([name, metric]) => `- ${name}: p75 ${metric.p75 ?? "unknown"}`),
    "These are real-user measurements, not a lab test. Use pagespeed for Lighthouse audits.",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent };
}

export async function cruxHistory(params: HistoryParams, deps: CruxDeps = {}): Promise<ToolResult> {
  requireOneTarget(params);
  const request = { ...body(params), ...(params.collectionPeriodCount ? { collectionPeriodCount: params.collectionPeriodCount } : {}) };
  const outcome = await queryCrux("queryHistoryRecord", request, deps);
  if (!outcome.hasData) return noData(params, "There is no Chrome UX Report history for this origin or URL.");

  const record = outcome.response.record ?? {};
  const periods = (record.collectionPeriods ?? []).map((period) => ({
    firstDate: isoDate(period.firstDate),
    lastDate: isoDate(period.lastDate),
  }));
  // A period with too few samples returns "NaN" densities and null p75s rather
  // than being dropped, so the arrays stay aligned with collectionPeriods. Keep
  // that alignment and represent the gaps as null rather than as zero.
  const metrics = Object.fromEntries(Object.entries(record.metrics ?? {}).map(([name, metric]) => [name, {
    p75s: (metric.percentilesTimeseries?.p75s ?? []).map(numberOrNull),
  }]));

  const structuredContent = {
    ...target(params),
    formFactor: params.formFactor ?? null,
    hasData: true,
    source: "field_crux_history",
    // Weekly collection periods, each a 28-day rolling window, so consecutive
    // periods overlap by three weeks and are not independent samples.
    periodCount: periods.length,
    collectionPeriods: periods,
    normalizedUrl: outcome.response.urlNormalizationDetails?.normalizedUrl ?? null,
    metrics,
    notes: ["Each period is a 28-day rolling window stepped weekly, so consecutive points overlap by three weeks."],
  };

  const lines = [
    `Field data history for ${describeTarget(params)}${params.formFactor ? ` on ${params.formFactor}` : ""}`,
    `${periods.length} weekly period(s) from ${periods[0]?.firstDate ?? "unknown"} to ${periods[periods.length - 1]?.lastDate ?? "unknown"}`,
    ...Object.entries(metrics).map(([name, metric]) => {
      const values = metric.p75s.filter((value): value is number => value !== null);
      const first = values[0];
      const last = values[values.length - 1];
      return `- ${name}: p75 ${first ?? "unknown"} to ${last ?? "unknown"} across the series`;
    }),
    "Consecutive periods overlap by three weeks, so a single week-on-week move is not an independent change.",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent };
}

interface Outcome {
  hasData: boolean;
  response: CruxResponse;
}

async function queryCrux(method: string, request: Record<string, unknown>, deps: CruxDeps): Promise<Outcome> {
  const apiKey = deps.apiKey ?? process.env.SEO_MCP_CRUX_KEY ?? process.env.SEO_MCP_PAGESPEED_KEY;
  if (!apiKey) {
    throw new Error("A Google API key with the Chrome UX Report API enabled is required. Set SEO_MCP_CRUX_KEY, or SEO_MCP_PAGESPEED_KEY if the same key is allowed to call chromeuxreport.googleapis.com.");
  }
  const response = await (deps.fetchImpl ?? fetch)(`${API}:${method}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json()) as CruxResponse;

  // A 404 here means the origin or URL has too few anonymized samples, or is not
  // publicly indexable. That is an absence of data, not a failure, and must not
  // be reported as one or as zeros.
  if (response.status === 404) return { hasData: false, response: body };
  if (response.status === 403 || response.status === 401) {
    throw new Error(`The Chrome UX Report API rejected the key (HTTP ${response.status}). Enable the Chrome UX Report API on the key's project and allow it in the key's API restrictions.`);
  }
  if (!response.ok) {
    throw new Error(`The Chrome UX Report API returned HTTP ${response.status}${body.error?.status ? ` (${body.error.status})` : ""}.`);
  }
  return { hasData: true, response: body };
}

function noData(params: FieldDataParams | HistoryParams, message: string): ToolResult {
  const structuredContent = {
    ...target(params),
    formFactor: params.formFactor ?? null,
    hasData: false,
    source: "field_crux_daily",
    metrics: {},
    notes: [`${message} Chrome only publishes a record once an origin has enough anonymized samples, so this is an absence of data rather than a fault, and it is not zero.`],
  };
  return { content: [{ type: "text", text: structuredContent.notes[0] as string }], structuredContent };
}

// Neither target posts an empty body and earns an opaque 400; both silently
// measures the origin and quietly answers about a page the caller did not ask for.
function requireOneTarget(params: FieldDataParams | HistoryParams): void {
  if (Boolean(params.origin) === Boolean(params.url)) {
    throw new Error("Give exactly one of origin or url.");
  }
}

function body(params: FieldDataParams | HistoryParams): Record<string, unknown> {
  return {
    ...(params.origin ? { origin: params.origin } : { url: params.url }),
    ...(params.formFactor ? { formFactor: params.formFactor } : {}),
    ...(params.metrics && params.metrics.length ? { metrics: params.metrics } : {}),
  };
}

function target(params: FieldDataParams | HistoryParams): { origin: string | null; url: string | null } {
  return { origin: params.origin ?? null, url: params.url ?? null };
}

function describeTarget(params: FieldDataParams | HistoryParams): string {
  return params.origin ?? params.url ?? "unknown target";
}

function isoDate(date: CruxDate | undefined): string | null {
  if (!date || date.year === undefined || date.month === undefined || date.day === undefined) return null;
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

// The API returns "NaN" as a string for periods without enough samples.
function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
