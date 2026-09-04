import { afterEach, describe, expect, it, vi } from "vitest";
import { submitIndexNow } from "../src/indexnow.js";

const KEY = "a1b2c3d4e5f6a7b8";

function params(overrides: Record<string, unknown> = {}) {
  return {
    urls: ["https://example.com/a", "https://example.com/b"],
    key: KEY,
    endpoint: "api.indexnow.org" as const,
    dryRun: false,
    ...overrides,
  };
}

describe("submitIndexNow", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("posts the host, key, and URL list to the endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 200 }));

    const output = await submitIndexNow(params(), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.indexnow.org/indexnow", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toEqual({
      host: "example.com",
      key: KEY,
      urlList: ["https://example.com/a", "https://example.com/b"],
    });
    expect(output.structuredContent).toMatchObject({
      success: true,
      statusCode: 200,
      host: "example.com",
      urlCount: 2,
    });
  });

  it("sends the key location to the endpoint but keeps it out of the output", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 202 }));

    const output = await submitIndexNow(params({ keyLocation: `https://example.com/keys/${KEY}.txt` }), { fetchImpl });

    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toMatchObject({ keyLocation: `https://example.com/keys/${KEY}.txt` });
    expect(output.structuredContent).toMatchObject({ success: true, statusCode: 202 });
    expect(JSON.stringify(output)).not.toContain(KEY);
  });

  it("explains a rejected key without echoing it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 403 }));

    const output = await submitIndexNow(params({ keyLocation: `https://example.com/${KEY}.txt` }), { fetchImpl });

    expect(output.structuredContent).toMatchObject({ success: false, statusCode: 403 });
    expect(output.content[0]?.text).toContain("Key not valid");
    expect(JSON.stringify(output)).not.toContain(KEY);
  });

  it("falls back to SEO_MCP_INDEXNOW_KEY", async () => {
    vi.stubEnv("SEO_MCP_INDEXNOW_KEY", KEY);
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 200 }));

    await submitIndexNow(params({ key: undefined }), { fetchImpl });

    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toMatchObject({ key: KEY });
  });

  it("requires a key from the parameter or environment", async () => {
    vi.stubEnv("SEO_MCP_INDEXNOW_KEY", "");
    const fetchImpl = vi.fn();

    await expect(submitIndexNow(params({ key: undefined }), { fetchImpl })).rejects.toThrow("IndexNow key is required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a malformed environment key", async () => {
    vi.stubEnv("SEO_MCP_INDEXNOW_KEY", "too short");

    await expect(submitIndexNow(params({ key: undefined }))).rejects.toThrow("8-128 characters");
  });

  it("rejects URLs spanning multiple hosts", async () => {
    const fetchImpl = vi.fn();

    await expect(
      submitIndexNow(
        params({
          urls: ["https://example.com/a", "https://other.example/b"],
        }),
        { fetchImpl },
      ),
    ).rejects.toThrow("one host");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a key location on a different host", async () => {
    await expect(submitIndexNow(params({ keyLocation: "https://other.example/key.txt" }))).rejects.toThrow("keyLocation must be hosted on example.com");
  });

  it("does not notify the endpoint on a dry run", async () => {
    const fetchImpl = vi.fn();

    const output = await submitIndexNow(params({ dryRun: true, keyLocation: `https://example.com/${KEY}.txt` }), { fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output.structuredContent).toMatchObject({ success: true, dryRun: true, statusCode: null });
    expect(JSON.stringify(output)).not.toContain(KEY);
  });
});
