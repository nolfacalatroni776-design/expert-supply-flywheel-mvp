import type { CandidateFilter } from "@/lib/navigation";

const evidenceRank: Record<string, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };

type CandidateStatus = {
  stage: string;
  sourceType?: string;
  humanReviewNeeded?: boolean;
  expert?: {
    evidenceLevel?: string;
    consentState?: string;
  } | null;
};

export function isCandidateEligibleForSupplyMetrics(candidate: Pick<CandidateStatus, "stage">) {
  return candidate.stage !== "screened_out" && candidate.stage !== "do_not_contact";
}

export function isHighEvidenceCandidate(candidate: CandidateStatus) {
  return (
    isCandidateEligibleForSupplyMetrics(candidate) &&
    (evidenceRank[candidate.expert?.evidenceLevel ?? "E0"] ?? 0) >= 2
  );
}

export function needsCandidateReview(candidate: CandidateStatus) {
  if (candidate.stage === "screened_out") return false;
  return (
    Boolean(candidate.humanReviewNeeded) ||
    (evidenceRank[candidate.expert?.evidenceLevel ?? "E0"] ?? 0) < 2 ||
    candidate.stage === "approved_for_outreach" ||
    candidate.stage === "do_not_contact" ||
    ["unsubscribed", "do_not_contact", "delete_requested"].includes(candidate.expert?.consentState ?? "")
  );
}

export function filterCandidatePipeline<T extends CandidateStatus>(candidates: T[], filter: CandidateFilter) {
  if (filter === "external") {
    return candidates.filter(
      (candidate) => candidate.sourceType === "external" && isCandidateEligibleForSupplyMetrics(candidate),
    );
  }
  if (filter === "screenedOut") return candidates.filter((candidate) => candidate.stage === "screened_out");
  if (filter === "highEvidence") return candidates.filter(isHighEvidenceCandidate);
  if (filter === "outreachReady") {
    return candidates.filter((candidate) => {
      const consentOk = !["unsubscribed", "do_not_contact", "delete_requested"].includes(
        candidate.expert?.consentState ?? "",
      );
      return (
        isHighEvidenceCandidate(candidate) &&
        consentOk &&
        !candidate.humanReviewNeeded &&
        candidate.stage === "approved_for_outreach"
      );
    });
  }
  if (filter === "review") return candidates.filter(needsCandidateReview);
  if (filter === "trial") return candidates.filter((candidate) => candidate.stage === "trial");
  if (filter === "active") return candidates.filter((candidate) => ["onboarded", "active"].includes(candidate.stage));
  return candidates;
}

export function preserveManualScreeningDecision<
  T extends { humanReviewNeeded: boolean; nextAction: string | null },
>(
  existing: { stage: string; humanReviewNeeded: boolean; nextAction: string | null } | null | undefined,
  incoming: T,
): T {
  if (existing?.stage !== "screened_out") return incoming;
  return {
    ...incoming,
    humanReviewNeeded: false,
    nextAction: existing.nextAction ?? "本项目暂不推进。如有新证据，可重新复核。",
  };
}
