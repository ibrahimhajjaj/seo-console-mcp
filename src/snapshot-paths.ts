import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { snapshotDocument } from "./schemas.js";

// Snapshot paths arrive from a model, not from an operator at a shell, and the
// snapshot tool truncates whatever they name. One directory is the boundary:
// every path a tool call can reach resolves inside it, so the worst a bad string
// can do is clobber another snapshot. The CLI's own --out flag stays free,
// because a person typed that one.

export function snapshotDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SEO_MCP_SNAPSHOT_DIR;
  if (configured && configured.trim()) return resolve(configured.trim());
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "seo-mcp", "snapshots");
}

export function resolveSnapshotPath(given: string, options: { env?: NodeJS.ProcessEnv } = {}): string {
  const directory = snapshotDirectory(options.env);
  const trimmed = given.trim();
  const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(directory, trimmed);
  // The directory itself is not a file inside it, and a sibling whose name only
  // starts with it (snapshotsx next to snapshots) is outside, so the separator
  // has to be part of the prefix.
  const inside = resolved.startsWith(directory + sep);
  if (!inside || !resolved.endsWith(".json")) {
    // The caller's own string goes back, never the resolved form: where an
    // attempt landed outside the directory is not something to report.
    throw new Error(`Snapshot paths must name a .json file inside ${directory}, and "${given}" does not. Pass a file name such as 2026-09-03.json.`);
  }
  return resolved;
}

export interface SnapshotListing {
  name: string;
  path: string;
  // Null on a file that could not be read as a snapshot document. A zero or an
  // empty string there would sort and read as a real capture holding nothing.
  takenAt: string | null;
  windowDays: number | null;
  surfaces: { properties: number; apps: number; packages: number; slugs: number };
  error?: string;
}

export interface ListSnapshotsDeps {
  env?: NodeJS.ProcessEnv;
  readDir?: (directory: string) => string[];
  readFile?: (path: string) => string;
}

const NO_SURFACES = { properties: 0, apps: 0, packages: 0, slugs: 0 };

// A series nobody can enumerate is not a history. Everything here is a read of
// the one directory the resolver already bounds, so listing cannot reach a file
// a tool call was never allowed to name.
export function listSnapshots(deps: ListSnapshotsDeps = {}): SnapshotListing[] {
  const directory = snapshotDirectory(deps.env);
  const readDir = deps.readDir ?? ((path: string) => readdirSync(path));
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  let names: string[];
  try {
    names = readDir(directory);
  } catch {
    // Nothing has been captured yet. An empty history is the honest answer; a
    // failure here would read as "the listing broke" and stop a first run.
    return [];
  }

  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => describe(name, join(directory, name), readFile))
    .sort(byNewestFirst);
}

function describe(name: string, path: string, readFile: (path: string) => string): SnapshotListing {
  const base = { name, path, takenAt: null, windowDays: null, surfaces: NO_SURFACES };
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return { ...base, error: "could not be read" };
  }
  // A file that is in the directory but is not a snapshot is reported, never
  // dropped: a caller comparing this list against what they expect to find has
  // to see the file that will refuse to load rather than an absence.
  const notASnapshot = "is not a snapshot document produced by the snapshot tool";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...base, error: notASnapshot };
  }
  const result = snapshotDocument.safeParse(parsed);
  if (!result.success) return { ...base, error: notASnapshot };
  return {
    name,
    path,
    takenAt: result.data.takenAt,
    windowDays: result.data.windowDays,
    surfaces: {
      properties: result.data.properties.length,
      apps: result.data.apps.length,
      packages: result.data.packages.length,
      slugs: result.data.slugs.length,
    },
  };
}

// Newest first, because the question a listing answers is almost always "what
// is there to compare today against". A file with no readable timestamp has no
// place in the series and sorts to the end rather than to the top.
function byNewestFirst(left: SnapshotListing, right: SnapshotListing): number {
  if (left.takenAt === right.takenAt) return left.name.localeCompare(right.name);
  if (left.takenAt === null) return 1;
  if (right.takenAt === null) return -1;
  return right.takenAt.localeCompare(left.takenAt);
}
