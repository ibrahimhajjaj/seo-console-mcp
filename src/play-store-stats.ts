import { auth as googleAuth } from "@googleapis/searchconsole";
import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { playStoreStatsInput } from "./schemas.js";
import { USER_AGENT } from "./version.js";
import { mapWithConcurrency } from "./concurrency.js";

const OBJECT_TIMEOUT_MS = 30_000;
const MAX_WINDOW_MONTHS = 24;
// A ceiling for politeness towards the reporting bucket, not a throughput knob.
const MONTH_CONCURRENCY = 3;

type PlayStoreStatsParams = z.output<typeof playStoreStatsInput>;

interface TrafficGroup {
  source: string;
  searchTerm: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  visitors: number;
  acquisitions: number;
  conversionRate: number | null;
}

export async function playStoreStats(params: PlayStoreStatsParams, deps: { readReport?: (objectPath: string) => Promise<Buffer | null>; now?: Date } = {}): Promise<ToolResult> {
  const readReport = deps.readReport ?? liveReader();
  // Defaulted here rather than relying on the schema: a caller that builds params
  // directly must not produce undefined lookups.
  const include = params.include ?? [];
  const installsDimension = params.installsDimension ?? "overview";
  const ratingsDimension = params.ratingsDimension ?? "country";
  const crashesDimension = params.crashesDimension ?? "app_version";
  const storePerformanceDimension = params.storePerformanceDimension ?? "traffic_source";
  // The total_ sibling carries only the headline acquisitions, which is cheaper
  // when the per-source split is not needed.
  const storePerformancePrefix = params.storePerformanceTotals ? "total_" : "";
  // Half a window used to fall through to a single month, so a caller asking for
  // a range got the current month's numbers under a range's name.
  if (Boolean(params.startDate) !== Boolean(params.endDate)) {
    throw new Error("Give both startDate and endDate for a window, or neither to read a single month.");
  }
  const window = params.startDate && params.endDate ? { startDate: params.startDate, endDate: params.endDate } : null;
  // Reports are monthly files but their rows are daily, so a window is served by
  // reading every month it touches and filtering the rows locally. A seven-day
  // window that straddles a month boundary needs both files.
  const months = window ? monthsInWindow(window) : [params.month ?? currentUtcMonth(deps.now ?? new Date())];
  const month = months[months.length - 1] as string;

  const installsBuffers: Buffer[] = [];
  const trafficBuffers: Buffer[] = [];
  const ratingsBuffers: Buffer[] = [];
  const reviewsBuffers: Buffer[] = [];
  const crashesBuffers: Buffer[] = [];
  const monthsRead: string[] = [];
  const monthsMissing: string[] = [];
  // Months share nothing, so a two-year window need not be 24 serial reads. The
  // pool preserves input order, which is what keeps the buffers in month order.
  const monthly = await mapWithConcurrency(months, MONTH_CONCURRENCY, async (current) => ({
    current,
    installs: await readReport(`stats/installs/installs_${params.packageName}_${current}_${installsDimension}.csv`),
    ratings: include.includes("ratings") ? await readReport(`stats/ratings/ratings_${params.packageName}_${current}_${ratingsDimension}.csv`) : null,
    reviews: include.includes("reviews") ? await readReport(`reviews/reviews_${params.packageName}_${current}.csv`) : null,
    crashes: include.includes("crashes") ? await readReport(`stats/crashes/crashes_${params.packageName}_${current}_${crashesDimension}.csv`) : null,
    traffic: await readReport(`stats/store_performance/${storePerformancePrefix}store_performance_${params.packageName}_${current}_${storePerformanceDimension}.csv`),
  }));

  for (const { current, installs, ratings, reviews, crashes, traffic } of monthly) {
    if (ratings) ratingsBuffers.push(ratings);
    if (reviews) reviewsBuffers.push(reviews);
    if (crashes) crashesBuffers.push(crashes);
    if (installs) installsBuffers.push(installs);
    if (traffic) trafficBuffers.push(traffic);
    (installs || traffic ? monthsRead : monthsMissing).push(current);
  }
  const installsBuffer = installsBuffers.length ? installsBuffers : null;
  const trafficBuffer = trafficBuffers.length ? trafficBuffers : null;
  // Only fail when nothing at all was found: a caller asking for ratings alone
  // has a complete answer without installs or store performance.
  if (!installsBuffer && !trafficBuffer && !ratingsBuffers.length && !crashesBuffers.length && !reviewsBuffers.length) {
    throw new Error(
      `Neither installs nor store performance report found for ${params.packageName} in ${month}. Check the package name, the month, and that SEO_MCP_PLAY_BUCKET names the right reporting bucket; the reports also lag by days, so a very recent month may not exist yet.`,
    );
  }

  const notes: string[] = [];
  if (window && params.month) {
    notes.push("month was ignored because startDate and endDate were given.");
  }
  if (monthsMissing.length) {
    notes.push(`No reports exist for ${monthsMissing.join(", ")}, so days in those months are missing rather than zero.`);
  }
  const installs = installsBuffer ? readInstalls(installsBuffer, window) : null;
  if (!installsBuffer) notes.push("Installs report is missing.");
  const traffic = trafficBuffer ? readTrafficSources(trafficBuffer, window) : null;
  if (!trafficBuffer) notes.push("Traffic source report is missing.");
  if (window && installs && installs.datesPresent.length < daysBetween(window)) {
    const windowDays = daysBetween(window);
    const daysWithRows = installs.datesPresent.length;
    notes.push(`The window covers ${windowDays} days but only ${daysWithRows} of them ${daysWithRows === 1 ? "has" : "have"} install rows; the reports lag by days.`);
  }

  const ratingsReading = ratingsBuffers.length ? readDimensionReport(ratingsBuffers, window) : null;
  const crashesReading = crashesBuffers.length ? readDimensionReport(crashesBuffers, window) : null;
  const reviewRows = reviewsBuffers.length ? readRowsReport(reviewsBuffers) : null;
  if (include.includes("reviews") && !reviewRows) {
    notes.push("No reviews report exists for this package and period. Google emits one only when there are reviews, so this is an absence rather than a fetch failure.");
  }
  if (include.includes("ratings") && !ratingsReading) {
    notes.push("No ratings report exists for this package and period. Google emits a report only when there is something to report, so this is an absence rather than a fetch failure.");
  }
  if (include.includes("crashes") && !crashesReading) {
    notes.push("No crashes report exists for this package and period, which is an absence rather than a fetch failure.");
  }

  // The last date present in either report is the honest "as of" date, since a
  // partial current month is normal.
  const lastDatePresent = latestDate(installs?.lastDate, traffic?.lastDate);
  const activeDeviceInstalls = installs?.activeDeviceInstalls ?? null;
  const trafficSources = traffic?.groups ?? [];
  const hasPlaySearchRows = traffic?.hasPlaySearchRows ?? false;
  if (traffic && !hasPlaySearchRows) notes.push("No traffic rows matched a Play Store search source.");

  const text = [
    `Play Store stats for ${params.packageName} (${window ? `${window.startDate} to ${window.endDate}` : month})`,
    `Data as of ${lastDatePresent ?? "unknown"} (reports lag by days)`,
    `Active Device Installs: ${activeDeviceInstalls ?? "unknown"}${installs?.lastDate && installs.lastDate !== lastDatePresent ? ` (as of ${installs.lastDate})` : ""}`,
    ...(traffic ? formatTraffic(trafficSources) : []),
    ...notes.map((note) => `Note: ${note}`),
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      packageName: params.packageName,
      month,
      lastDatePresent,
      activeDeviceInstalls,
      trafficSources,
      hasPlaySearchRows,
      window,
      monthsRead,
      datesPresent: installs?.datesPresent ?? [],
      installsLatest: installs?.latest ?? null,
      installsWindowTotals: installs?.windowTotals ?? {},
      installsDimension,
      storePerformanceDimension,
      storePerformanceTotals: Boolean(params.storePerformanceTotals),
      ratings: ratingsReading,
      crashes: crashesReading,
      reviews: reviewRows,
      notes,
    },
  };
}

interface InstallsReading {
  activeDeviceInstalls: number | null;
  lastDate: string | null;
  datesPresent: string[];
  // Every column at the last date, and every daily flow column summed over the
  // window. Keeping all of them means a column we do not use today is still
  // captured, rather than discarded because this adapter had no name for it.
  latest: Record<string, number | string> | null;
  windowTotals: Record<string, number>;
}

function readInstalls(buffers: Buffer[], window: DateWindow | null): InstallsReading {
  const header: string[] = [];
  const dated: Array<{ date: string; cells: string[]; header: string[] }> = [];
  for (const buffer of buffers) {
    const rows = parseCsv(buffer);
    const fileHeader = rows[0]?.map((cell) => cell.trim()) ?? [];
    if (header.length === 0) header.push(...fileHeader);
    const dateIndex = fileHeader.indexOf("Date");
    for (const row of rows.slice(1)) {
      const date = dateIndex >= 0 ? row[dateIndex] : undefined;
      if (!date || !withinWindow(date, window)) continue;
      dated.push({ date, cells: row, header: fileHeader });
    }
  }
  dated.sort((left, right) => left.date.localeCompare(right.date));

  const windowTotals: Record<string, number> = {};
  for (const entry of dated) {
    entry.header.forEach((name, index) => {
      // Only "Daily" columns are flows that can be summed; the rest are stock
      // readings where a sum would be meaningless.
      if (!name.startsWith("Daily")) return;
      const value = toNumber(entry.cells[index]);
      if (value === null) return;
      windowTotals[name] = (windowTotals[name] ?? 0) + value;
    });
  }

  const last = dated[dated.length - 1];
  const latest = last ? Object.fromEntries(last.header.map((name, index) => [name, toNumber(last.cells[index]) ?? last.cells[index] ?? ""])) : null;
  const activeIndex = last ? last.header.indexOf("Active Device Installs") : -1;
  return {
    activeDeviceInstalls: last && activeIndex >= 0 ? toNumber(last.cells[activeIndex]) : null,
    lastDate: last?.date ?? null,
    datesPresent: [...new Set(dated.map((entry) => entry.date))],
    latest,
    windowTotals,
  };
}

interface DimensionReading {
  dimension: string;
  lastDate: string | null;
  rows: Array<{ value: string; latest: Record<string, number | string>; totals: Record<string, number> }>;
}

function readRowsReport(buffers: Buffer[]): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const buffer of buffers) {
    const rows = parseCsv(buffer);
    const header = rows[0]?.map((cell) => cell.trim()) ?? [];
    for (const row of rows.slice(1)) {
      if (row.every((cell) => cell === "")) continue;
      out.push(Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""])));
    }
  }
  return out;
}

function readDimensionReport(buffers: Buffer[], window: DateWindow | null): DimensionReading {
  let dimensionColumn = "Unknown";
  const byValue = new Map<string, { latestDate: string; latest: Record<string, number | string>; totals: Record<string, number> }>();
  let lastDate: string | null = null;
  for (const buffer of buffers) {
    const rows = parseCsv(buffer);
    const header = rows[0]?.map((cell) => cell.trim()) ?? [];
    const dateIndex = header.indexOf("Date");
    if (header[2]) dimensionColumn = header[2];
    const valueIndex = 2;
    for (const row of rows.slice(1)) {
      const date = dateIndex >= 0 ? row[dateIndex] : undefined;
      if (!date || !withinWindow(date, window)) continue;
      if (!lastDate || date >= lastDate) lastDate = date;
      const value = (valueIndex >= 0 ? row[valueIndex]?.trim() : "") || "Unknown";
      const entry = byValue.get(value) ?? { latestDate: "", latest: {}, totals: {} };
      header.forEach((name, index) => {
        const parsed = toNumber(row[index]);
        // Only daily columns are flows that can be summed across the window.
        if (name.startsWith("Daily") && parsed !== null) {
          entry.totals[name] = (entry.totals[name] ?? 0) + parsed;
        }
      });
      if (date >= entry.latestDate) {
        entry.latestDate = date;
        entry.latest = Object.fromEntries(header.map((name, index) => [name, toNumber(row[index]) ?? row[index] ?? ""]));
      }
      byValue.set(value, entry);
    }
  }
  return {
    dimension: dimensionColumn,
    lastDate,
    rows: [...byValue.entries()].map(([value, entry]) => ({ value, latest: entry.latest, totals: entry.totals })).sort((left, right) => left.value.localeCompare(right.value)),
  };
}

function readTrafficSources(buffers: Buffer[], window: DateWindow | null): { groups: TrafficGroup[]; hasPlaySearchRows: boolean; lastDate: string | null } {
  const groups = new Map<string, TrafficGroup>();
  let hasPlaySearchRows = false;
  let lastDate: string | null = null;
  for (const buffer of buffers) {
    const rows = parseCsv(buffer);
    const header = rows[0]?.map((cell) => cell.trim()) ?? [];
    const dateIndex = header.indexOf("Date");
    const sourceIndex = header.indexOf("Traffic source");
    const searchIndex = header.indexOf("Search term");
    const utmSourceIndex = header.indexOf("UTM source");
    const utmCampaignIndex = header.indexOf("UTM campaign");
    const visitorsIndex = firstIndex(header, ["Store listing visitors", "Visitors"]);
    const acquisitionsIndex = firstIndex(header, ["Store listing acquisitions", "Acquisitions"]);

    for (const row of rows.slice(1)) {
      if (sourceIndex < 0 || sourceIndex >= row.length) continue;
      const date = dateIndex >= 0 ? row[dateIndex] : undefined;
      if (date && !withinWindow(date, window)) continue;
      if (date && (!lastDate || date >= lastDate)) lastDate = date;

      const source = row[sourceIndex]?.trim() || "Unknown";
      if (isPlaySearchSource(source)) hasPlaySearchRows = true;
      const searchTerm = (searchIndex >= 0 ? row[searchIndex]?.trim() : "") || null;
      const utmSource = (utmSourceIndex >= 0 ? row[utmSourceIndex]?.trim() : "") || null;
      const utmCampaign = (utmCampaignIndex >= 0 ? row[utmCampaignIndex]?.trim() : "") || null;
      // A NUL separator cannot appear in report text, so it cannot merge two
      // distinct (source, term) pairs the way a literal delimiter could.
      const key = [source, searchTerm ?? "", utmSource ?? "", utmCampaign ?? ""].join("\u0000");
      const group = groups.get(key) ?? { source, searchTerm, utmSource, utmCampaign, visitors: 0, acquisitions: 0, conversionRate: null };
      group.visitors += visitorsIndex >= 0 ? (toNumber(row[visitorsIndex]) ?? 0) : 0;
      group.acquisitions += acquisitionsIndex >= 0 ? (toNumber(row[acquisitionsIndex]) ?? 0) : 0;
      groups.set(key, group);
    }
  }
  // The report carries a per-row conversion rate, but rates cannot be summed or
  // averaged across rows without weighting. Recomputing from the grouped totals
  // is the only rate that is true of the group.
  for (const group of groups.values()) {
    group.conversionRate = group.visitors > 0 ? group.acquisitions / group.visitors : null;
  }
  return {
    groups: [...groups.values()].sort((left, right) => right.visitors - left.visitors),
    hasPlaySearchRows,
    lastDate,
  };
}

// Google Play's organic-search traffic source has been labeled "Google Play
// search" and "Play Store search" across report versions, so match any source
// naming both "play" and "search" rather than one exact phrase. Confirm the
// exact string against a live store_performance report if this ever looks wrong.
function isPlaySearchSource(source: string): boolean {
  const normalized = source.toLowerCase();
  return normalized.includes("play") && normalized.includes("search");
}

// The bulk-report CSVs are UTF-16LE with a byte-order mark and CRLF line endings.
function parseCsv(buffer: Buffer): string[][] {
  let text = buffer.toString("utf16le");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index++;
      } else if (char === '"') inQuotes = false;
      else cell += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else if (char === "\n" || (char === "\r" && next === "\n")) {
      if (char === "\r") index++;
      cells.push(cell);
      rows.push(cells);
      cells = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || cells.length > 0) {
    cells.push(cell);
    rows.push(cells);
  }
  const last = rows[rows.length - 1];
  if (last && last.length === 1 && last[0] === "") rows.pop();
  return rows;
}

// gs://bucket is the form gsutil and Google's own docs use, but the JSON API
// needs the bare name. Accept both, and reject anything else outright: a
// prefixed name would otherwise 404 and read as "the reports are not published
// yet", which is a plausible and wrong explanation.
export function normalizeBucket(value: string): string {
  const bucket = value
    .trim()
    .replace(/^gs:\/\//i, "")
    .replace(/\/+$/, "");
  if (!bucket || bucket.includes("/")) {
    throw new Error(`SEO_MCP_PLAY_BUCKET must be a bucket name such as pubsite_prod_1234 or gs://pubsite_prod_1234, not "${value}".`);
  }
  return bucket;
}

function liveReader(): (objectPath: string) => Promise<Buffer | null> {
  const configured = process.env.SEO_MCP_PLAY_BUCKET;
  if (!configured) {
    throw new Error("A Google Play bulk-reports bucket is required. Set SEO_MCP_PLAY_BUCKET to the reporting bucket (for example pubsite_prod_...).");
  }
  const bucket = normalizeBucket(configured);
  const credentials = process.env.SEO_MCP_PLAY_CREDENTIALS ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const auth = new googleAuth.GoogleAuth({
    ...(credentials ? { keyFile: credentials } : {}),
    scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
  });
  return async (objectPath) => {
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token) throw new Error("Could not obtain a Google Cloud Storage access token for the Play reports reader.");
    const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${token.token}`, "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(OBJECT_TIMEOUT_MS),
      });
    } catch (error) {
      // A window reads one object per month in sequence, so a stalled socket
      // must name the file it stalled on rather than the whole tool call.
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`Reading ${objectPath} from the Play reports bucket timed out after 30s.`);
      }
      throw error;
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Failed to read ${objectPath}: HTTP ${response.status} ${response.statusText}.`);
    return Buffer.from(await response.arrayBuffer());
  };
}

function formatTraffic(sources: TrafficGroup[]): string[] {
  if (sources.length === 0) return ["Traffic sources: none"];
  const lines = ["Top traffic sources by visitors:"];
  for (const source of sources.slice(0, 5)) {
    const rate = source.conversionRate === null ? "no visitors" : `${(source.conversionRate * 100).toFixed(2)}% conversion`;
    lines.push(`- ${source.source}${source.searchTerm ? ` ("${source.searchTerm}")` : ""}: ${source.visitors} visitors, ${source.acquisitions} acquisitions, ${rate}`);
  }
  return lines;
}

function latestDate(...dates: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  for (const date of dates) {
    if (date && (!latest || date > latest)) latest = date;
  }
  return latest;
}

function firstIndex(header: string[], names: string[]): number {
  for (const name of names) {
    const index = header.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface DateWindow {
  startDate: string;
  endDate: string;
}

function withinWindow(date: string, window: DateWindow | null): boolean {
  if (!window) return true;
  return date >= window.startDate && date <= window.endDate;
}

function daysBetween(window: DateWindow): number {
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const end = Date.parse(`${window.endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.floor((end - start) / 86400000) + 1;
}

// A window is served by reading every month it touches, and each month costs up
// to five sequential object reads, so a long window quietly turns into hundreds
// of authenticated requests. A reversed window would walk forward until the cap
// stopped it, so it is refused by name instead.
function monthsInWindow(window: DateWindow): string[] {
  if (window.startDate > window.endDate) throw new Error("startDate must be on or before endDate.");
  const months: string[] = [];
  let year = Number(window.startDate.slice(0, 4));
  let month = Number(window.startDate.slice(5, 7));
  const endKey = window.endDate.slice(0, 7).replace("-", "");
  for (let guard = 0; guard < MAX_WINDOW_MONTHS + 1; guard++) {
    const key = `${year}${String(month).padStart(2, "0")}`;
    months.push(key);
    if (key >= endKey) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  if (months.length > MAX_WINDOW_MONTHS) {
    throw new Error("The window spans more than 24 months; read it in smaller windows so one call does not fan out into hundreds of report files.");
  }
  return months;
}

function currentUtcMonth(now: Date): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
