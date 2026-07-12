import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION, USER_AGENT } from "../src/version.js";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { name: string; version: string };

describe("version", () => {
  it("derives name and version from package.json", () => {
    expect(PACKAGE_NAME).toBe(pkg.name);
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it("builds a user agent that carries the package name and version", () => {
    expect(USER_AGENT).toContain(PACKAGE_NAME);
    expect(USER_AGENT).toContain(PACKAGE_VERSION);
  });
});
