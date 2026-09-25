// Builds two MCPB bundles holding the compiled server and its production
// dependencies, for hosts and directories that install a local server from a
// single file. The version and the tool list are filled in from the package and
// the built server, so a bundle cannot drift from the build it carries.
//
// mcpb/seo-console-mcp.mcpb follows the MCPB manifest schema, which allows only a
// name and description per tool. mcpb/seo-console-mcp.smithery.mcpb is the same
// archive with each tool's input schema added to the manifest: Smithery turns the
// manifest's tool list into its server card and refuses a tool without one, while
// the MCPB validator refuses a tool that has one.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "mcpb", "build");
const output = join(root, "mcpb", "seo-console-mcp.mcpb");
const smitheryOutput = join(root, "mcpb", "seo-console-mcp.smithery.mcpb");
const mcpb = ["--yes", "@anthropic-ai/mcpb@2.1.2"];

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
const tools = await listTools();
manifest.version = pkg.version;
manifest.tools = tools.map(({ name, description }) => ({ name, description }));

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });
cpSync(join(root, "dist"), join(stage, "server", "dist"), { recursive: true });
for (const file of ["package.json", "package-lock.json"]) cpSync(join(root, file), join(stage, "server", file));
for (const file of ["README.md", "LICENSE"]) cpSync(join(root, file), join(stage, file));
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: join(stage, "server"), stdio: "inherit" });
execFileSync("npx", [...mcpb, "validate", join(stage, "manifest.json")], { stdio: "inherit" });
execFileSync("npx", [...mcpb, "pack", stage, output], { stdio: "inherit" });

const scratch = mkdtempSync(join(tmpdir(), "seo-mcpb-"));
try {
  writeFileSync(join(scratch, "manifest.json"), JSON.stringify({ ...manifest, tools }, null, 2) + "\n");
  copyFileSync(output, smitheryOutput);
  execFileSync("zip", ["-q", smitheryOutput, "manifest.json"], { cwd: scratch, stdio: "inherit" });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`Output: ${smitheryOutput}`);

async function listTools() {
  const client = new Client({ name: "build-mcpb", version: pkg.version });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "index.js")], stderr: "ignore" }));
  try {
    const { tools } = await client.listTools();
    return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  } finally {
    await client.close();
  }
}
