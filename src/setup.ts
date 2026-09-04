import { accessSync, constants, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isAbsolute, resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export interface CommandResult {
  ok: boolean;
  stdout: string;
  exitCode: number | null;
  errorCode?: string;
}

export interface SetupRunner {
  capture(args: string[]): Promise<CommandResult>;
  inherit(args: string[]): Promise<CommandResult>;
}

export interface SetupOptions {
  runner?: SetupRunner;
  print?: (line: string) => void;
  prompt?: (question: string) => Promise<string>;
  cwd?: string;
  projectId?: string;
  keyPath?: string;
  pagespeedKey?: boolean;
  fileExists?: (path: string) => boolean;
  makeDir?: (dir: string) => void;
}

export type SetupOutcome = "ready" | "manual" | "failed";

const serviceAccountName = "seo-mcp";
const apiServices = ["searchconsole.googleapis.com", "pagespeedonline.googleapis.com", "siteverification.googleapis.com"];
const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const projectIdRule = "Project IDs are 6-30 characters: a lowercase letter first, then lowercase letters, digits, or hyphens, not ending in a hyphen.";

export async function runSetupWizard(options: SetupOptions = {}): Promise<SetupOutcome> {
  try {
    return await runWizard(options);
  } finally {
    // gcloud and readline can leave the terminal in raw mode; restore cooked output.
    resetTty();
  }
}

async function runWizard(options: SetupOptions): Promise<SetupOutcome> {
  const runner = options.runner ?? createGcloudRunner();
  const print = options.print ?? console.log;
  const cwd = options.cwd ?? process.cwd();
  const prompt = options.prompt ?? defaultPrompt;
  const fileExists = options.fileExists ?? canRead;
  const makeDir =
    options.makeDir ??
    ((dir: string) => {
      mkdirSync(dir, { recursive: true });
    });

  print("seo-mcp setup");
  print("This wizard creates a Google Cloud service account for Search Console.");

  const version = await runner.capture(["version", "--format=value(core.version)"]);
  if (!version.ok && (version.errorCode === "ENOENT" || version.errorCode === "EINVAL")) {
    printManualSetup(print);
    return "manual";
  }
  if (!version.ok) return fail(print, "Could not run gcloud. Check your Google Cloud CLI installation.");
  print("[1/6] gcloud CLI found.");

  let auth = await runner.capture(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]);
  let account = auth.stdout.trim();
  if (!auth.ok || !account) {
    print("[2/6] No active gcloud account. Opening gcloud authentication...");
    const login = await runner.inherit(["auth", "login", "--quiet"]);
    if (!login.ok) return fail(print, "gcloud auth login failed. Resolve the gcloud error above and run setup again.");
    auth = await runner.capture(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]);
    account = auth.stdout.trim();
    if (!auth.ok || !account) return fail(print, "Authentication completed but no active gcloud account was found.");
  }
  print(`[2/6] Active gcloud account: ${account.split("\n")[0]}`);

  let projectId = options.projectId?.trim();
  if (projectId) {
    if (!projectIdPattern.test(projectId)) return fail(print, `Invalid project ID "${projectId}". ${projectIdRule}`);
  } else {
    const configured = await runner.capture(["config", "get-value", "project"]);
    const current = configured.ok && configured.stdout.trim() !== "(unset)" ? configured.stdout.trim() : "";
    projectId = await promptForProjectId(prompt, print, current);
    if (!projectId) return fail(print, `A valid GCP project ID is required. ${projectIdRule}`);
  }

  print(`[3/6] Checking project ${projectId}...`);
  const project = await runner.inherit(["projects", "describe", projectId, "--quiet"]);
  if (!project.ok) {
    print(`Project ${projectId} was not found or is not accessible. Creating it...`);
    const created = await runner.inherit(["projects", "create", projectId, `--name=${projectId}`, "--quiet"]);
    if (!created.ok) return fail(print, `Could not create project ${projectId}. Resolve the gcloud error above or choose another project ID.`);
  }
  const selected = await runner.inherit(["config", "set", "project", projectId, "--quiet"]);
  if (!selected.ok) return fail(print, `Could not set ${projectId} as the active gcloud project.`);

  print("[4/6] Enabling Search Console, PageSpeed Insights, and Site Verification APIs...");
  const enabled = await runner.inherit(["services", "enable", ...apiServices, `--project=${projectId}`, "--quiet"]);
  if (!enabled.ok) return fail(print, "Could not enable the required APIs. Resolve the gcloud error above and run setup again.");

  const serviceAccountEmail = `${serviceAccountName}@${projectId}.iam.gserviceaccount.com`;
  print(`[5/6] Checking service account ${serviceAccountEmail}...`);
  const described = await runner.capture(["iam", "service-accounts", "describe", serviceAccountEmail, `--project=${projectId}`]);
  if (!described.ok) {
    const created = await runner.inherit(["iam", "service-accounts", "create", serviceAccountName, "--display-name=SEO MCP", `--project=${projectId}`, "--quiet"]);
    if (!created.ok) return fail(print, "Could not create the seo-mcp service account. Resolve the gcloud error above and run setup again.");
  } else {
    print("Service account already exists; keeping it.");
  }

  const usingDefaultKeyPath = !options.keyPath;
  const requestedKeyPath = options.keyPath ?? defaultKeyPath();
  const keyPath = isAbsolute(requestedKeyPath) ? requestedKeyPath : resolve(cwd, requestedKeyPath);
  print(`[6/6] Preparing service account key at ${keyPath}...`);
  if (fileExists(keyPath)) {
    print("Key file already exists; keeping it. Delete it first if you intentionally need a new key.");
  } else {
    // We only own the directory for the default path; a user-supplied --key must resolve to a real dir.
    if (usingDefaultKeyPath) makeDir(dirname(keyPath));
    const key = await runner.inherit(["iam", "service-accounts", "keys", "create", keyPath, `--iam-account=${serviceAccountEmail}`, `--project=${projectId}`, "--quiet"]);
    if (!key.ok) return fail(print, "Could not create the service account key. Resolve the gcloud error above and run setup again.");
  }

  // Only ASK interactively on a real TTY. A caller can inject a prompt (e.g. to
  // supply a project ID) without consenting to provision a billed key, so a
  // non-interactive run with no explicit --pagespeed-key must default to skip.
  const canPrompt = Boolean(stdin.isTTY && stdout.isTTY);
  const wantPageSpeedKey = options.pagespeedKey ?? (canPrompt && /^y/i.test((await prompt("Create a PageSpeed Insights API key for higher quota? [y/N]: ")).trim()));
  let pageSpeedKey: string | undefined;
  if (!wantPageSpeedKey) {
    print("PageSpeed quota: using the low anonymous quota; add an API key later for higher quota.");
  } else {
    print("PageSpeed quota: creating a project-scoped API key...");
    try {
      const apiKeysEnabled = await runner.inherit(["services", "enable", "apikeys.googleapis.com", `--project=${projectId}`, "--quiet"]);
      if (!apiKeysEnabled.ok) throw new Error("API Keys API could not be enabled");

      const createdPageSpeedKey = await runner.capture([
        "services",
        "api-keys",
        "create",
        "--display-name=seo-mcp pagespeed",
        "--api-target=service=pagespeedonline.googleapis.com",
        `--project=${projectId}`,
        "--format=value(name)",
      ]);
      const keyName = createdPageSpeedKey.stdout.trim();
      if (!createdPageSpeedKey.ok || !keyName) throw new Error("PageSpeed API key could not be created");

      const keyString = await runner.capture(["services", "api-keys", "get-key-string", keyName, "--format=value(keyString)"]);
      pageSpeedKey = keyString.stdout.trim();
      if (!keyString.ok || !pageSpeedKey) throw new Error("PageSpeed API key string could not be retrieved");
    } catch {
      pageSpeedKey = undefined;
      print("Warning: PageSpeed API key provisioning failed. Setup will continue with anonymous quota.");
    }
  }

  const distEntry = resolve(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
  print("");
  print("MANUAL STEP REQUIRED");
  print(`Add ${serviceAccountEmail} as an Owner in Search Console -> your property -> Settings -> Users and permissions`);
  print("");
  print("Claude Code, local build:");
  print(`claude mcp add --scope user seo-mcp --env GOOGLE_APPLICATION_CREDENTIALS=${keyPath} -- node ${distEntry}`);
  print("");
  print("Claude Code, published package:");
  print(`claude mcp add --scope user seo-mcp --env GOOGLE_APPLICATION_CREDENTIALS=${keyPath} -- npx -y seo-console-mcp`);
  print("");
  print("MCP client configuration:");
  if (pageSpeedKey) print("Save this key; it grants PageSpeed quota on your project and is shown only in the configuration below.");
  print(
    JSON.stringify(
      {
        mcpServers: {
          "seo-mcp": {
            type: "stdio",
            command: "node",
            args: [distEntry],
            env: {
              GOOGLE_APPLICATION_CREDENTIALS: keyPath,
              ...(pageSpeedKey ? { SEO_MCP_PAGESPEED_KEY: pageSpeedKey } : {}),
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return "ready";
}

async function promptForProjectId(prompt: (question: string) => Promise<string>, print: (line: string) => void, current: string): Promise<string> {
  const question = current ? `GCP project ID [${current}]: ` : "GCP project ID to use or create: ";
  for (let attempt = 0; attempt < 5; attempt++) {
    const answer = (await prompt(question)).trim();
    const candidate = answer || current;
    if (!candidate) {
      print(`A project ID is required. ${projectIdRule}`);
      continue;
    }
    if (projectIdPattern.test(candidate)) return candidate;
    print(`"${candidate}" is not a valid project ID. ${projectIdRule}`);
  }
  return "";
}

function defaultKeyPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "seo-mcp", "seo-mcp.key.json");
}

function createGcloudRunner(): SetupRunner {
  return {
    capture: (args) => spawnGcloud(args, "pipe"),
    inherit: (args) => spawnGcloud(args, "inherit"),
  };
}

// cmd.exe cannot spawn .cmd batch files directly since Node's CVE-2024-27980
// fix; go through the shell with each argument double-quoted.
export function windowsCommandLine(args: string[]): string {
  return ["gcloud.cmd", ...args.map((arg) => `"${arg.replaceAll('"', '""')}"`)].join(" ");
}

function spawnGcloud(args: string[], output: "pipe" | "inherit"): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    // Never hand gcloud our stdin: prompts are disabled, and an inherited TTY lets gcloud
    // leave the terminal in raw mode, which staircases every later line of output.
    const stdio: ["ignore", "pipe", "inherit"] | ["ignore", "inherit", "inherit"] = output === "pipe" ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"];
    const env = { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" };
    const child = process.platform === "win32" ? spawn(windowsCommandLine(args), { shell: true, stdio, env }) : spawn("gcloud", args, { stdio, env });
    let captured = "";
    if (output === "pipe" && child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        captured += chunk;
      });
    }
    child.once("error", (error: NodeJS.ErrnoException) => {
      resolveResult({ ok: false, stdout: captured, exitCode: null, ...(error.code ? { errorCode: error.code } : {}) });
    });
    child.once("close", (exitCode) => resolveResult({ ok: exitCode === 0, stdout: captured, exitCode }));
  });
}

async function defaultPrompt(question: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
    resetTty();
  }
}

function resetTty(): void {
  if (process.platform === "win32" || !process.stdout.isTTY) return;
  try {
    spawnSync("stty", ["sane"], { stdio: ["inherit", "ignore", "ignore"] });
  } catch {
    // best effort; nothing to restore if stty is unavailable
  }
}

function canRead(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function fail(print: (line: string) => void, message: string): "failed" {
  print(`Setup failed: ${message}`);
  return "failed";
}

function printManualSetup(print: (line: string) => void): void {
  print("gcloud CLI was not found. Nothing was changed.");
  print("Install it from https://cloud.google.com/sdk/docs/install, then run `seo-mcp setup` again.");
  print("Manual fallback:");
  print("1. Create or select a Google Cloud project.");
  print("2. Enable searchconsole.googleapis.com, pagespeedonline.googleapis.com, and siteverification.googleapis.com.");
  print("3. Create a service account named seo-mcp and download a JSON key ending in .key.json.");
  print("4. Add the service account email as an Owner in Search Console -> your property -> Settings -> Users and permissions.");
  print("5. Set GOOGLE_APPLICATION_CREDENTIALS to the absolute key path in your MCP client configuration.");
}
