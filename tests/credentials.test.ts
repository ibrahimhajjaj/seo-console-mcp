import { describe, expect, it } from "vitest";
import { resolveCredentialsPath } from "../src/credentials.js";

describe("resolveCredentialsPath", () => {
  it("resolves an explicit path", () => {
    expect(resolveCredentialsPath("/abs/key.json", () => false)).toBe("/abs/key.json");
  });

  it("trims and honors an explicit path over the default", () => {
    expect(resolveCredentialsPath("  /abs/key.json  ", () => true)).toBe("/abs/key.json");
  });

  it("falls back to the default key location when the value is empty and the file exists", () => {
    const path = resolveCredentialsPath("", () => true);
    expect(path).toMatch(/seo-mcp[/\\]seo-mcp\.key\.json$/);
  });

  it("treats a whitespace-only value as empty and falls back", () => {
    expect(resolveCredentialsPath("   ", () => true)).toMatch(/seo-mcp\.key\.json$/);
  });

  it("returns undefined when nothing is set and the default file is absent", () => {
    expect(resolveCredentialsPath(undefined, () => false)).toBeUndefined();
    expect(resolveCredentialsPath("", () => false)).toBeUndefined();
  });
});
