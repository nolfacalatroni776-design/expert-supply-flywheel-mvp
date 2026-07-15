import { describe, expect, it } from "vitest";
import {
  buildMarketingChannelBrief,
  ensureExecutableMarketingCta,
  generateMarketingByChannel,
  mergeMarketingReviewNotes,
  sanitizeMarketingPostClaims,
} from "@/lib/marketing-generation";
import type { MarketingCampaignOutput } from "@/lib/schemas";

function campaign(channel: MarketingCampaignOutput["posts"][number]["channel"], marker: string): MarketingCampaignOutput {
  return {
    campaignSummary: `${marker} campaign`,
    audience: ["专家"],
    posts: [
      {
        channel,
        title: `${marker} title`,
        body: `${marker} body with project requirements and review process.`,
        cta: `${marker} CTA`,
        hashtags: [marker],
        riskNotes: ["人工复核"],
      },
    ],
    reviewChecklist: [`${marker} review`],
  };
}

describe("generateMarketingByChannel", () => {
  it("adds a bounded one-channel writing brief", () => {
    const brief = buildMarketingChannelBrief("强调公开贡献。", "xiaohongshu");

    expect(brief).toContain("xiaohongshu");
    expect(brief).toContain("只生成这一条");
    expect(brief).toContain("250-450");
  });

  it("deduplicates and bounds the review list shown to channel operators", () => {
    const notes = mergeMarketingReviewNotes(
      ["确认报名动作", "确认报名动作", "Check that no private candidate names, customer names, or internal IDs appear in the body."],
      ["Confirm the post is marked as draft and not auto-scheduled.", ...Array.from({ length: 20 }, (_, index) => `检查项 ${index}`)],
      ["不得承诺收益"],
    );

    expect(notes).toHaveLength(6);
    expect(notes[0]).toBe("确认报名动作");
    expect(notes).toContain("不得承诺收益");
    expect(notes.join(" ")).not.toContain("Confirm the post");
    expect(notes).toContain("确认文案不包含候选隐私、客户名称或内部标识。");
  });

  it("removes an unsupported paid-trial claim while preserving an explicitly funded trial", () => {
    const post = campaign("linkedin", "ai").posts[0];
    const unsupported = sanitizeMarketingPostClaims(
      { ...post, body: "Complete a small paid trial task before formal assignment." },
      "项目包含小规模试标和人工复核。",
    );
    const supported = sanitizeMarketingPostClaims(
      { ...post, body: "Complete a small paid trial task before formal assignment." },
      "本项目明确提供 paid trial，试标通过后进入正式任务。",
    );

    expect(unsupported.body).toBe("Complete a small trial task before formal assignment.");
    expect(supported.body).toContain("paid trial");
  });

  it("replaces an unconfigured project-page CTA with a channel-native action", () => {
    expect(ensureExecutableMarketingCta("linkedin", "Apply through the project page.")).toContain("私信");
    expect(ensureExecutableMarketingCta("xiaohongshu", "请私信发布账号并附上公开主页")).toBe(
      "请私信发布账号并附上公开主页",
    );
    expect(ensureExecutableMarketingCta("linkedin", "Apply at https://apply.example/jobs/123")).toBe(
      "Apply at https://apply.example/jobs/123",
    );
  });

  it("runs channels sequentially by default to respect model concurrency limits", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await generateMarketingByChannel({
      channels: ["linkedin", "wechat", "community"],
      audience: ["专家"],
      generate: async (channel) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { ok: true, data: campaign(channel, channel), usage: null };
      },
      fallback: (channels) => ({
        ...campaign(channels[0], "fallback"),
        posts: channels.map((channel) => campaign(channel, "fallback").posts[0]),
      }),
    });

    expect(maxInFlight).toBe(1);
  });

  it("keeps successful model output for every requested channel", async () => {
    const result = await generateMarketingByChannel({
      channels: ["linkedin", "wechat"],
      audience: ["Python 专家"],
      generate: async (channel) => ({ ok: true, data: campaign(channel, channel), usage: { channel } }),
      fallback: (channels) => ({
        ...campaign(channels[0], "fallback"),
        posts: channels.map((channel) => campaign(channel, "fallback").posts[0]),
      }),
    });

    expect(result.campaign.posts.map((post) => post.title)).toEqual(["linkedin title", "wechat title"]);
    expect(result.successfulChannels).toEqual(["linkedin", "wechat"]);
    expect(result.fallbackChannels).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("falls back only the failed channel and reports the reason", async () => {
    const result = await generateMarketingByChannel({
      channels: ["linkedin", "wechat"],
      audience: ["Python 专家"],
      generate: async (channel) =>
        channel === "linkedin"
          ? { ok: true, data: campaign(channel, "ai"), usage: { total_tokens: 20 } }
          : { ok: false, error: "Model response was not valid JSON." },
      fallback: (channels) => ({
        ...campaign(channels[0], "fallback"),
        posts: channels.map((channel) => campaign(channel, "fallback").posts[0]),
      }),
    });

    expect(result.campaign.posts.map((post) => [post.channel, post.title])).toEqual([
      ["linkedin", "ai title"],
      ["wechat", "fallback title"],
    ]);
    expect(result.successfulChannels).toEqual(["linkedin"]);
    expect(result.fallbackChannels).toEqual(["wechat"]);
    expect(result.failures).toEqual([{ channel: "wechat", reason: "Model response was not valid JSON." }]);
  });

  it("rejects a model post for the wrong channel instead of mislabeling it", async () => {
    const result = await generateMarketingByChannel({
      channels: ["linkedin"],
      audience: [],
      generate: async () => ({ ok: true, data: campaign("wechat", "wrong"), usage: null }),
      fallback: (channels) => ({
        ...campaign(channels[0], "fallback"),
        posts: channels.map((channel) => campaign(channel, "fallback").posts[0]),
      }),
    });

    expect(result.campaign.posts[0].title).toBe("fallback title");
    expect(result.failures[0].reason).toContain("requested channel");
  });

  it("turns a thrown channel request into a local fallback", async () => {
    const result = await generateMarketingByChannel({
      channels: ["community"],
      audience: [],
      generate: async () => {
        throw new Error("network timeout");
      },
      fallback: (channels) => ({
        ...campaign(channels[0], "fallback"),
        posts: channels.map((channel) => campaign(channel, "fallback").posts[0]),
      }),
    });

    expect(result.fallbackChannels).toEqual(["community"]);
    expect(result.failures).toEqual([{ channel: "community", reason: "network timeout" }]);
  });
});
