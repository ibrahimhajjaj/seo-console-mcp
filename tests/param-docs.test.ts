import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readReadmeBlocks, renderBlocks, renderTable } from "../scripts/param-docs.js";

const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

describe("README parameter tables", () => {
  const rendered = renderBlocks();
  const documented = readReadmeBlocks(readme);

  it.each([...rendered.keys()])("%s matches its schema", (name) => {
    expect(documented.has(name), `README.md carries no <!-- params:${name} --> block; run npm run docs:params`).toBe(true);
    expect(documented.get(name), `${name}'s parameter table has drifted from its schema; run npm run docs:params`)
      .toBe(rendered.get(name));
  });
});

describe("renderTable", () => {
  it("gives each field its type, requiredness and default", () => {
    const table = renderTable({
      seed: z.string().describe("Seed keyword to expand"),
      by: z.enum(["query", "page"]).optional().describe("Dimension used to group results"),
      expansions: z.array(z.string()).default(["questions"]).describe("Suggestion families to run"),
    });
    expect(table.split("\n")).toEqual([
      "| Parameter | Type | Required | Default | Description |",
      "|---|---|---|---|---|",
      "| `seed` | string | yes |  | Seed keyword to expand |",
      "| `by` | one of query, page | no |  | Dimension used to group results |",
      '| `expansions` | list of string | no | `["questions"]` | Suggestion families to run |',
    ]);
  });
});
