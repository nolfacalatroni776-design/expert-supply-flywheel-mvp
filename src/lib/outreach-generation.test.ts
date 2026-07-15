import { describe, expect, it, vi } from "vitest";
import { generateOutreachDraftWithRecovery } from "@/lib/outreach-generation";

const validDraft = {
  subject: "Python 代码评审专家邀请",
  body: "您好，我们希望邀请您参与 Python 代码评审项目。如不希望继续联系，请直接告知。",
  replyTemplates: { unsubscribe: "请停止后续联系。" },
};

describe("generateOutreachDraftWithRecovery", () => {
  it("retries one schema-invalid model response before using fallback", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "返回内容格式不完整", rawText: '{"body":"truncated"}', usage: null })
      .mockResolvedValueOnce({ ok: true, data: validDraft, rawText: JSON.stringify(validDraft), usage: { total_tokens: 10 } });

    const result = await generateOutreachDraftWithRecovery({ generate, fallback: () => ({ ...validDraft, subject: "fallback" }) });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ draft: validDraft, fallback: false, attempts: 2 });
  });

  it("does not retry authorization or rate-limit failures", async () => {
    const generate = vi.fn().mockResolvedValue({
      ok: false,
      error: "服务繁忙或额度受限",
      rawText: "provider response",
      usage: null,
      status: 429,
    });

    const result = await generateOutreachDraftWithRecovery({ generate, fallback: () => ({ ...validDraft, subject: "fallback" }) });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ draft: { subject: "fallback" }, fallback: true, attempts: 1 });
  });

  it("falls back after a second invalid structured response", async () => {
    const generate = vi.fn().mockResolvedValue({
      ok: false,
      error: "返回内容格式不完整",
      rawText: "{}",
      usage: null,
    });

    const result = await generateOutreachDraftWithRecovery({ generate, fallback: () => ({ ...validDraft, subject: "fallback" }) });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ draft: { subject: "fallback" }, fallback: true, attempts: 2 });
    expect(result.failures).toHaveLength(2);
  });
});
