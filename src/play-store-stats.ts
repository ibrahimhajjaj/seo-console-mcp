import { auth as googleAuth } from "@googleapis/searchconsole";
import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { playStoreStatsInput } from "./schemas.js";
import { USER_AGENT } from "./version.js";

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

export async function playStoreStats(
  params: PlayStoreStatsParams,
  deps: { readReport?: (objectPath: string) => Promise<Buffer | null>; now?: Date } = {},
): Promise<ToolResult> {
  const readReport = deps.readReport ?? liveReader();
  const window = params.startDate && params.endDate ? { startDate: params.startDate, endDate: params.endDate } : null;
  // Reports are monthly files but their rows are daily, so a window is served by
  // reading every month it touches and filtering the rows locally. A seven-day
  // window that straddles a month boundary needs both files.
  const months = window ? monthsInWindow(window) : [params.month ?? currentUtcMonth(deps.now ?? new Date())];
  const month = months[months.length - 1] as string;

  const installsBuffers: Buffer[] = [];
  const trafficBuffers: Buffer[] = [];
  const monthsRead: string[] = [];
  const monthsMissing: string[] = [];
  for (const current of months) {
    const installs = await readReport(`stats/installs/installs_${params.packageName}_${current}_overview.csv`);
    const traffic = await readReport(`stats/store_performance/store_performance_${params.packageName}_${current}_traffic_source.csv`);
    if (installs) installsBuffers.push(installs);
    if (traffic) trafficBuffers.push(traffic);
    (installs || traffic ? monthsRead : monthsMissing).push(current);
  }
  const installsBuffer = installsBuffers.length ? installsBuffers : null;
  const trafficBuffer = trafficBuffers.length ? trafficBuffers : null;
  if (!installsBuffer && !trafficBuffer) {
    throw new Error(`Neither installs nor store performance report found for ${params.packageName} in ${month}. Check the package name, the month, and that SEO_MCP_PLAY_BUCKET names the right reporting bucket; the reports also lag by days, so a very recent month may not exist yet.`);
  }

  const notes: string[] = [];
  if (monthsMissing.length) {
    notes.push(`No reports exist for ${monthsMissing.join(", ")}, so days in those months are missing rather than zero.`);
  }
  const installs = installsBuffer ? readInstalls(installsBuffer, window) : null;
  if (!installsBuffer) notes.push("Installs report is missing.");
  const traffic = trafficBuffer ? readTrafficSources(trafficBuffer, window) : null;
  if (!trafficBuffer) notes.push("Traffic source report is missing.");
  if (window && installs && installs.datesPresent.length < daysBetween(window)) {
    notes.push(`The window covers ${daysBetween(window)} days but only ${installs.datesPresent.length} have install rows; the reports lag by days.`);
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
  const latest = last
    ? Object.fromEntries(last.header.map((name, index) => [name, toNumber(last.cells[index]) ?? last.cells[index] ?? ""]))
    : null;
  const activeIndex = last ? last.header.indexOf("Active Device Installs") : -1;
  return {
    activeDeviceInstalls: last && activeIndex >= 0 ? toNumber(last.cells[activeIndex]) : null,
    lastDate: last?.date ?? null,
    datesPresent: [...new Set(dated.map((entry) => entry.date))],
    latest,
    windowTotals,
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
      if (char === '"' && next === '"') { cell += '"'; index++; }
      else if (char === '"') inQuotes = false;
      else cell += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") { cells.push(cell); cell = ""; }
    else if (char === "\n" || (char === "\r" && next === "\n")) {
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
  const bucket = value.trim().replace(/^gs:\/\//i, "").replace(/\/+$/, "");
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
    const response = await fetch(url, { headers: { authorization: `Bearer ${token.token}`, "user-agent": USER_AGENT } });
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

export interface DateWindow { startDate: string; endDate: string }

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

// Every month the window touches, so a window spanning a boundary reads both files.
function monthsInWindow(window: DateWindow): string[] {
  const months: string[] = [];
  let year = Number(window.startDate.slice(0, 4));
  let month = Number(window.startDate.slice(5, 7));
  const endKey = window.endDate.slice(0, 7).replace('-', '');
  for (let guard = 0; guard < 480; guard++) {
    const key = `${year}${String(month).padStart(2, '0')}`;
    months.push(key);
    if (key >= endKey) break;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}

function currentUtcMonth(now: Date): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
