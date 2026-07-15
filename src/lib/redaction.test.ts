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

  it("turns missing project errors into a recoverable workspace message", () => {
    expect(publicErrorMessage("Project not found.")).toContain("返回项目库重新打开");
    expect(publicErrorMessage("项目不存在或已被删除。")).toContain("返回项目库重新打开");
  });

  it("does not expose database client internals to operators", () => {
    const prismaError = `Invalid \`prisma.agentTaskRun.updateMany()\` invocation:\nUnknown argument \`executionToken\`. Available options are marked with ?.`;
    const message = publicErrorMessage(prismaError);

    expect(message).toBe("任务服务暂不可用，请稍后重试。若问题持续，请联系管理员更新服务。");
    expect(message).not.toContain("prisma");
    expect(message).not.toContain("executionToken");
    expect(message).not.toContain("Unknown argument");
  });
});
