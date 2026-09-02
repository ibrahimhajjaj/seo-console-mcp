import { writeFileSync } from "node:fs";
import { z } from "zod";
import type { QueryCommand } from "./cli.js";
import { resolveCredentialsPath } from "./credentials.js";
import { createToolContext, toolDefinitions, type ToolContext, type ToolDefinition } from "./registry.js";
import { formatToolError } from "./errors.js";

export interface RunQueryDeps {
  tools?: ToolDefinition[];
  makeContext?: (credentialsPath: string | undefined) => ToolContext;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
  writeFile?: (path: string, data: string) => void;
}

export async function runQuery(command: QueryCommand, deps: RunQueryDeps = {}): Promise<number> {
  const tools = deps.tools ?? toolDefinitions;
  const write = deps.write ?? ((text) => void process.stdout.write(text));
  const writeError = deps.writeError ?? ((text) => void process.stderr.write(text));
  const writeFile = deps.writeFile ?? ((path, data) => writeFileSync(path, data));

  if (!command.tool) {
    // `query --help` is a listing request; a bare `query` is a usage error.
    if (command.help) {
      write(listTools(tools));
      return 0;
    }
    writeError(listTools(tools));
    return 1;
  }
  const definition = tools.find((tool) => tool.name === command.tool);
  if (!definition) {
    writeError(`Unknown tool "${command.tool}". Available: ${tools.map((tool) => tool.name).join(", ")}\n`);
    return 1;
  }
  if (command.help) {
    write(describeTool(definition));
    return 0;
  }
  // Over MCP these run with a person watching; from a shell they are one line in
  // a script, so they have to be asked for explicitly.
  if (definition.write && !command.allowWrite) {
    writeError(`${definition.name} changes data and is not run from the CLI unless you pass --allow-write.\n`);
    return 1;
  }

  try {
    const params = z.object(definition.inputShape).parse(coerceCliParams(definition.inputShape, command.params));
    const context = deps.makeContext
      ? deps.makeContext(resolveCredentials(command))
      : createToolContext(withCredentials(resolveCredentials(command)));
    const result = await definition.run(context, params);
    const json = JSON.stringify(result.structuredContent ?? result, null, 2);
    if (command.out) {
      writeFile(command.out, `${json}\n`);
      write(`Wrote ${command.out}\n`);
    } else {
      write(`${json}\n`);
    }
    return 0;
  } catch (error) {
    writeError(`${formatToolError(error)}\n`);
    return 1;
  }
}

function resolveCredentials(command: QueryCommand): string | undefined {
  return resolveCredentialsPath(
    command.credentials ?? process.env.SEO_MCP_CREDENTIALS ?? process.env.GOOGLE_APPLICATION_CREDENTIALS,
  );
}

function withCredentials(credentialsPath: string | undefined): { credentialsPath?: string } {
  return credentialsPath ? { credentialsPath } : {};
}

// Flags are the kebab-cased schema keys; each value is coerced to the field's
// type so `z.object(shape).parse` sees numbers, booleans, and arrays rather than
// raw strings. The same schema then does the real validation.
export function coerceCliParams(shape: z.ZodRawShape, raw: Record<string, string>): Record<string, unknown> {
  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = shape[key];
    if (!field) {
      const valid = Object.keys(shape).map((name) => `--${camelToKebab(name)}`).join(", ");
      throw new Error(`Unknown parameter --${camelToKebab(key)}. Valid parameters: ${valid || "(none)"}.`);
    }
    coerced[key] = coerceValue(unwrap(field as z.ZodType), value);
  }
  return coerced;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodNullable) {
    current = (current.def as unknown as { innerType: z.ZodType }).innerType;
  }
  return current;
}

function coerceValue(schema: z.ZodType, value: string): unknown {
  if (schema instanceof z.ZodNumber) {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) throw new Error(`Expected a number but got "${value}".`);
    return parsed;
  }
  if (schema instanceof z.ZodBoolean) {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no") return false;
    // Never silently fall back to false: a safety flag like --dry-run must not
    // read as "off" because it was written "1" or "yes".
    throw new Error(`Expected a boolean (true or false) but got "${value}".`);
  }
  if (schema instanceof z.ZodArray) {
    const element = unwrap((schema.def as unknown as { element: z.ZodType }).element);
    return value.split(",").map((item) => coerceValue(element, item.trim()));
  }
  return value;
}

function listTools(tools: ToolDefinition[]): string {
  const rows = tools.map((tool) => `  ${tool.name}${tool.write ? " (write)" : ""}  ${tool.description}`);
  return [
    "Usage: seo-mcp query <tool> [--<param> value ...] [--out path.json] [--credentials /path/key.json] [--allow-write]",
    "",
    "Tools:",
    ...rows,
    "",
    "Tools marked (write) change data and need --allow-write.",
    "Run `seo-mcp query <tool> --help` for a tool's parameters.",
    "",
  ].join("\n");
}

function describeTool(definition: ToolDefinition): string {
  const params = Object.entries(definition.inputShape).map(([name, rawField]) => {
    const field = rawField as z.ZodType;
    const optional = field instanceof z.ZodOptional || field instanceof z.ZodDefault;
    return `  --${camelToKebab(name)}  ${typeName(unwrap(field))}${optional ? " (optional)" : ""}`;
  });
  return [
    `${definition.name}: ${definition.description}`,
    ...(definition.write ? ["", "This tool changes data and needs --allow-write."] : []),
    "",
    "Parameters:",
    ...(params.length ? params : ["  (none)"]),
    "",
  ].join("\n");
}

function typeName(schema: z.ZodType): string {
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodArray) return "list (comma-separated)";
  if (schema instanceof z.ZodEnum) return `one of ${(schema.options as string[]).join("|")}`;
  return "string";
}

function camelToKebab(name: string): string {
  return name.replace(/[A-Z0-9]+/g, (match) => `-${match.toLowerCase()}`);
}
