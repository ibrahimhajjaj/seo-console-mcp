// Builds mcpb/seo-console-mcp.mcpb: an MCPB bundle holding the compiled server and
// its production dependencies, for hosts that install a local server from a single
// file. The version and the tool list are filled in from the package and the tool
// registry, so the bundle cannot drift from the build it carries.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "mcpb", "build");
const output = join(root, "mcpb", "seo-console-mcp.mcpb");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
const { toolDefinitions } = await import(join(root, "dist", "registry.js"));

manifest.version = pkg.version;
manifest.tools = toolDefinitions.map(({ name, description }) => ({ name, description }));

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });
cpSync(join(root, "dist"), join(stage, "server", "dist"), { recursive: true });
for (const file of ["package.json", "package-lock.json"]) cpSync(join(root, file), join(stage, "server", file));
for (const file of ["README.md", "LICENSE"]) cpSync(join(root, file), join(stage, file));
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: join(stage, "server"), stdio: "inherit" });
execFileSync("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "validate", join(stage, "manifest.json")], { stdio: "inherit" });
execFileSync("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "pack", stage, output], { stdio: "inherit" });
