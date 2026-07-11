#!/usr/bin/env node
import { resolve } from "node:path";
import { runSetupWizard } from "./setup.js";
import { runVerify } from "./verify.js";
import { startServer } from "./server.js";

const valuedFlags = new Set(["--credentials", "--project", "--key", "--cf-token"]);

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

// Positional args are everything that is neither a flag nor a flag's value.
function positionals(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (valuedFlags.has(arg)) { i++; continue; }
    if (arg.startsWith("--")) continue;
    result.push(arg);
  }
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "setup") {
    const projectId = option(args, "--project");
    const keyPath = option(args, "--key");
    const outcome = await runSetupWizard({
      ...(projectId ? { projectId } : {}),
      ...(keyPath ? { keyPath } : {}),
    });
    if (outcome === "failed") process.exitCode = 1;
    return;
  }
  if (args[0] === "verify") {
    const domains = positionals(args.slice(1));
    if (domains.length === 0) {
      console.error("Usage: seo-mcp verify <domain> [<domain>...] [--cf-token TOKEN] [--credentials /path/key.json]");
      process.exitCode = 1;
      return;
    }
    const credentials = option(args, "--credentials") ?? process.env.SEO_MCP_CREDENTIALS ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const cfToken = option(args, "--cf-token");
    const ok = await runVerify(domains, {
      ...(credentials ? { credentialsPath: resolve(credentials) } : {}),
      ...(cfToken ? { cloudflareToken: cfToken } : {}),
    });
    if (!ok) process.exitCode = 1;
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.error([
      "Usage: seo-mcp [--credentials /path/key.json]",
      "       seo-mcp setup [--project PROJECT_ID] [--key /path/seo-mcp.key.json]",
      "       seo-mcp verify <domain> [<domain>...] [--cf-token TOKEN] [--credentials /path/key.json]",
    ].join("\n"));
    return;
  }
  const configuredPath = option(args, "--credentials")
    ?? process.env.SEO_MCP_CREDENTIALS
    ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const credentialsPath = configuredPath ? resolve(configuredPath) : undefined;
  await startServer(credentialsPath);
}

main().catch((error: unknown) => {
  console.error(`seo-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
