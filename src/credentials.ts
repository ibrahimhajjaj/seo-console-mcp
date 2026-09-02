import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Use the explicit path when given, otherwise the location the setup wizard
// writes the key to. An empty value (e.g. an unset plugin config that passes ""
// through GOOGLE_APPLICATION_CREDENTIALS) counts as "not given" and falls back to
// the default so a standard install works without any credentials configuration.
export function resolveCredentialsPath(
  explicit: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (explicit && explicit.trim()) return resolve(explicit.trim());
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const fallback = join(base, "seo-mcp", "seo-mcp.key.json");
  return exists(fallback) ? fallback : undefined;
}

export function validateCredentials(credentialsPath: string | undefined): void {
  if (!credentialsPath) {
    throw new Error("Google service account credentials are not configured. Set GOOGLE_APPLICATION_CREDENTIALS or SEO_MCP_CREDENTIALS, or start seo-mcp with --credentials /absolute/path/key.json. The seo_audit and pagespeed tools do not require service account credentials.");
  }
  try {
    accessSync(credentialsPath, constants.R_OK);
  } catch {
    throw new Error(`Google service account credentials are unreadable at ${credentialsPath}. Check the path and file permissions. Key contents are never logged.`);
  }
}
