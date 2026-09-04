// The README used to hand-write every tool's parameters, and hand-written lists
// drift from the schemas that actually validate the call. This renders them
// from `inputShape` instead, into the marker pairs the README already carries.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { jsonShape, typeName, unwrap } from "../src/query.js";
import { toolDefinitions } from "../src/registry.js";

const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));

export function renderBlocks(): Map<string, string> {
  return new Map(toolDefinitions.map((tool) => [tool.name, renderTable(tool.inputShape)]));
}

export function readReadmeBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const match of text.matchAll(/<!-- params:([a-z_]+) -->\n([\s\S]*?)\n<!-- \/params:\1 -->/g)) {
    blocks.set(match[1] as string, (match[2] as string).trim());
  }
  return blocks;
}

export function renderTable(shape: z.ZodRawShape): string {
  const rows = Object.entries(shape).map(([name, rawField]) => {
    const field = rawField as z.ZodType;
    const required = !(field instanceof z.ZodOptional || field instanceof z.ZodDefault);
    const cells = [`\`${name}\``, typeLabel(unwrap(field)), required ? "yes" : "no", defaultLabel(field), describeText(field)];
    return `| ${cells.join(" | ")} |`;
  });
  if (!rows.length) return "This tool takes no parameters.";
  return ["| Parameter | Type | Required | Default | Description |", "|---|---|---|---|---|", ...rows].join("\n");
}

function typeLabel(schema: z.ZodType): string {
  if (!jsonShape(schema)) {
    if (schema instanceof z.ZodArray) {
      return `list of ${typeLabel(unwrap((schema.def as unknown as { element: z.ZodType }).element))}`;
    }
    // The CLI writes enum values pipe-separated, which a Markdown cell reads as
    // a column break.
    if (schema instanceof z.ZodEnum) return `one of ${(schema.options as string[]).join(", ")}`;
  }
  return typeName(schema);
}

function defaultLabel(field: z.ZodType): string {
  if (!(field instanceof z.ZodDefault)) return "";
  return `\`${JSON.stringify((field.def as unknown as { defaultValue: unknown }).defaultValue)}\``;
}

function describeText(field: z.ZodType): string {
  // .describe() is usually the outermost call, but on some fields it sits on the
  // schema inside the optional or default wrapper.
  const text = field.description ?? unwrap(field).description ?? "";
  return text.replace(/\|/g, "\\|");
}

function replaceBlocks(text: string, blocks: Map<string, string>): string {
  let updated = text;
  for (const [name, block] of blocks) {
    const markers = new RegExp(`(<!-- params:${name} -->\\n)[\\s\\S]*?(\\n<!-- /params:${name} -->)`);
    updated = updated.replace(markers, `$1\n${block}\n$2`);
  }
  return updated;
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const text = readFileSync(readmePath, "utf8");
  const rendered = renderBlocks();
  const present = readReadmeBlocks(text);
  const missing = [...rendered.keys()].filter((name) => !present.has(name));
  if (missing.length) {
    process.stderr.write(`README.md has no <!-- params:NAME --> marker pair for: ${missing.join(", ")}\n`);
    return 1;
  }
  const stale = [...rendered].filter(([name, block]) => present.get(name) !== block).map(([name]) => name);
  if (check) {
    if (!stale.length) return 0;
    process.stderr.write(`Stale parameter tables in README.md: ${stale.join(", ")}\nRun npm run docs:params\n`);
    return 1;
  }
  if (stale.length) {
    writeFileSync(readmePath, replaceBlocks(text, rendered));
    process.stdout.write(`Updated ${stale.length} parameter table(s): ${stale.join(", ")}\n`);
  } else {
    process.stdout.write("README.md parameter tables are up to date\n");
  }
  return 0;
}

// Importing this file for its render functions must not rewrite the README.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
