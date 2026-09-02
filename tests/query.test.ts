import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runQuery, coerceCliParams } from "../src/query.js";
import type { QueryCommand } from "../src/cli.js";
import type { ToolContext, ToolDefinition } from "../src/registry.js";

const echoShape = {
  siteUrl: z.string().min(1),
  days: z.number().int().default(30),
  dimensions: z.array(z.string()).default([]),
  dryRun: z.boolean().default(false),
};

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echo the parsed parameters",
  inputShape: echoShape,
  outputSchema: z.object({ params: z.unknown() }),
  run: async (_ctx, params) => ({ content: [{ type: "text", text: "ok" }], structuredContent: { params } }),
};

const authTool: ToolDefinition = {
  name: "needs_auth",
  description: "Requires credentials",
  inputShape: {},
  outputSchema: z.object({}),
  run: async (ctx) => {
    ctx.getAuthenticatedClients();
    return { content: [{ type: "text", text: "ok" }], structuredContent: {} };
  },
};

let writeToolRuns = 0;
const writeTool: ToolDefinition = {
  name: "danger",
  description: "Deletes something",
  inputShape: {},
  outputSchema: z.object({}),
  write: true,
  run: async () => {
    writeToolRuns += 1;
    return { content: [{ type: "text", text: "done" }], structuredContent: {} };
  },
};

const tools = [echoTool, authTool, writeTool];

function command(overrides: Partial<QueryCommand>): QueryCommand {
  return { kind: "query", params: {}, help: false, allowWrite: false, ...overrides };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const files: Array<{ path: string; data: string }> = [];
  const noCredentials: ToolContext = {
    getClients: () => { throw new Error("no clients in test"); },
    getAuthenticatedClients: () => { throw new Error("credentials are not configured"); },
  };
  return {
    out, err, files,
    deps: {
      tools,
      makeContext: () => noCredentials,
      write: (text: string) => void out.push(text),
      writeError: (text: string) => void err.push(text),
      writeFile: (path: string, data: string) => void files.push({ path, data }),
    },
  };
}

describe("runQuery", () => {
  it("coerces string flags to the schema types and writes JSON to stdout", async () => {
    const io = capture();

    const code = await runQuery(command({
      tool: "echo",
      params: { siteUrl: "https://example.com/", days: "90", dimensions: "date,query", dryRun: "true" },
    }), io.deps);

    expect(code).toBe(0);
    expect(io.files).toHaveLength(0);
    const printed = JSON.parse(io.out.join(""));
    expect(printed.params).toEqual({
      siteUrl: "https://example.com/",
      days: 90,
      dimensions: ["date", "query"],
      dryRun: true,
    });
  });

  it("writes to the --out file instead of stdout", async () => {
    const io = capture();

    const code = await runQuery(command({ tool: "echo", params: { siteUrl: "https://example.com/" }, out: "/tmp/snapshot.json" }), io.deps);

    expect(code).toBe(0);
    expect(io.files).toHaveLength(1);
    expect(io.files[0]?.path).toBe("/tmp/snapshot.json");
    expect(JSON.parse(io.files[0]?.data ?? "").params.days).toBe(30);
  });

  it("returns a non-zero code and writes to stderr for an unknown tool", async () => {
    const io = capture();

    const code = await runQuery(command({ tool: "no_such_tool" }), io.deps);

    expect(code).toBe(1);
    expect(io.out).toHaveLength(0);
    expect(io.err.join("")).toMatch(/Unknown tool/);
  });

  it("surfaces a credentials error as a non-zero exit rather than throwing", async () => {
    const io = capture();

    const code = await runQuery(command({ tool: "needs_auth" }), io.deps);

    expect(code).toBe(1);
    expect(io.err.join("")).toMatch(/credentials are not configured/);
  });

  it("rejects an unknown parameter flag", async () => {
    const io = capture();

    const code = await runQuery(command({ tool: "echo", params: { siteUrl: "https://example.com/", nonsense: "x" } }), io.deps);

    expect(code).toBe(1);
    expect(io.err.join("")).toMatch(/Unknown parameter --nonsense/);
  });

  it("rejects a non-numeric value for a number parameter", async () => {
    const io = capture();

    const code = await runQuery(command({ tool: "echo", params: { siteUrl: "https://example.com/", days: "soon" } }), io.deps);

    expect(code).toBe(1);
    expect(io.err.join("")).toMatch(/number/i);
  });

  it("accepts 1/yes/no for booleans but rejects anything ambiguous", async () => {
    const yes = capture();
    expect(await runQuery(command({ tool: "echo", params: { siteUrl: "https://example.com/", dryRun: "1" } }), yes.deps)).toBe(0);
    expect(JSON.parse(yes.out.join("")).params.dryRun).toBe(true);

    const bad = capture();
    const code = await runQuery(command({ tool: "echo", params: { siteUrl: "https://example.com/", dryRun: "maybe" } }), bad.deps);
    expect(code).toBe(1);
    expect(bad.err.join("")).toMatch(/boolean/i);
    expect(bad.out).toHaveLength(0);
  });

  it("refuses a write tool without --allow-write and does not run it", async () => {
    writeToolRuns = 0;
    const io = capture();

    const code = await runQuery(command({ tool: "danger" }), io.deps);

    expect(code).toBe(1);
    expect(writeToolRuns).toBe(0);
    expect(io.err.join("")).toMatch(/--allow-write/);
    expect(io.out).toHaveLength(0);
  });

  it("runs a write tool once --allow-write is given", async () => {
    writeToolRuns = 0;
    const io = capture();

    const code = await runQuery(command({ tool: "danger", allowWrite: true }), io.deps);

    expect(code).toBe(0);
    expect(writeToolRuns).toBe(1);
  });

  it("does not require --allow-write for a read tool", async () => {
    const io = capture();

    const code = await runQuery(command({ tool: "echo", params: { siteUrl: "https://example.com/" } }), io.deps);

    expect(code).toBe(0);
  });

  it("marks write tools in the listing and in the tool's help", async () => {
    const listing = capture();
    await runQuery(command({ help: true }), listing.deps);
    expect(listing.out.join("")).toMatch(/danger \(write\)/);

    const described = capture();
    await runQuery(command({ tool: "danger", help: true }), described.deps);
    expect(described.out.join("")).toMatch(/needs --allow-write/);
  });

  it("treats a bare query with no tool as a usage error on stderr", async () => {
    const io = capture();

    const code = await runQuery(command({}), io.deps);

    expect(code).toBe(1);
    expect(io.out).toHaveLength(0);
    expect(io.err.join("")).toContain("echo");
  });

  it("lists tools for a bare --help and describes one tool's parameters", async () => {
    const listing = capture();
    expect(await runQuery(command({ help: true }), listing.deps)).toBe(0);
    expect(listing.out.join("")).toContain("echo");
    expect(listing.out.join("")).toContain("needs_auth");

    const described = capture();
    expect(await runQuery(command({ tool: "echo", help: true }), described.deps)).toBe(0);
    expect(described.out.join("")).toContain("--site-url");
    expect(described.out.join("")).toContain("--dry-run");
  });
});

describe("coerceCliParams", () => {
  it("unwraps optional and default wrappers before coercing", () => {
    const shape = {
      count: z.number().optional(),
      ratio: z.number().default(1),
      names: z.array(z.string()).optional(),
      keep: z.boolean().default(false),
      note: z.string().optional(),
    };

    expect(coerceCliParams(shape, { count: "5", ratio: "2", names: "a,b", keep: "true", note: "hi" })).toEqual({
      count: 5,
      ratio: 2,
      names: ["a", "b"],
      keep: true,
      note: "hi",
    });
  });
});
