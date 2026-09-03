import { describe, expect, it } from "vitest";
import { resolveSnapshotPath, snapshotDirectory } from "../src/snapshot-paths.js";

const env = { SEO_MCP_SNAPSHOT_DIR: "/snapshots" };

describe("snapshotDirectory", () => {
  it("uses the configured directory when one is set", () => {
    expect(snapshotDirectory(env)).toBe("/snapshots");
  });

  it("falls back to the config directory under XDG_CONFIG_HOME", () => {
    expect(snapshotDirectory({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/seo-mcp/snapshots");
  });

  it("treats a blank configured directory as unset", () => {
    // An MCP client that passes an empty env entry through must not end up with
    // the process working directory as the boundary.
    expect(snapshotDirectory({ SEO_MCP_SNAPSHOT_DIR: "   ", XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/seo-mcp/snapshots");
  });
});

describe("resolveSnapshotPath", () => {
  it("resolves a bare file name inside the snapshot directory", () => {
    expect(resolveSnapshotPath("a.json", { env })).toBe("/snapshots/a.json");
  });

  it("accepts an absolute path that is already inside the directory", () => {
    expect(resolveSnapshotPath("/snapshots/2026/a.json", { env })).toBe("/snapshots/2026/a.json");
  });

  it("refuses a relative path that climbs out of the directory", () => {
    expect(() => resolveSnapshotPath("../x.json", { env })).toThrow(/\/snapshots/);
  });

  it("refuses an absolute path elsewhere on the machine", () => {
    expect(() => resolveSnapshotPath("/etc/passwd", { env })).toThrow(/\/snapshots/);
  });

  it("refuses a sibling directory whose name only starts the same", () => {
    expect(() => resolveSnapshotPath("/snapshotsx/a.json", { env })).toThrow(/\/snapshots/);
  });

  it("refuses a file that is not JSON", () => {
    expect(() => resolveSnapshotPath("a.txt", { env })).toThrow(/\.json/);
  });

  it("echoes the string it was given rather than where it resolved to", () => {
    // Reporting the resolved path would answer questions about the filesystem
    // outside the directory that the refusal exists to refuse.
    expect(() => resolveSnapshotPath("../../secrets/x.json", { env })).toThrow(/"\.\.\/\.\.\/secrets\/x\.json"/);
  });

  it("resolves against the XDG default when no directory is configured", () => {
    expect(resolveSnapshotPath("a.json", { env: { XDG_CONFIG_HOME: "/xdg" } })).toBe("/xdg/seo-mcp/snapshots/a.json");
  });
});
