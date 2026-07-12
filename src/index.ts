#!/usr/bin/env node
import { parseCliArgs, UsageError } from "./cli.js";
import { resolveCredentialsPath } from "./credentials.js";
import { runSetupWizard } from "./setup.js";
import { runVerify } from "./verify.js";
import { startServer } from "./server.js";

const usage = [
  "Usage: seo-mcp [--credentials /path/key.json]",
  "       seo-mcp setup [--project PROJECT_ID] [--key /path/seo-mcp.key.json] [--pagespeed-key|--no-pagespeed-key]",
  "       seo-mcp verify <domain> [<domain>...] [--cf-token TOKEN] [--credentials /path/key.json]",
].join("\n");

async function main(): Promise<void> {
  let command;
  try {
    command = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`seo-mcp: ${error.message}\n${usage}`);
    process.exitCode = 1;
    return;
  }

  if (command.kind === "help") {
    console.error(usage);
    return;
  }
  if (command.kind === "setup") {
    const outcome = await runSetupWizard({
      ...(command.projectId ? { projectId: command.projectId } : {}),
      ...(command.keyPath ? { keyPath: command.keyPath } : {}),
      ...(command.pagespeedKey !== undefined ? { pagespeedKey: command.pagespeedKey } : {}),
    });
    if (outcome === "failed") process.exitCode = 1;
    return;
  }
  if (command.kind === "verify") {
    if (command.domains.length === 0) {
      console.error("Usage: seo-mcp verify <domain> [<domain>...] [--cf-token TOKEN] [--credentials /path/key.json]");
      process.exitCode = 1;
      return;
    }
    const credentialsPath = resolveCredentialsPath(
      command.credentials ?? process.env.SEO_MCP_CREDENTIALS ?? process.env.GOOGLE_APPLICATION_CREDENTIALS,
    );
    const ok = await runVerify(command.domains, {
      ...(credentialsPath ? { credentialsPath } : {}),
      ...(command.cfToken ? { cloudflareToken: command.cfToken } : {}),
    });
    if (!ok) process.exitCode = 1;
    return;
  }
  const credentialsPath = resolveCredentialsPath(
    command.credentials ?? process.env.SEO_MCP_CREDENTIALS ?? process.env.GOOGLE_APPLICATION_CREDENTIALS,
  );
  await startServer(credentialsPath);
}

main().catch((error: unknown) => {
  console.error(`seo-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
