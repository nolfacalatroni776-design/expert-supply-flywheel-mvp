import { PIPELINE_STAGES, MARKETING_POST_STATUSES } from "./constants";

type MarketingPostStatus = (typeof MARKETING_POST_STATUSES)[number];
type PipelineStage = (typeof PIPELINE_STAGES)[number];

const marketingTransitions: Record<MarketingPostStatus, MarketingPostStatus[]> = {
  draft: ["needs_review", "approved", "archived"],
  needs_review: ["approved", "archived"],
  approved: ["scheduled", "published", "archived"],
  scheduled: ["published", "archived"],
  published: ["archived"],
  archived: [],
};

const candidateTransitions: Record<PipelineStage, PipelineStage[]> = {
  sourced: ["enriched", "verified", "do_not_contact"],
  enriched: ["verified", "screening", "do_not_contact"],
  verified: ["approved_for_outreach", "screening", "trial", "do_not_contact"],
  approved_for_outreach: ["contacted", "do_not_contact"],
  contacted: ["replied", "screening", "do_not_contact"],
  replied: ["screening", "trial", "do_not_contact"],
  screening: ["trial", "contracting", "do_not_contact"],
  trial: ["contracting", "onboarded", "do_not_contact"],
  contracting: ["onboarded", "active", "do_not_contact"],
  onboarded: ["active", "do_not_contact"],
  active: ["do_not_contact"],
  do_not_contact: [],
};

export function canTransitionMarketingPost(from: string, to: string): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: true };
  if (!isMarketingStatus(from) || !isMarketingStatus(to)) {
    return { ok: false, reason: "Invalid marketing post status." };
  }
  if (!marketingTransitions[from].includes(to)) {
    return {
      ok: false,
      reason:
        to === "published"
          ? "Marketing posts must be approved before they can be marked internally published."
          : `Cannot transition marketing post from ${from} to ${to}.`,
    };
  }
  return { ok: true };
}

export function canTransitionCandidateStage(from: string, to: string): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: true };
  if (!isPipelineStage(from) || !isPipelineStage(to)) {
    return { ok: false, reason: "Invalid pipeline stage." };
  }
  if (!candidateTransitions[from].includes(to)) {
    return { ok: false, reason: `Cannot transition candidate from ${from} to ${to}.` };
  }
  return { ok: true };
}

function isMarketingStatus(status: string): status is MarketingPostStatus {
  return (MARKETING_POST_STATUSES as readonly string[]).includes(status);
}

function isPipelineStage(stage: string): stage is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(stage);
}
