import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string): Record<string, any> => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));

const pkg = read("../package.json");
const plugin = read("../.claude-plugin/plugin.json");

// The plugin installer reads plugin.json and never looks at package.json, so the
// two versions drifting does not fail: `claude plugin update` reads the stale
// number, compares it to the installed one, finds them equal and reports
// success. It went four minor versions stale that way, and the whole Google Ads
// surface was unreachable the entire time behind a tick that read as an update.
describe("plugin manifest", () => {
  it("declares the same version the package does", () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it("asks npm for a range that actually includes this version", () => {
    // The range this replaced was ^0.10.0, which sounds like "0.10 and up" and
    // is not: a caret on a 0.x version pins the minor, so ^0.10.0 stops at
    // 0.11.0 and would never have installed 0.13.1. Bumping the version field
    // alone would have left every ads tool unreachable and looked fixed.
    expect(plugin.mcpServers?.["seo-console"]?.args).toEqual(["-y", `seo-console-mcp@>=${pkg.version} <1.0.0`]);
  });

  it("installs the package this repo publishes", () => {
    const spec = String(plugin.mcpServers?.["seo-console"]?.args?.[1] ?? "");
    expect(spec.startsWith(`${pkg.name}@`)).toBe(true);
  });
});
