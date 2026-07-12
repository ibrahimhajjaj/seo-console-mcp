import { describe, expect, it, vi } from "vitest";
import { runVerify, type VerifyClients } from "../src/verify.js";
import type { CloudflareClient } from "../src/cloudflare.js";

function fakeCloudflare(overrides: Partial<CloudflareClient> = {}): CloudflareClient {
  return {
    findZoneId: vi.fn(async () => "zone1"),
    ensureTxtRecord: vi.fn(async () => "created" as const),
    ...overrides,
  };
}

function fakeClients(overrides: Partial<VerifyClients> = {}): VerifyClients {
  return {
    getToken: vi.fn(async () => "google-site-verification=abc"),
    verifyOwnership: vi.fn(async () => {}),
    addSite: vi.fn(async () => {}),
    ...overrides,
  };
}

const noWait = { sleep: async () => {} };

describe("runVerify", () => {
  it("runs the full pipeline and adds the property", async () => {
    const clients = fakeClients();
    const cloudflare = fakeCloudflare();
    const ok = await runVerify(["getpsst.app"], { clients, cloudflare, print: () => {}, ...noWait });
    expect(ok).toBe(true);
    expect(cloudflare.ensureTxtRecord).toHaveBeenCalledWith("zone1", "getpsst.app", "google-site-verification=abc");
    expect(clients.verifyOwnership).toHaveBeenCalledWith("getpsst.app");
    expect(clients.addSite).toHaveBeenCalledWith("getpsst.app");
  });

  it("retries verification until DNS propagates", async () => {
    const verifyOwnership = vi.fn()
      .mockRejectedValueOnce(new Error("token not found"))
      .mockRejectedValueOnce(new Error("token not found"))
      .mockResolvedValueOnce(undefined);
    const clients = fakeClients({ verifyOwnership });
    const ok = await runVerify(["getpsst.app"], { clients, cloudflare: fakeCloudflare(), print: () => {}, ...noWait });
    expect(ok).toBe(true);
    expect(verifyOwnership).toHaveBeenCalledTimes(3);
  });

  it("gives up cleanly when verification never succeeds", async () => {
    const verifyOwnership = vi.fn(async () => { throw new Error("token not found"); });
    const clients = fakeClients({ verifyOwnership });
    const lines: string[] = [];
    const ok = await runVerify(["getpsst.app"], { clients, cloudflare: fakeCloudflare(), print: (line) => lines.push(line), attempts: 3, ...noWait });
    expect(ok).toBe(false);
    expect(verifyOwnership).toHaveBeenCalledTimes(3);
    expect(lines.join("\n")).toContain("Not verified yet");
    expect(clients.addSite).not.toHaveBeenCalled();
  });

  it("treats an already-present Search Console property as success", async () => {
    const addSite = vi.fn(async () => {
      throw Object.assign(new Error("already exists"), { code: 409 });
    });
    const clients = fakeClients({ addSite });
    const lines: string[] = [];
    const ok = await runVerify(["getpsst.app"], { clients, cloudflare: fakeCloudflare(), print: (line) => lines.push(line), ...noWait });
    expect(ok).toBe(true);
    expect(lines.join("\n")).toContain("already in Search Console");
  });

  it("reports a Search Console add 400 that is not an already-present conflict", async () => {
    const addSite = vi.fn(async () => {
      throw Object.assign(new Error("Invalid site URL"), { response: { status: 400 } });
    });
    const clients = fakeClients({ addSite });
    const lines: string[] = [];
    const ok = await runVerify(["getpsst.app"], { clients, cloudflare: fakeCloudflare(), print: (line) => lines.push(line), ...noWait });
    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain("failed: Invalid site URL");
    expect(lines.join("\n")).not.toContain("already in Search Console");
  });

  it("reports a Search Console add authorization failure", async () => {
    const addSite = vi.fn(async () => {
      throw Object.assign(new Error("forbidden"), { response: { status: 403 } });
    });
    const clients = fakeClients({ addSite });
    const lines: string[] = [];
    const ok = await runVerify(["getpsst.app"], { clients, cloudflare: fakeCloudflare(), print: (line) => lines.push(line), ...noWait });
    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain("adding sc-domain:getpsst.app to Search Console failed: forbidden");
    expect(lines.join("\n")).not.toContain("Done.");
  });

  it("fails verification immediately on an authentication error", async () => {
    const verifyOwnership = vi.fn(async () => {
      throw Object.assign(new Error("unauthorized"), { response: { status: 401 } });
    });
    const clients = fakeClients({ verifyOwnership });
    const ok = await runVerify(["getpsst.app"], { clients, cloudflare: fakeCloudflare(), print: () => {}, attempts: 5, ...noWait });
    expect(ok).toBe(false);
    expect(verifyOwnership).toHaveBeenCalledTimes(1);
    expect(clients.addSite).not.toHaveBeenCalled();
  });

  it("fails fast without a Cloudflare token", async () => {
    const saved = { primary: process.env.CLOUDFLARE_API_TOKEN, fallback: process.env.CF_API_TOKEN };
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CF_API_TOKEN;
    const lines: string[] = [];
    try {
      const ok = await runVerify(["getpsst.app"], { clients: fakeClients(), print: (line) => lines.push(line) });
      expect(ok).toBe(false);
      expect(lines.join("\n")).toContain("Cloudflare API token is required");
    } finally {
      if (saved.primary !== undefined) process.env.CLOUDFLARE_API_TOKEN = saved.primary;
      if (saved.fallback !== undefined) process.env.CF_API_TOKEN = saved.fallback;
    }
  });
});
