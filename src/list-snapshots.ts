import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { listSnapshotsInput } from "./schemas.js";
import { listSnapshots, snapshotDirectory, type ListSnapshotsDeps, type SnapshotListing } from "./snapshot-paths.js";

type ListSnapshotsParams = z.output<typeof listSnapshotsInput>;

// The playbook step that says "compare against an earlier snapshot" is not
// actionable without this: a caller cannot name a file it has no way of knowing
// exists. Nothing here reads outside the snapshot directory.
export async function listSnapshotsTool(params: ListSnapshotsParams, deps: ListSnapshotsDeps = {}): Promise<ToolResult> {
  const directory = snapshotDirectory(deps.env);
  const all = listSnapshots(deps);
  const snapshots = all.slice(0, params.limit);

  const structuredContent = {
    directory,
    total: all.length,
    // The CLI prints structuredContent alone, so a list cut at the limit has to
    // say so there: 50 of 300 read exactly like 50 of 50 otherwise.
    truncated: snapshots.length < all.length,
    snapshots,
  };

  return { content: [{ type: "text", text: format(directory, all.length, snapshots) }], structuredContent };
}

function format(directory: string, total: number, snapshots: SnapshotListing[]): string {
  if (total === 0) {
    return `No snapshots in ${directory}. Run snapshot with outPath "auto" to start a history; a comparison needs two.`;
  }
  const shown = snapshots.length < total ? `, showing the ${snapshots.length} most recent` : "";
  const lines = [`${total} snapshot(s) in ${directory}${shown}`];
  for (const entry of snapshots) {
    lines.push(
      entry.error
        ? `- ${entry.name}: ${entry.error}`
        : `- ${entry.name}: taken ${entry.takenAt}, ${entry.windowDays}-day window, ${entry.surfaces.properties} properties, ${entry.surfaces.apps} apps, ${entry.surfaces.packages} packages, ${entry.surfaces.slugs} plugins`,
    );
  }
  return lines.join("\n");
}
