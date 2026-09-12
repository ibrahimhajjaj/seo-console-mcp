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

  it("asks npm for an upper bound only, never a floor at the version being released", () => {
    // Two bugs live here, in opposite directions, and only the second is
    // obvious.
    //
    // The first range was ^0.10.0, which sounds like "0.10 and up" and is not:
    // a caret on a 0.x version pins the minor, so it stopped below 0.11.0 and
    // silently installed an old build for months.
    //
    // Replacing it with >=<current> <1.0.0 broke it the other way. The manifest
    // is committed before the package is published, so between those two
    // moments the range names a version npm does not have, npx fails with
    // ETARGET, and the whole server fails to start. A repo-only test cannot see
    // that: it compares the repo to itself and passes, while the registry, a
    // separate system, has not caught up.
    //
    // A floor never earned its place anyway. npm resolves a range to the
    // HIGHEST matching version, so <1.0.0 installs exactly what >=<current>
    // <1.0.0 would whenever that version exists, and still installs a working
    // one when it does not. The upper bound is the only part doing work: it
    // keeps a future 1.0 with breaking changes from being picked up silently.
    expect(plugin.mcpServers?.["seo-console"]?.args).toEqual(["-y", `${pkg.name}@<1.0.0`]);
  });

  it("installs the package this repo publishes", () => {
    const spec = String(plugin.mcpServers?.["seo-console"]?.args?.[1] ?? "");
    expect(spec.startsWith(`${pkg.name}@`)).toBe(true);
  });
});
