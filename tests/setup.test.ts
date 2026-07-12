import { describe, expect, it, vi } from "vitest";
import { runSetupWizard, windowsCommandLine, type CommandResult, type SetupRunner } from "../src/setup.js";

function runnerWith(handler: (args: string[]) => CommandResult | Promise<CommandResult>): SetupRunner {
  return {
    capture: vi.fn((args: string[]) => Promise.resolve(handler(args))),
    inherit: vi.fn((args: string[]) => Promise.resolve(handler(args))),
  };
}

describe("setup wizard", () => {
  it("prints manual setup and exits gracefully when gcloud is absent", async () => {
    const runner = runnerWith(() => ({ ok: false, stdout: "", exitCode: null, errorCode: "ENOENT" }));
    const lines: string[] = [];
    const outcome = await runSetupWizard({ runner, print: (line) => lines.push(line), cwd: "/tmp/project", prompt: vi.fn() });
    expect(outcome).toBe("manual");
    expect(lines.join("\n")).toContain("gcloud CLI was not found");
    expect(lines.join("\n")).toContain("Search Console -> your property -> Settings -> Users and permissions");
  });

  it("prints manual setup and exits gracefully when gcloud cannot be launched", async () => {
    const runner = runnerWith(() => ({ ok: false, stdout: "", exitCode: null, errorCode: "EINVAL" }));
    const lines: string[] = [];
    const outcome = await runSetupWizard({ runner, print: (line) => lines.push(line), cwd: "/tmp/project", prompt: vi.fn() });
    expect(outcome).toBe("manual");
    expect(lines.join("\n")).toContain("gcloud CLI was not found");
  });

  it("creates missing resources and prints client configuration", async () => {
    const runner = runnerWith((args) => {
      const key = args.join(" ");
      if (key.includes("auth list")) return { ok: true, stdout: "owner@example.com\n", exitCode: 0 };
      if (key.includes("iam service-accounts describe")) return { ok: false, stdout: "", exitCode: 1 };
      return { ok: true, stdout: "", exitCode: 0 };
    });
    const lines: string[] = [];
    const outcome = await runSetupWizard({
      runner, print: (line) => lines.push(line), cwd: "/work/seo-mcp", projectId: "seo-project-123", keyPath: "./seo-mcp.key.json", prompt: vi.fn(),
    });
    expect(outcome).toBe("ready");
    expect(runner.inherit).toHaveBeenCalledWith(expect.arrayContaining(["projects", "describe", "seo-project-123"]));
    expect(runner.inherit).toHaveBeenCalledWith(expect.arrayContaining(["services", "enable", "searchconsole.googleapis.com", "pagespeedonline.googleapis.com"]));
    expect(runner.inherit).toHaveBeenCalledWith(expect.arrayContaining(["iam", "service-accounts", "create", "seo-mcp"]));
    expect(runner.inherit).toHaveBeenCalledWith(expect.arrayContaining(["iam", "service-accounts", "keys", "create", "/work/seo-mcp/seo-mcp.key.json"]));
    const output = lines.join("\n");
    expect(output).toContain("seo-mcp@seo-project-123.iam.gserviceaccount.com");
    expect(output).toContain("GOOGLE_APPLICATION_CREDENTIALS");
  });

  it("re-prompts on an invalid project ID instead of failing", async () => {
    const runner = runnerWith((args) => {
      if (args.includes("list") && args.includes("auth")) return { ok: true, stdout: "owner@example.com\n", exitCode: 0 };
      if (args.includes("get-value")) return { ok: true, stdout: "(unset)", exitCode: 0 };
      if (args.includes("iam") && args.includes("describe")) return { ok: false, stdout: "", exitCode: 1 };
      return { ok: true, stdout: "", exitCode: 0 };
    });
    const lines: string[] = [];
    const prompt = vi.fn()
      .mockResolvedValueOnce("seo")            // too short
      .mockResolvedValueOnce("Bad_Project")    // illegal characters
      .mockResolvedValueOnce("example-seo-project");  // valid
    const outcome = await runSetupWizard({
      runner, print: (line) => lines.push(line), cwd: "/work", keyPath: "/work/seo-mcp.key.json",
      makeDir: vi.fn(), fileExists: () => false, prompt,
    });
    expect(outcome).toBe("ready");
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(lines.join("\n")).toContain("not a valid project ID");
    expect(runner.inherit).toHaveBeenCalledWith(expect.arrayContaining(["projects", "describe", "example-seo-project"]));
  });

  it("writes the key to a cwd-independent config path when --key is omitted", async () => {
    const runner = runnerWith((args) => {
      if (args.includes("list") && args.includes("auth")) return { ok: true, stdout: "owner@example.com\n", exitCode: 0 };
      if (args.includes("iam") && args.includes("describe")) return { ok: false, stdout: "", exitCode: 1 };
      return { ok: true, stdout: "", exitCode: 0 };
    });
    const madeDirs: string[] = [];
    const outcome = await runSetupWizard({
      runner, print: () => {}, cwd: "/some/other/repo", projectId: "example-seo-project",
      makeDir: (dir) => madeDirs.push(dir), fileExists: () => false, prompt: vi.fn(),
    });
    expect(outcome).toBe("ready");
    const keyCreate = (runner.inherit as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as string[])
      .find((args) => args.includes("keys") && args.includes("create"));
    const writtenPath = keyCreate?.[keyCreate.indexOf("create") + 1] ?? "";
    expect(writtenPath).toContain("seo-mcp/seo-mcp.key.json");
    expect(writtenPath).not.toContain("/some/other/repo");
    expect(madeDirs.some((dir) => dir.endsWith("seo-mcp"))).toBe(true);
  });

  it("skips existing service account and key safely", async () => {
    const runner = runnerWith((args) => {
      if (args.includes("list") && args.includes("auth")) return { ok: true, stdout: "owner@example.com\n", exitCode: 0 };
      return { ok: true, stdout: "", exitCode: 0 };
    });
    const lines: string[] = [];
    const outcome = await runSetupWizard({
      runner, print: (line) => lines.push(line), cwd: "/work", projectId: "existing-project", keyPath: "/already/seo-mcp.key.json",
      fileExists: () => true, prompt: vi.fn(),
    });
    expect(outcome).toBe("ready");
    expect(runner.inherit).not.toHaveBeenCalledWith(expect.arrayContaining(["service-accounts", "create"]));
    expect(runner.inherit).not.toHaveBeenCalledWith(expect.arrayContaining(["keys", "create"]));
    expect(lines.join("\n")).toContain("already exists; keeping it");
  });
});

describe("windowsCommandLine", () => {
  it("quotes a simple argument", () => {
    expect(windowsCommandLine(["version"])).toBe('gcloud.cmd "version"');
  });

  it("preserves spaces inside a quoted argument", () => {
    expect(windowsCommandLine(["--display-name=SEO MCP"])).toBe('gcloud.cmd "--display-name=SEO MCP"');
  });

  it("doubles embedded double quotes", () => {
    expect(windowsCommandLine(['--format="value"'])).toBe('gcloud.cmd "--format=""value"""');
  });
});
