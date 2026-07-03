import { describe, expect, it } from "vitest";
import { publicErrorMessage, redactForAudit } from "./redaction";

describe("redaction", () => {
  it("redacts tokens, bearer values, emails, phones, and URLs", () => {
    const message =
      "Bearer secret.token.value sk-1234567890abcdef user@example.com +1 415 555 1212 https://example.com/path";
    const redacted = publicErrorMessage(message);
    expect(redacted).not.toContain("secret.token.value");
    expect(redacted).not.toContain("sk-1234567890abcdef");
    expect(redacted).not.toContain("user@example.com");
    expect(redacted).not.toContain("415 555");
    expect(redacted).not.toContain("https://example.com/path");
  });

  it("redacts nested audit payloads", () => {
    const redacted = redactForAudit({
      error: "token sk-1234567890abcdef",
      nested: { email: "user@example.com" },
    });
    expect(redacted.error).toBe("token sk-***");
    expect(redacted.nested.email).toBe("[redacted-email]");
  });
});
