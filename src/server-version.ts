import { fileURLToPath } from "node:url";
import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { serverVersionInput } from "./schemas.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

type Params = z.output<typeof serverVersionInput>;

export interface VersionDeps {
  moduleUrl?: string;
  nodeVersion?: string;
}

// Which build is answering, asked of the process that is answering. Four values
// look like this one and are not: what npm calls latest, what the version range
// resolves to, what the plugin manifest declares, and what is actually running.
// The first three are all readable and none of them is this. Checking the CLI is
// not a substitute either, because the CLI and this server are separate
// processes resolved separately and can be different builds on the same machine.
export async function serverVersion(_params: Params, deps: VersionDeps = {}): Promise<ToolResult> {
  const moduleUrl = deps.moduleUrl ?? import.meta.url;
  let installPath = "";
  try {
    installPath = fileURLToPath(new URL(".", moduleUrl));
  } catch {
    installPath = moduleUrl;
  }
  const nodeVersion = deps.nodeVersion ?? process.version;
  // The path is the tell. A build served out of an npx cache sits somewhere like
  // _npx/<hash>, and that is what distinguishes "the release I expected" from
  // "whatever npx already had", which nothing else in the output shows.
  const cached = /[/\\]_npx[/\\]/.test(installPath);

  const lines = [
    `${PACKAGE_NAME} ${PACKAGE_VERSION}`,
    `Node ${nodeVersion}`,
    `Running from ${installPath}`,
    cached
      ? "This is running from an npx cache. npx reuses a cached build without re-resolving the version range and without erroring, so this can be an older release than npm serves as latest."
      : "This is not running from an npx cache.",
    "This is the build answering this call. It is not necessarily what npm calls latest, what the version range resolves to, or what the plugin manifest declares, and it is not necessarily the same build as the command-line tool of the same name.",
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { name: PACKAGE_NAME, version: PACKAGE_VERSION, nodeVersion, installPath, npxCache: cached },
  };
}
