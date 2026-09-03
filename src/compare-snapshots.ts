import { readFileSync, statSync } from "node:fs";
import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import { compareSnapshotsInput, snapshotDocument } from "./schemas.js";

type CompareParams = z.output<typeof compareSnapshotsInput>;
type SnapshotDocument = z.output<typeof snapshotDocument>;

export interface CompareDeps {
  readDocument?: (path: string) => string;
}

// This tool does arithmetic, never judgement. It reports what moved between two
// documents; whether a move is good, bad, or caused by anything is a claim about
// the world that a diff cannot support.
export async function compareSnapshots(params: CompareParams, deps: CompareDeps = {}): Promise<ToolResult> {
  const read = deps.readDocument ?? readCappedFile;
  const from = loadDocument(read, params.from, "from");
  const to = loadDocument(read, params.to, "to");

  const elapsedHours = hoursBetween(from.takenAt, to.takenAt);
  // A surface that failed on either side has no comparable number. Saying so is
  // the whole point: a collection failure must never read as a change.
  const unreliable = [...new Set([...from.surfacesWithErrors, ...to.surfacesWithErrors])].sort();

  const properties = pairBy(from.properties, to.properties, (entry) => String(entry.siteUrl)).map(([siteUrl, before, after]) => {
    if (!before?.totals || !after?.totals) return { siteUrl, comparable: false as const };
    return {
      siteUrl,
      comparable: true as const,
      clicks: delta(before.totals.clicks, after.totals.clicks),
      impressions: delta(before.totals.impressions, after.totals.impressions),
      position: delta(before.totals.position, after.totals.position),
      // A window with fewer days of data collected is not a decline. Both sides
      // must be comparable before a clicks delta means anything.
      daysWithData: delta(before.totals.daysWithData, after.totals.daysWithData),
      stillFillingIn: { from: before.totals.firstIncompleteDate ?? null, to: after.totals.firstIncompleteDate ?? null },
      ...pageMovement(before, after, params.minImpressions),
      // The top-row lists are what truncate, not the date-dimension totals.
      truncatedEitherSide: Boolean(before.topPages?.truncated || after.topPages?.truncated || before.topQueries?.truncated || after.topQueries?.truncated),
    };
  });

  const apps = pairBy(from.apps, to.apps, (entry) => String(entry.app)).map(([app, before, after]) => ({
    app,
    comparable: Boolean(before && after && !before.error && !after.error),
    localeCount: delta(before?.localeCount, after?.localeCount),
    versionString: { from: before?.versionString ?? null, to: after?.versionString ?? null },
    ratings: compareRatings(before?.ratings, after?.ratings),
    hasEditableRecord: { from: before?.hasEditableRecord ?? null, to: after?.hasEditableRecord ?? null },
  }));

  const packages = pairBy(from.packages, to.packages, (entry) => String(entry.package)).map(([name, before, after]) => ({
    package: name,
    comparable: Boolean(before && after && !before.error && !after.error),
    activeDeviceInstalls: delta(before?.activeDeviceInstalls, after?.activeDeviceInstalls),
    lastDatePresent: { from: before?.lastDatePresent ?? null, to: after?.lastDatePresent ?? null },
  }));

  const slugs = pairBy(from.slugs, to.slugs, (entry) => String(entry.slug)).map(([slug, before, after]) => ({
    slug,
    comparable: Boolean(before && after && !before.error && !after.error),
    activeInstalls: delta(before?.activeInstalls, after?.activeInstalls),
    downloaded: delta(before?.downloaded, after?.downloaded),
    rating: delta(before?.rating, after?.rating),
    numRatings: delta(before?.numRatings, after?.numRatings),
  }));

  // The CLI emits structuredContent alone, so every caveat that matters has to
  // be readable here and not only in the prose summary.
  const incomparable = [...properties, ...apps, ...packages, ...slugs].filter((entry) => !entry.comparable).length;
  const argumentsReversed = typeof elapsedHours === "number" && elapsedHours < 0;
  const notes = [
    ...(argumentsReversed ? ["The 'from' document is the later of the two, so every change below has its sign reversed. Swap the arguments."] : []),
    ...(unreliable.length ? [`A surface failed on one side: ${unreliable.join(", ")}. Do not read these as a change.`] : []),
    ...(incomparable ? [`${incomparable} surface(s) appear on only one side and could not be compared.`] : []),
    "These are differences, not verdicts. Whether a move is good, or was caused by any particular change, is not something this comparison can tell you.",
  ];

  const structuredContent = {
    from: { takenAt: from.takenAt, window: from.window },
    to: { takenAt: to.takenAt, window: to.window },
    elapsedHours,
    argumentsReversed,
    minImpressions: params.minImpressions,
    properties,
    apps,
    packages,
    slugs,
    surfacesWithErrors: unreliable,
    notes,
  };

  return { content: [{ type: "text", text: formatComparison(structuredContent) }], structuredContent };
}

// A snapshot of a large estate is still small; anything much bigger is not one,
// and should be refused before it is parsed.
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

function readCappedFile(path: string): string {
  const { size } = statSync(path);
  if (size > MAX_DOCUMENT_BYTES) {
    throw new Error(`The file at ${path} is ${Math.round(size / 1024 / 1024)}MB, larger than a snapshot document should ever be.`);
  }
  return readFileSync(path, "utf8");
}

function loadDocument(read: (path: string) => string, path: string, side: string): SnapshotDocument {
  let raw: string;
  try {
    raw = read(path);
  } catch {
    throw new Error(`Could not read the ${side} snapshot at ${path}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The ${side} snapshot at ${path} is not valid JSON.`);
  }
  const result = snapshotDocument.safeParse(parsed);
  if (!result.success) {
    throw new Error(`The ${side} file at ${path} is not a snapshot document produced by the snapshot tool.`);
  }
  return result.data;
}

function pairBy<T extends Record<string, unknown>>(
  before: T[],
  after: T[],
  key: (entry: T) => string,
): Array<[string, T | undefined, T | undefined]> {
  const names = [...new Set([...before.map(key), ...after.map(key)])].sort();
  return names.map((name) => [name, before.find((entry) => key(entry) === name), after.find((entry) => key(entry) === name)]);
}

function delta(before: number | null | undefined, after: number | null | undefined) {
  if (typeof before !== "number" || typeof after !== "number") return { from: before ?? null, to: after ?? null, change: null };
  return { from: before, to: after, change: round(after - before) };
}

// A position move on a handful of impressions is noise, so the floor keeps the
// list to rows that carry enough weight to mean something.
function pageMovement(
  before: SnapshotDocument["properties"][number],
  after: SnapshotDocument["properties"][number],
  minImpressions: number,
) {
  const beforeRows = new Map((before.topPages?.rows ?? []).map((row) => [pageKey(row), row]));
  const afterKeys = new Set((after.topPages?.rows ?? []).map((row) => pageKey(row)));
  const movers: Array<{ page: string; positionFrom: number; positionTo: number; change: number; impressions: number }> = [];
  for (const row of after.topPages?.rows ?? []) {
    const previous = beforeRows.get(pageKey(row));
    if (!previous) continue;
    // Both sides must clear the floor. A position measured on two impressions
    // is not a ranking, so pairing it against a busy week invents a move.
    if (row.impressions < minImpressions || previous.impressions < minImpressions) continue;
    const change = round(row.position - previous.position);
    if (change === 0) continue;
    movers.push({ page: pageKey(row), positionFrom: previous.position, positionTo: row.position, change, impressions: row.impressions });
  }
  // A page that fell out of the captured top rows has not necessarily fallen in
  // the rankings; it left the window we recorded. Say so rather than omit it.
  const droppedOutOfTopPages = [...beforeRows.keys()].filter((page) => !afterKeys.has(page));
  return {
    movers: movers.sort((left, right) => Math.abs(right.change) - Math.abs(left.change)),
    droppedOutOfTopPages,
  };
}

function pageKey(row: { keys: Record<string, string> }): string {
  return row.keys.page ?? row.keys.query ?? "";
}

function compareRatings(
  before: SnapshotDocument["apps"][number]["ratings"],
  after: SnapshotDocument["apps"][number]["ratings"],
) {
  const storefronts = [...new Set([...(before ?? []).map((entry) => entry.storefront), ...(after ?? []).map((entry) => entry.storefront)])].sort();
  return storefronts.map((storefront) => {
    const left = (before ?? []).find((entry) => entry.storefront === storefront);
    const right = (after ?? []).find((entry) => entry.storefront === storefront);
    return {
      storefront,
      averageUserRating: delta(left?.averageUserRating, right?.averageUserRating),
      userRatingCount: delta(left?.userRatingCount, right?.userRatingCount),
    };
  });
}

function hoursBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return round((end - start) / (60 * 60 * 1000));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatComparison(comparison: {
  from: { takenAt: string };
  to: { takenAt: string };
  elapsedHours: number | null;
  properties: Array<Record<string, any>>;
  apps: Array<Record<string, any>>;
  slugs: Array<Record<string, any>>;
  packages: Array<Record<string, any>>;
  surfacesWithErrors: string[];
}): string {
  const lines = [`Comparing ${comparison.from.takenAt} to ${comparison.to.takenAt} (${comparison.elapsedHours ?? "unknown"} hours apart)`];
  if (typeof comparison.elapsedHours === "number" && comparison.elapsedHours < 0) {
    lines.push("The 'from' document is the later of the two, so every difference below has its sign reversed. Swap the arguments.");
  }
  for (const property of comparison.properties) {
    lines.push(property.comparable
      ? `- ${property.siteUrl}: clicks ${signed(property.clicks.change)}, impressions ${signed(property.impressions.change)}, position ${signed(property.position.change)}`
      : `- ${property.siteUrl}: not comparable, one side is missing`);
  }
  for (const app of comparison.apps) {
    lines.push(app.comparable
      ? `- app ${app.app}: version ${app.versionString.from ?? "unknown"} to ${app.versionString.to ?? "unknown"}, locales ${signed(app.localeCount.change)}`
      : `- app ${app.app}: not comparable, one side is missing`);
  }
  for (const entry of comparison.packages) {
    lines.push(entry.comparable
      ? `- package ${entry.package}: active installs ${signed(entry.activeDeviceInstalls.change)}`
      : `- package ${entry.package}: not comparable, one side is missing`);
  }
  for (const slug of comparison.slugs) {
    lines.push(slug.comparable
      ? `- plugin ${slug.slug}: active installs ${signed(slug.activeInstalls.change)}, rating ${signed(slug.rating.change)}`
      : `- plugin ${slug.slug}: not comparable, one side is missing`);
  }
  // The closing line has to account for surfaces that are simply absent on one
  // side, not only ones that recorded an error, or it reassures falsely.
  const incomparable = [...comparison.properties, ...comparison.apps, ...comparison.packages, ...comparison.slugs]
    .filter((entry) => !entry.comparable).length;
  if (comparison.surfacesWithErrors.length) {
    lines.push(`A surface failed on one side: ${comparison.surfacesWithErrors.join(", ")}. Do not read these as a change.`);
  }
  lines.push(incomparable === 0 && comparison.surfacesWithErrors.length === 0
    ? "Every surface was captured on both sides."
    : `${incomparable} surface(s) could not be compared.`);
  lines.push("These are differences, not verdicts. Whether a move is good or was caused by any particular change is not something this comparison can tell you.");
  return lines.join("\n");
}

function signed(value: number | null): string {
  if (value === null) return "unknown";
  return value > 0 ? `+${value}` : String(value);
}
