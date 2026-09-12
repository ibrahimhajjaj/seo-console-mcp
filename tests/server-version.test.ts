import { describe, expect, it } from "vitest";
import { serverVersion } from "../src/server-version.js";
import { serverVersionInput, serverVersionOutput } from "../src/schemas.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/version.js";

const parse = () => serverVersionInput.parse({});

describe("serverVersion", () => {
  it("reports the build answering the call, not a manifest or a registry", async () => {
    const result = await serverVersion(parse(), { moduleUrl: "file:///opt/app/node_modules/seo-console-mcp/dist/x.js", nodeVersion: "v22.22.3" });
    const content = result.structuredContent as { name: string; version: string; nodeVersion: string; npxCache: boolean };

    expect(content.name).toBe(PACKAGE_NAME);
    expect(content.version).toBe(PACKAGE_VERSION);
    expect(content.nodeVersion).toBe("v22.22.3");
    expect(content.npxCache).toBe(false);
    expect(() => serverVersionOutput.parse(content)).not.toThrow();
  });

  it("names an npx cache, which is the only thing that shows a stale build", async () => {
    // npx reuses a cached build without re-resolving the range and without
    // erroring, so a process can trail the published release while npm, the
    // range and the plugin manifest all read current. The path is the tell.
    const result = await serverVersion(parse(), { moduleUrl: "file:///home/someone/.npm/_npx/2f3a9c/node_modules/seo-console-mcp/dist/x.js" });
    const content = result.structuredContent as { npxCache: boolean };

    expect(content.npxCache).toBe(true);
    expect(result.content[0]?.text).toContain("running from an npx cache");
    expect(result.content[0]?.text).toContain("older release than npm serves as latest");
  });

  it("says it does not speak for the command-line tool of the same name", async () => {
    // They are separate processes resolved separately, so checking one does not
    // answer for the other. That was the flaw in checking the CLI instead.
    const result = await serverVersion(parse(), { moduleUrl: "file:///opt/app/dist/x.js" });
    expect(result.content[0]?.text).toContain("not necessarily the same build as the command-line tool");
  });

  it("falls back to the raw module url rather than throwing on one it cannot parse", async () => {
    const result = await serverVersion(parse(), { moduleUrl: "data:text/javascript,void 0" });
    expect((result.structuredContent as { installPath: string }).installPath).toContain("data:");
  });
});
