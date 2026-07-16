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

  it.each(["1", "true", " TRUE "])("allows explicit public production access with %j", (publicAccess) => {
    expect(
      resolveAccessProtection({
        environment: "production",
        user: "ops",
        password: "secret",
        publicAccess,
      }),
    ).toBe("disabled");
  });

  it.each(["0", "false", "yes", ""])("does not make production public with %j", (publicAccess) => {
    expect(
      resolveAccessProtection({
        environment: "production",
        user: "ops",
        password: "secret",
        publicAccess,
      }),
    ).toBe("enabled");
  });
});
