import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerPrompts } from "../src/prompts.js";
import { toolDefinitions } from "../src/registry.js";

interface PromptMessage {
  role: string;
  content: { type: string; text: string };
}

type PromptHandler = (args: { siteUrl: string }) => { messages: PromptMessage[] };

const promptTexts = new Map<string, string>();

// registerPrompts only ever calls registerPrompt, so a stub with that one method
// is enough to render each prompt and read its text back.
const fakeServer = {
  registerPrompt(name: string, _meta: unknown, handler: PromptHandler): void {
    const text = handler({ siteUrl: "sc-domain:example.com" }).messages[0]?.content.text ?? "";
    promptTexts.set(name, text);
  },
};

registerPrompts(fakeServer as unknown as McpServer);

const toolNames = new Set(toolDefinitions.map((tool) => tool.name));

// The playbooks also backtick the values a caller has to supply, which are not
// tool names and never will be.
const placeholders = new Set(["$ARGUMENTS", "outPath", "siteUrl"]);

const commandsDir = fileURLToPath(new URL("../commands", import.meta.url));
const commandFiles = readdirSync(commandsDir)
  .filter((name) => name.endsWith(".md"))
  .sort();

// A plugin command and an MCP prompt are two copies of the same workflow, so a
// tool named in either has to reach the other.
const pairs = [
  { file: "content.md", prompt: "content_opportunities" },
  { file: "launch.md", prompt: "launch_seo_check" },
  { file: "triage.md", prompt: "seo_triage" },
];

// app_store_sales and crux_history are in no playbook on purpose: sales is not an
// SEO action, and history is a diffing tool the snapshot step already covers.

function backtickedTokens(text: string): string[] {
  return [...text.matchAll(/`(\$?[A-Za-z][A-Za-z0-9_]*)`/g)].map((match) => match[1] ?? "");
}

function toolsNamedIn(text: string): string[] {
  return [...new Set(backtickedTokens(text).filter((token) => toolNames.has(token)))].sort();
}

function readCommand(file: string): string {
  return readFileSync(join(commandsDir, file), "utf8");
}

describe("plugin command playbooks", () => {
  it("has a prompt paired with every command file", () => {
    expect(pairs.map((pair) => pair.file)).toEqual(commandFiles);
    expect(pairs.every((pair) => promptTexts.has(pair.prompt))).toBe(true);
  });

  it.each(commandFiles)("%s only tells a model to call tools that exist", (file) => {
    const tokens = backtickedTokens(readCommand(file));

    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      if (placeholders.has(token)) continue;
      expect(toolNames.has(token), `${file} names \`${token}\`, which is neither a registered tool nor a known placeholder`).toBe(true);
    }
  });

  it.each(pairs)("$file names the same tools as the $prompt prompt", ({ file, prompt }) => {
    expect(toolsNamedIn(readCommand(file))).toEqual(toolsNamedIn(promptTexts.get(prompt) ?? ""));
  });
});
