import { writeFileSync } from "node:fs";
import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import { searchAnalytics } from "./google-tools.js";
import type { ToolContext } from "./registry.js";
import { appStoreListingInput, searchAnalyticsInput, playStoreStatsInput, snapshotInput, wporgPluginInput } from "./schemas.js";
import { appStoreListing } from "./app-store-listing.js";
import { playStoreStats } from "./play-store-stats.js";
import { wporgPlugin } from "./wporg.js";
import { formatToolError } from "./errors.js";

type SnapshotParams = z.output<typeof snapshotInput>;

export interface SnapshotDeps {
  now?: Date;
  concurrency?: number;
  surfaceTimeoutMs?: number;
  // Each surface reader is injectable so the whole document can be exercised
  // without credentials or network.
  readProperty?: (siteUrl: string, window: Window) => Promise<Record<string, unknown>>;
  readApp?: (app: string) => Promise<Record<string, unknown>>;
  readPackage?: (packageName: string) => Promise<Record<string, unknown>>;
  readSlug?: (slug: string) => Promise<Record<string, unknown>>;
  writeFile?: (path: string, data: string) => void;
}

interface Window {
  startDate: string;
  endDate: string;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_SURFACE_TIMEOUT_MS = 120_000;
const TOP_ROWS = 25;

export async function snapshot(ctx: ToolContext, params: SnapshotParams, deps: SnapshotDeps = {}): Promise<ToolResult> {
  const now = deps.now ?? new Date();
  if (params.properties.length + params.apps.length + params.packages.length + params.slugs.length === 0) {
    throw new Error("Give at least one surface to capture: properties, apps, packages, or slugs.");
  }
  const window = analysisWindow(now, params.windowDays);
  const surfacesWithErrors: string[] = [];

  const readProperty = deps.readProperty ?? ((siteUrl, w) => captureProperty(ctx, siteUrl, w));
  const readApp = deps.readApp ?? ((app) => captureApp(app, { platform: params.platform, storefronts: params.storefronts }));
  const readPackage = deps.readPackage ?? ((packageName) => capturePackage(packageName, window));
  const readSlug = deps.readSlug ?? ((slug) => captureSlug(slug));

  const timeout = deps.surfaceTimeoutMs ?? DEFAULT_SURFACE_TIMEOUT_MS;
  const jobs = [
    ...params.properties.map((siteUrl) => job("property", siteUrl, () => readProperty(siteUrl, window))),
    ...params.apps.map((app) => job("app", app, () => readApp(app))),
    ...params.packages.map((packageName) => job("package", packageName, () => readPackage(packageName))),
    ...params.slugs.map((slug) => job("slug", slug, () => readSlug(slug))),
  ];
  const captured = await runPool(jobs, Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY), timeout, surfacesWithErrors);

  const structuredContent: Record<string, unknown> = {
    // Minute precision: a snapshot is a point in a series, not a stopwatch.
    takenAt: `${now.toISOString().slice(0, 16)}Z`,
    windowDays: params.windowDays,
    window,
    properties: captured.filter((entry) => entry.kind === "property").map((entry) => entry.value),
    apps: captured.filter((entry) => entry.kind === "app").map((entry) => entry.value),
    packages: captured.filter((entry) => entry.kind === "package").map((entry) => entry.value),
    slugs: captured.filter((entry) => entry.kind === "slug").map((entry) => entry.value),
    surfacesWithErrors,
  };

  // compare_snapshots reads documents from disk, so the capture has to be able
  // to put one there. Without this the two tools only compose if a caller
  // retypes the whole document, which is where faithfulness dies.
  const lines = [formatSnapshot(structuredContent as Parameters<typeof formatSnapshot>[0])];
  if (params.outPath) {
    const write = deps.writeFile ?? ((path: string, data: string) => writeFileSync(path, data));
    write(params.outPath, `${JSON.stringify(structuredContent, null, 2)}\n`);
    structuredContent.writtenTo = params.outPath;
    lines.push(`Written to ${params.outPath}.`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent };
}

// Clicks and impressions come from the date dimension. Summing the query
// dimension undercounts, because Search Console withholds low-volume queries,
// and that gap reads later as a real decline rather than as withheld rows.
async function captureProperty(ctx: ToolContext, siteUrl: string, window: Window): Promise<Record<string, unknown>> {
  const clients = ctx.getAuthenticatedClients();
  const base = { siteUrl, startDate: window.startDate, endDate: window.endDate, maxTableRows: 0 };

  const byDate = await searchAnalytics(clients, searchAnalyticsInput.parse({ ...base, dimensions: ["date"], rowLimit: 500 }));
  const dateRows = rowsOf(byDate);
  const clicks = sum(dateRows, "clicks");
  const impressions = sum(dateRows, "impressions");
  const totals = {
    clicks,
    impressions,
    // Null, not zero, when there is nothing to average. A zero would compare
    // against a later real position as an eleven-place collapse that never
    // happened.
    ctr: impressions > 0 ? clicks / impressions : null,
    // Position averages must be impression-weighted; a plain mean of daily
    // positions lets a quiet day count as much as a busy one.
    position: impressions > 0 ? weightedPosition(dateRows) : null,
    daysWithData: dateRows.length,
    // Search Console lags a few days and the window always ends today, so this
    // is what tells a later reader the trailing days were still filling in.
    firstIncompleteDate: firstIncompleteOf(byDate),
  };

  const byQuery = await searchAnalytics(clients, searchAnalyticsInput.parse({ ...base, dimensions: ["query"], rowLimit: TOP_ROWS }));
  const byPage = await searchAnalytics(clients, searchAnalyticsInput.parse({ ...base, dimensions: ["page"], rowLimit: TOP_ROWS }));

  return {
    siteUrl,
    totals,
    topQueries: { rows: rowsOf(byQuery), truncated: truncatedOf(byQuery) },
    topPages: { rows: rowsOf(byPage), truncated: truncatedOf(byPage) },
  };
}

// Only the fields a later comparison can use, plus per-locale lengths. Storing
// every locale's description body would make the document tens of kilobytes of
// prose that nothing reads.
async function captureApp(app: string, options: { platform: string; storefronts: string[] }): Promise<Record<string, unknown>> {
  const identity = /^\d+$/.test(app) ? { appId: app } : { bundleId: app };
  const result = await appStoreListing(appStoreListingInput.parse({ ...identity, platform: options.platform, storefronts: options.storefronts }));
  const listing = result.structuredContent as Record<string, any>;
  return {
    app,
    appId: listing.appId,
    platform: listing.platform,
    versionString: listing.versionString,
    appInfoState: listing.appInfoState,
    versionState: listing.versionState,
    hasLiveRecord: listing.hasLiveRecord,
    hasEditableRecord: listing.hasEditableRecord,
    fellBack: listing.fellBack,
    localeCount: listing.localeCount,
    overLimit: listing.overLimit,
    ratings: listing.ratings,
    locales: (listing.locales ?? []).map((locale: any) => ({
      locale: locale.locale,
      name: locale.indexed.name.length,
      subtitle: locale.indexed.subtitle.length,
      keywords: locale.indexed.keywords.length,
      promotionalText: locale.promotionalText.length,
      description: locale.description.length,
      partial: locale.partial,
    })),
    notes: listing.notes,
  };
}

// The bulk reports for a month do not exist until Google emits them, so on the
// first days of a month the current month is simply absent. Fall back to the
// previous one and say which was read, rather than losing the surface monthly.
async function capturePackage(packageName: string, window: Window): Promise<Record<string, unknown>> {
  const current = window.endDate.slice(0, 7).replace("-", "");
  try {
    const result = await playStoreStats(playStoreStatsInput.parse({ packageName, month: current }));
    return { package: packageName, ...(result.structuredContent as Record<string, unknown>) };
  } catch (error) {
    const previous = previousMonth(current);
    const result = await playStoreStats(playStoreStatsInput.parse({ packageName, month: previous }));
    return {
      package: packageName,
      ...(result.structuredContent as Record<string, unknown>),
      fellBackFromMonth: current,
      notes: [
        ...((result.structuredContent as { notes?: string[] }).notes ?? []),
        `No reports exist for ${current} yet (${formatToolError(error)}), so ${previous} was read instead.`,
      ],
    };
  }
}

function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(4, 6));
  const date = new Date(Date.UTC(year, index - 2, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function captureSlug(slug: string): Promise<Record<string, unknown>> {
  const result = await wporgPlugin(wporgPluginInput.parse({ slug }));
  return result.structuredContent as Record<string, unknown>;
}

interface Job {
  kind: string;
  id: string;
  run: () => Promise<Record<string, unknown>>;
}

function job(kind: string, id: string, run: () => Promise<Record<string, unknown>>): Job {
  return { kind, id, run };
}

// One unreachable surface must not cost the whole document: the failure is
// recorded in place, because a surface that silently vanishes reads later as a
// collapse to zero.
async function runPool(
  jobs: Job[],
  concurrency: number,
  timeoutMs: number,
  surfacesWithErrors: string[],
): Promise<Array<{ kind: string; value: Record<string, unknown> }>> {
  const results = new Array<{ kind: string; value: Record<string, unknown> }>(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const current = jobs[index];
      if (!current) return;
      try {
        const value = await withTimeout(current.run(), timeoutMs, `${current.kind} ${current.id}`);
        results[index] = { kind: current.kind, value };
      } catch (error) {
        const message = formatToolError(error);
        surfacesWithErrors.push(`${current.kind}:${current.id}`);
        results[index] = { kind: current.kind, value: identify(current, { error: message }) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function identify(current: Job, extra: Record<string, unknown>): Record<string, unknown> {
  const key = current.kind === "property" ? "siteUrl" : current.kind === "package" ? "package" : current.kind === "slug" ? "slug" : "app";
  return { [key]: current.id, ...extra };
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s reading ${label}.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function analysisWindow(now: Date, windowDays: number): Window {
  const end = new Date(now.getTime());
  const start = new Date(end.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function rowsOf(result: ToolResult): Array<Record<string, number | Record<string, string>>> {
  return ((result.structuredContent as { rows?: unknown[] }).rows ?? []) as Array<Record<string, number | Record<string, string>>>;
}

function truncatedOf(result: ToolResult): boolean {
  return Boolean((result.structuredContent as { truncated?: boolean }).truncated);
}

function firstIncompleteOf(result: ToolResult): string | null {
  return (result.structuredContent as { firstIncompleteDate?: string }).firstIncompleteDate ?? null;
}

function sum(rows: Array<Record<string, unknown>>, field: string): number {
  return rows.reduce((total, row) => total + (typeof row[field] === "number" ? (row[field] as number) : 0), 0);
}

function weightedPosition(rows: Array<Record<string, unknown>>): number {
  const impressions = sum(rows, "impressions");
  if (impressions === 0) return 0;
  const weighted = rows.reduce((total, row) => {
    const rowImpressions = typeof row.impressions === "number" ? row.impressions : 0;
    const position = typeof row.position === "number" ? row.position : 0;
    return total + position * rowImpressions;
  }, 0);
  return weighted / impressions;
}

function formatSnapshot(document: {
  takenAt: string;
  window: Window;
  properties: Array<Record<string, unknown>>;
  apps: Array<Record<string, unknown>>;
  packages: Array<Record<string, unknown>>;
  slugs: Array<Record<string, unknown>>;
  surfacesWithErrors: string[];
}): string {
  const lines = [`Snapshot taken ${document.takenAt} covering ${document.window.startDate} to ${document.window.endDate}`];
  for (const property of document.properties) {
    const totals = property.totals as { clicks: number; impressions: number } | undefined;
    lines.push(totals
      ? `- ${String(property.siteUrl)}: ${totals.clicks} clicks, ${totals.impressions} impressions`
      : `- ${String(property.siteUrl)}: not captured (${String(property.error)})`);
  }
  for (const app of document.apps) {
    lines.push(app.error
      ? `- app ${String(app.app)}: not captured (${String(app.error)})`
      : `- app ${String(app.app)}: version ${String(app.versionString)}, ${String(app.localeCount)} locale(s), editable record ${app.hasEditableRecord ? "exists" : "none"}`);
  }
  for (const entry of document.packages) {
    lines.push(entry.error
      ? `- package ${String(entry.package)}: not captured (${String(entry.error)})`
      : `- package ${String(entry.package)}: ${String(entry.activeDeviceInstalls)} active installs as of ${String(entry.lastDatePresent)}`);
  }
  for (const slug of document.slugs) {
    lines.push(slug.error
      ? `- plugin ${String(slug.slug)}: not captured (${String(slug.error)})`
      : `- plugin ${String(slug.slug)}: ${String(slug.activeInstalls)} active installs, rating ${String(slug.rating)}`);
  }
  lines.push(document.surfacesWithErrors.length
    ? `${document.surfacesWithErrors.length} surface(s) could not be read: ${document.surfacesWithErrors.join(", ")}. Their numbers are missing, not zero.`
    : "Every requested surface was captured.");
  return lines.join("\n");
}
