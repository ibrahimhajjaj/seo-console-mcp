import { gunzipSync } from "node:zlib";
import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { appStoreSalesInput } from "./schemas.js";
import { readCredentialsFromEnv, createAscToken, type AscCredentials } from "./app-store-listing.js";
import { USER_AGENT } from "./version.js";

type SalesParams = z.output<typeof appStoreSalesInput>;

interface SalesDeps {
  fetchImpl?: typeof fetch;
  credentials?: AscCredentials;
  vendorNumber?: string;
  now?: Date;
}

const API = "https://api.appstoreconnect.apple.com/v1/salesReports";
const REQUEST_TIMEOUT_MS = 30_000;

export async function appStoreSales(params: SalesParams, deps: SalesDeps = {}): Promise<ToolResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const credentials = deps.credentials ?? readCredentialsFromEnv();
  const vendorNumber = deps.vendorNumber ?? process.env.SEO_MCP_ASC_VENDOR_NUMBER;
  if (!vendorNumber) {
    throw new Error("A vendor number is required. Set SEO_MCP_ASC_VENDOR_NUMBER; it is shown in App Store Connect under Payments and Financial Reports, beside the legal entity name.");
  }
  const token = createAscToken(credentials, deps.now ?? new Date());
  const reportDate = params.reportDate ?? defaultReportDate(deps.now ?? new Date(), params.frequency);

  const query = new URLSearchParams({
    "filter[frequency]": params.frequency,
    "filter[reportType]": params.reportType,
    "filter[reportSubType]": params.reportSubType,
    "filter[vendorNumber]": vendorNumber,
    "filter[reportDate]": reportDate,
    ...(params.version ? { "filter[version]": params.version } : {}),
  });

  const response = await fetchImpl(`${API}?${query.toString()}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/a-gzip", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Apple answers a period with no sales with a 404 whose message says exactly
  // that. It is an absence, not a failure, and reporting it as an error would
  // make a quiet day look like a broken integration.
  if (response.status === 404) {
    const detail = await readDetail(response);
    return empty(reportDate, params, vendorNumber, detail || "There were no sales for the date specified.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`App Store Connect rejected the credentials for sales reports (HTTP ${response.status}). Sales and Trends needs a team key with the Admin, Finance, or Sales and Reports role.`);
  }
  if (!response.ok) {
    const detail = await readDetail(response);
    throw new Error(`App Store Connect returned HTTP ${response.status} for the sales report${detail ? `: ${detail}` : "."}`);
  }

  const tsv = gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
  const rows = parseTsv(tsv);

  // Units are the download count. Grouping by SKU and territory answers "which
  // app, where" without the caller re-deriving it from raw rows.
  const bySku = new Map<string, { sku: string; title: string; units: number; territories: Record<string, number> }>();
  let totalUnits = 0;
  for (const row of rows) {
    const sku = row["SKU"] ?? "unknown";
    const units = Number(row["Units"] ?? "0");
    if (!Number.isFinite(units)) continue;
    const country = row["Country Code"] ?? "??";
    const entry = bySku.get(sku) ?? { sku, title: row["Title"] ?? "", units: 0, territories: {} };
    entry.units += units;
    entry.territories[country] = (entry.territories[country] ?? 0) + units;
    bySku.set(sku, entry);
    totalUnits += units;
  }

  const structuredContent = {
    reportDate,
    frequency: params.frequency,
    reportType: params.reportType,
    reportSubType: params.reportSubType,
    vendorNumber,
    hasData: true,
    rowCount: rows.length,
    totalUnits,
    apps: [...bySku.values()].sort((left, right) => right.units - left.units),
    rows: params.includeRows ? rows : [],
    notes: [
      "Units are downloads and redownloads as Apple counts them for Sales and Trends, which is a different pipeline from App Analytics and can differ from it.",
    ],
  };

  const lines = [
    `App Store sales for ${reportDate} (${params.frequency} ${params.reportType} ${params.reportSubType})`,
    `${totalUnits} unit(s) across ${bySku.size} SKU(s)`,
    ...[...bySku.values()].map((entry) => `- ${entry.sku}${entry.title ? ` (${entry.title})` : ""}: ${entry.units}`),
  ];
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent };
}

function empty(reportDate: string, params: SalesParams, vendorNumber: string, message: string): ToolResult {
  const structuredContent = {
    reportDate,
    frequency: params.frequency,
    reportType: params.reportType,
    reportSubType: params.reportSubType,
    vendorNumber,
    hasData: false,
    rowCount: 0,
    totalUnits: 0,
    apps: [],
    rows: [],
    notes: [`${message} That is an absence of sales for this period, not a failed request, and it is not the same as the report being unavailable.`],
  };
  return { content: [{ type: "text", text: structuredContent.notes[0] as string }], structuredContent };
}

async function readDetail(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return (JSON.parse(body).errors?.[0]?.detail as string) ?? "";
  } catch {
    return "";
  }
}

// Apple ships these as tab-delimited text once gunzipped.
function parseTsv(tsv: string): Array<Record<string, string>> {
  const lines = tsv.split("\n").filter((line) => line.trim() !== "");
  const header = (lines[0] ?? "").split("\t").map((cell) => cell.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(header.map((name, index) => [name, (cells[index] ?? "").trim()]));
  });
}

// Daily reports land the next day, so today is never available and yesterday
// often is not either.
function defaultReportDate(now: Date, frequency: string): string {
  const back = frequency === "DAILY" ? 2 : 8;
  return new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}
