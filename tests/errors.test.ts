import { describe, expect, it } from "vitest";
import { formatToolError } from "../src/errors.js";

describe("formatToolError", () => {
  it("surfaces Google status, reason, message, and property guidance", () => {
    const message = formatToolError({
      message: "request failed",
      response: { status: 403, data: { error: { message: "User does not have sufficient permission", errors: [{ reason: "forbidden" }] } } },
    });
    expect(message).toContain("Google API 403 (forbidden)");
    expect(message).toContain("User does not have sufficient permission");
    expect(message).toContain("Settings -> Users and permissions");
  });

  it("preserves ordinary non-Google errors without a misleading prefix", () => {
    expect(formatToolError(new Error("Page fetch timed out"))).toBe("Page fetch timed out");
  });
});
