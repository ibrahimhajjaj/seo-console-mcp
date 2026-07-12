import { describe, expect, it } from "vitest";
import { parseCliArgs, UsageError } from "../src/cli.js";

describe("parseCliArgs", () => {
  it.each([
    ["--help"],
    ["-h"],
    ["setup", "--help"],
    ["verify", "x.com", "--help"],
  ])("returns help for %j", (...args) => {
    expect(parseCliArgs(args)).toEqual({ kind: "help" });
  });

  it("parses verify domains and a Cloudflare token", () => {
    expect(parseCliArgs(["verify", "a.com", "b.com", "--cf-token", "T"])).toEqual({
      kind: "verify",
      domains: ["a.com", "b.com"],
      cfToken: "T",
    });
  });

  it("rejects a misspelled verify option", () => {
    const parse = () => parseCliArgs(["verify", "a.com", "--credential", "/p/k.json"]);

    expect(parse).toThrow(UsageError);
    expect(parse).toThrow(/unknown option/);
  });

  it("rejects a valued option without a value", () => {
    expect(() => parseCliArgs(["--credentials"])).toThrow(/requires a value/);
  });

  it("rejects a flag-shaped option value", () => {
    expect(() => parseCliArgs(["--credentials", "--foo"])).toThrow(/requires a value/);
  });

  it("parses setup options", () => {
    expect(parseCliArgs(["setup", "--project", "p1", "--key", "/k.json"])).toEqual({
      kind: "setup",
      projectId: "p1",
      keyPath: "/k.json",
    });
  });

  it.each([
    ["--pagespeed-key", true],
    ["--no-pagespeed-key", false],
  ] as const)("parses the setup %s flag", (flag, pagespeedKey) => {
    expect(parseCliArgs(["setup", flag])).toEqual({
      kind: "setup",
      pagespeedKey,
    });
  });

  it("leaves the PageSpeed key choice undefined when no flag is given", () => {
    expect(parseCliArgs(["setup"])).toEqual({ kind: "setup" });
    expect(parseCliArgs(["setup"])).not.toHaveProperty("pagespeedKey");
  });

  it("rejects a known option on the wrong command", () => {
    const parse = () => parseCliArgs(["setup", "--cf-token", "T"]);

    expect(parse).toThrow(UsageError);
    expect(parse).toThrow(/unknown option for setup/);
  });

  it("parses serve without options", () => {
    expect(parseCliArgs([])).toEqual({ kind: "serve" });
  });

  it("parses serve credentials", () => {
    expect(parseCliArgs(["--credentials", "/k"])).toEqual({
      kind: "serve",
      credentials: "/k",
    });
  });

  it("rejects a stray positional", () => {
    expect(() => parseCliArgs(["frobnicate"])).toThrow(UsageError);
  });
});
