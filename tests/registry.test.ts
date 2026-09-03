import { describe, expect, it } from "vitest";
import { z } from "zod";
import { unwrap } from "../src/query.js";
import { toolDefinitions } from "../src/registry.js";

// Formats like z.url() are their own classes rather than subclasses of
// ZodString, so instanceof would miss them. The declared type on the definition
// is the one thing every zod schema reports the same way.
function typeOf(schema: z.ZodType): string {
  return (schema.def as { type: string }).type;
}

// A field declared with .transform() (the siteUrl and URL normalizers) is a
// pipe. What a shell can type is the pipe's input side, which is also what the
// CLI coerces before the object schema runs the transform.
function shellFacing(schema: z.ZodType): z.ZodType {
  let current = unwrap(schema);
  while (typeOf(current) === "pipe") {
    current = unwrap((current.def as unknown as { in: z.ZodType }).in);
  }
  return current;
}

function elementOf(array: z.ZodType): z.ZodType {
  return shellFacing((array.def as unknown as { element: z.ZodType }).element);
}

// Everything a flag value can carry: scalars as text, nested parameters as JSON.
const flagTypes = new Set(["string", "number", "boolean", "enum", "object"]);

const writeTools = ["delete_sitemap", "indexnow_submit", "request_recrawl", "submit_sitemap"];

describe("tool registry invariants", () => {
  it("gives every tool a unique name a shell and an MCP client can both use", () => {
    const names = toolDefinitions.map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name, `${name} is not lowercase snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it.each(toolDefinitions)("$name carries a description with no stray whitespace", (tool) => {
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toBe(tool.description.trim());
  });

  it.each(toolDefinitions)("$name returns an object schema", (tool) => {
    // Structured output has to be a JSON object: an MCP client reads
    // structuredContent as a record, and the CLI prints it as one.
    expect(typeOf(tool.outputSchema), `${tool.name} outputSchema is not an object`).toBe("object");
    expect(tool.outputSchema).toBeInstanceOf(z.ZodObject);
  });

  it("marks exactly the tools that change remote state as writes", () => {
    const flagged = toolDefinitions.filter((tool) => tool.write).map((tool) => tool.name).sort();

    expect(flagged).toEqual(writeTools);
  });

  it.each(toolDefinitions)("$name takes only parameters that can be typed as a flag value", (tool) => {
    for (const [field, schema] of Object.entries(tool.inputShape)) {
      const resolved = shellFacing(schema as z.ZodType);
      const kind = typeOf(resolved);
      if (kind === "array") {
        const element = elementOf(resolved);
        expect(
          flagTypes.has(typeOf(element)),
          `${tool.name}.${field} is a list of ${typeOf(element)}; the CLI has no flag form for that`,
        ).toBe(true);
        continue;
      }
      expect(
        flagTypes.has(kind),
        `${tool.name}.${field} is ${kind}; no --flag value can express it`,
      ).toBe(true);
    }
  });

  it.each(toolDefinitions)("$name documents every parameter", (tool) => {
    for (const [field, schema] of Object.entries(tool.inputShape)) {
      const description = (schema as z.ZodType).description;
      expect(description?.trim(), `${tool.name}.${field} has no description`).toBeTruthy();
    }
  });
});
