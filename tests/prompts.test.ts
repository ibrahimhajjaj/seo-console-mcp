import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerPrompts } from "../src/prompts.js";
import { toolDefinitions } from "../src/registry.js";

interface PromptMessage {
  role: string;
  content: { type: string; text: string };
}

type PromptHandler = (args: { siteUrl: string }) => { messages: PromptMessage[] };

const registered: Array<{ name: string; handler: PromptHandler }> = [];

const fakeServer = {
  registerPrompt(name: string, _meta: unknown, handler: PromptHandler): void {
    registered.push({ name, handler });
  },
};

registerPrompts(fakeServer as unknown as McpServer);

const toolNames = new Set(toolDefinitions.map((tool) => tool.name));

// The playbooks also backtick the parameters a model has to fill in, which are
// not tool names and never will be.
const parameterNames = new Set(["outPath", "siteUrl"]);

describe("prompt playbooks", () => {
  it("registers the three workflow prompts", () => {
    expect(registered.map((prompt) => prompt.name)).toEqual(["seo_triage", "content_opportunities", "launch_seo_check"]);
  });

  it.each(registered)("$name only tells a model to call tools that exist", ({ name, handler }) => {
    const text = handler({ siteUrl: "sc-domain:example.com" }).messages[0]?.content.text ?? "";
    const tokens = [...text.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map((match) => match[1] ?? "");

    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      if (parameterNames.has(token)) continue;
      expect(toolNames.has(token), `${name} names \`${token}\`, which is neither a registered tool nor a known parameter`).toBe(true);
    }
  });
});
