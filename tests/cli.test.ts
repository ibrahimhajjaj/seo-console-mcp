import { describe, expect, it } from "vitest";
import { parseCliArgs, UsageError } from "../src/cli.js";

describe("parseCliArgs", () => {
  it.each([["--help"], ["-h"], ["setup", "--help"], ["verify", "x.com", "--help"]])("returns help for %j", (...args) => {
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

  it("parses a query with tool, parameter flags, and out", () => {
    expect(parseCliArgs(["query", "search_analytics", "--site-url", "sc-domain:example.com", "--start-date", "2026-08-05", "--dimensions", "date", "--out", "/tmp/sg.json"])).toEqual({
      kind: "query",
      tool: "search_analytics",
      params: { siteUrl: "sc-domain:example.com", startDate: "2026-08-05", dimensions: "date" },
      out: "/tmp/sg.json",
      help: false,
      allowWrite: false,
    });
  });

  it("parses a bare query as a tool listing request", () => {
    expect(parseCliArgs(["query"])).toEqual({ kind: "query", params: {}, help: false, allowWrite: false });
  });

  it("routes query --help to the query command rather than global help", () => {
    expect(parseCliArgs(["query", "--help"])).toEqual({ kind: "query", params: {}, help: true, allowWrite: false });
    expect(parseCliArgs(["query", "wporg_plugin", "--help"])).toEqual({
      kind: "query",
      tool: "wporg_plugin",
      params: {},
      help: true,
      allowWrite: false,
    });
  });

  it("parses query credentials separately from tool parameters", () => {
    expect(parseCliArgs(["query", "list_properties", "--credentials", "/k.json"])).toEqual({
      kind: "query",
      tool: "list_properties",
      params: {},
      credentials: "/k.json",
      help: false,
      allowWrite: false,
    });
  });

  it("rejects a query parameter flag without a value", () => {
    expect(() => parseCliArgs(["query", "search_analytics", "--site-url"])).toThrow(/requires a value/);
  });

  it("parses --allow-write as a flag without consuming the next argument", () => {
    expect(parseCliArgs(["query", "delete_sitemap", "--allow-write", "--site-url", "sc-domain:example.com"])).toEqual({
      kind: "query",
      tool: "delete_sitemap",
      params: { siteUrl: "sc-domain:example.com" },
      help: false,
      allowWrite: true,
    });
  });
});
