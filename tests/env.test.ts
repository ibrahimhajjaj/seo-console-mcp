import { describe, expect, it } from "vitest";
import { dropUnsetVariables } from "../src/env.js";

describe("dropUnsetVariables", () => {
  it("removes blank and whitespace-only values of this server's variables", () => {
    const env: NodeJS.ProcessEnv = { SEO_MCP_CRUX_KEY: "", SEO_MCP_PLAY_BUCKET: "   ", GOOGLE_ADS_CUSTOMER_ID: "" };
    dropUnsetVariables(env);
    expect(env).toEqual({});
  });

  it("removes a template a host left unfilled", () => {
    const env: NodeJS.ProcessEnv = { SEO_MCP_CREDENTIALS: "${user_config.credentials}" };
    dropUnsetVariables(env);
    expect(env).toEqual({});
  });

  it("lets a blank override fall through to the variable behind it", () => {
    const env: NodeJS.ProcessEnv = { SEO_MCP_CREDENTIALS: "", GOOGLE_APPLICATION_CREDENTIALS: "/abs/key.json" };
    dropUnsetVariables(env);
    expect(env.SEO_MCP_CREDENTIALS ?? env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/abs/key.json");
  });

  it("keeps real values, including ones that only contain a dollar sign", () => {
    const env: NodeJS.ProcessEnv = { SEO_MCP_PAGESPEED_KEY: "abc", GOOGLE_ADS_CLIENT_SECRET: "x${y}z" };
    dropUnsetVariables(env);
    expect(env).toEqual({ SEO_MCP_PAGESPEED_KEY: "abc", GOOGLE_ADS_CLIENT_SECRET: "x${y}z" });
  });

  it("leaves other variables alone", () => {
    const env: NodeJS.ProcessEnv = { HOME: "", GOOGLE_APPLICATION_CREDENTIALS_EXTRA: "", PATH: "${x}" };
    dropUnsetVariables(env);
    expect(env).toEqual({ HOME: "", GOOGLE_APPLICATION_CREDENTIALS_EXTRA: "", PATH: "${x}" });
  });
});
