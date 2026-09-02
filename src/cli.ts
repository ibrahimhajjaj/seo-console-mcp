export type CliCommand =
  | { kind: "help" }
  | { kind: "serve"; credentials?: string }
  | { kind: "setup"; projectId?: string; keyPath?: string; pagespeedKey?: boolean }
  | { kind: "verify"; domains: string[]; credentials?: string; cfToken?: string }
  | QueryCommand;

export interface QueryCommand {
  kind: "query";
  tool?: string;
  params: Record<string, string>;
  out?: string;
  credentials?: string;
  help: boolean;
  allowWrite: boolean;
}

export class UsageError extends Error {}

type CommandKind = Exclude<CliCommand["kind"], "help" | "query">;

const allowedFlags: Record<CommandKind, ReadonlySet<string>> = {
  serve: new Set(["--credentials"]),
  setup: new Set(["--project", "--key", "--pagespeed-key", "--no-pagespeed-key"]),
  verify: new Set(["--credentials", "--cf-token"]),
};

const knownFlags = new Set(Object.values(allowedFlags).flatMap((flags) => [...flags]));

function optionValue(args: string[], index: number): string {
  const flag = args[index];
  const value = args[index + 1];
  if (!flag || !value || value.startsWith("--")) {
    throw new UsageError(`${flag ?? "option"} requires a value`);
  }
  return value;
}

export function parseCliArgs(args: string[]): CliCommand {
  // `query` takes arbitrary --param flags and its own --help, so it is parsed
  // before the global help check that the other commands share.
  if (args[0] === "query") return parseQueryArgs(args.slice(1));
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };

  const first = args[0];
  const kind: CommandKind = first === "setup" || first === "verify" ? first : "serve";
  const commandArgs = kind === "serve" ? args : args.slice(1);
  const domains: string[] = [];
  let credentials: string | undefined;
  let projectId: string | undefined;
  let keyPath: string | undefined;
  let cfToken: string | undefined;
  let pagespeedKey: boolean | undefined;

  for (let index = 0; index < commandArgs.length; index++) {
    const arg = commandArgs[index];
    if (arg === undefined) continue;

    if (arg.startsWith("-")) {
      if (!knownFlags.has(arg)) throw new UsageError(`unknown option: ${arg}`);
      if (!allowedFlags[kind].has(arg)) {
        throw new UsageError(`unknown option for ${kind}: ${arg}`);
      }

      if (arg === "--pagespeed-key" || arg === "--no-pagespeed-key") {
        pagespeedKey = arg === "--pagespeed-key";
        continue;
      }

      const value = optionValue(commandArgs, index);
      index++;
      if (arg === "--credentials" && credentials === undefined) credentials = value;
      if (arg === "--project" && projectId === undefined) projectId = value;
      if (arg === "--key" && keyPath === undefined) keyPath = value;
      if (arg === "--cf-token" && cfToken === undefined) cfToken = value;
      continue;
    }

    if (kind === "verify") {
      domains.push(arg);
      continue;
    }

    throw new UsageError(`unexpected positional argument for ${kind}: ${arg}`);
  }

  if (kind === "setup") {
    return {
      kind,
      ...(projectId ? { projectId } : {}),
      ...(keyPath ? { keyPath } : {}),
      ...(pagespeedKey !== undefined ? { pagespeedKey } : {}),
    };
  }
  if (kind === "verify") {
    return {
      kind,
      domains,
      ...(credentials ? { credentials } : {}),
      ...(cfToken ? { cfToken } : {}),
    };
  }
  return { kind, ...(credentials ? { credentials } : {}) };
}

function parseQueryArgs(args: string[]): QueryCommand {
  const params: Record<string, string> = {};
  let tool: string | undefined;
  let out: string | undefined;
  let credentials: string | undefined;
  let help = false;
  let allowWrite = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--allow-write") {
      allowWrite = true;
      continue;
    }
    if (arg.startsWith("-")) {
      const value = optionValue(args, index);
      index++;
      if (arg === "--out") {
        if (out === undefined) out = value;
        continue;
      }
      if (arg === "--credentials") {
        if (credentials === undefined) credentials = value;
        continue;
      }
      // Any other flag names a tool parameter; --site-url maps to siteUrl.
      params[kebabToCamel(arg)] = value;
      continue;
    }

    if (tool === undefined) {
      tool = arg;
      continue;
    }
    throw new UsageError(`unexpected positional argument for query: ${arg}`);
  }

  return {
    kind: "query",
    params,
    help,
    allowWrite,
    ...(tool !== undefined ? { tool } : {}),
    ...(out !== undefined ? { out } : {}),
    ...(credentials !== undefined ? { credentials } : {}),
  };
}

function kebabToCamel(flag: string): string {
  return flag.replace(/^-+/, "").replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}
