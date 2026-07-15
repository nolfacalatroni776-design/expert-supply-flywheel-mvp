import { describe, expect, it } from "vitest";
import { canTransitionCandidateStage, canTransitionMarketingPost } from "./state-machines";

describe("canTransitionMarketingPost", () => {
  it("requires approval before internal published marking", () => {
    expect(canTransitionMarketingPost("needs_review", "published")).toEqual({
      ok: false,
      reason: "Marketing posts must be approved before they can be marked internally published.",
    });
  });

  it("allows approved posts to be marked internally published", () => {
    expect(canTransitionMarketingPost("approved", "published")).toEqual({ ok: true });
  });

  it("does not allow changing archived posts", () => {
    expect(canTransitionMarketingPost("archived", "approved").ok).toBe(false);
  });
});

describe("canTransitionCandidateStage", () => {
  it("blocks jumping from sourced directly to onboarded", () => {
    expect(canTransitionCandidateStage("sourced", "onboarded").ok).toBe(false);
  });

  it("blocks moving a do-not-contact candidate back into outreach", () => {
    expect(canTransitionCandidateStage("do_not_contact", "contacted").ok).toBe(false);
  });

  it("keeps screened-out candidates out of outreach but allows a later verified review", () => {
    expect(canTransitionCandidateStage("sourced", "screened_out")).toEqual({ ok: true });
    expect(canTransitionCandidateStage("screened_out", "contacted").ok).toBe(false);
    expect(canTransitionCandidateStage("screened_out", "verified")).toEqual({ ok: true });
  });

  it("requires candidate reply or screening before trial", () => {
    expect(canTransitionCandidateStage("verified", "trial").ok).toBe(false);
    expect(canTransitionCandidateStage("contacted", "trial").ok).toBe(false);
    expect(canTransitionCandidateStage("replied", "trial")).toEqual({ ok: true });
  });

  it("allows the normal screening to trial to onboarded path", () => {
    expect(canTransitionCandidateStage("screening", "trial")).toEqual({ ok: true });
    expect(canTransitionCandidateStage("trial", "onboarded")).toEqual({ ok: true });
  });
});
