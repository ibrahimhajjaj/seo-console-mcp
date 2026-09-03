import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

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
