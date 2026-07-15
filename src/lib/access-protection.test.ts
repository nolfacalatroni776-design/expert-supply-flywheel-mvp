import { describe, expect, it } from "vitest";
import { resolveAccessProtection } from "@/lib/access-protection";

describe("resolveAccessProtection", () => {
  it("fails closed when production access credentials are missing", () => {
    expect(resolveAccessProtection({ environment: "production", user: "", password: "" })).toBe("misconfigured");
  });

  it("allows credential-free local development", () => {
    expect(resolveAccessProtection({ environment: "development", user: "", password: "" })).toBe("disabled");
  });

  it("enables protection when both credentials exist", () => {
    expect(resolveAccessProtection({ environment: "production", user: "ops", password: "secret" })).toBe("enabled");
  });
});
