import type { ProjectCandidate, Expert, Project } from "@prisma/client";
import { parseJson } from "./json";

const evidenceRank: Record<string, number> = {
  E0: 0,
  E1: 1,
  E2: 2,
  E3: 3,
  E4: 4,
};

export function canApproveForOutreach({
  candidate,
  expert,
  project,
}: {
  candidate: Pick<ProjectCandidate, "risksJson" | "humanReviewNeeded" | "fitScore" | "stage">;
  expert: Pick<Expert, "evidenceLevel" | "consentState" | "contactJson" | "sourceUrl">;
  project?: Pick<Project, "riskLevel" | "domain"> | null;
}): { ok: true } | { ok: false; reason: string } {
  if (candidate.stage === "do_not_contact") {
    return { ok: false, reason: "Candidate is marked do not contact for this project." };
  }

  if (candidate.humanReviewNeeded) {
    return {
      ok: false,
      reason: requiresProjectReview(project)
        ? "Regulated or high-risk project requires human review before outreach."
        : "Candidate requires human review before outreach.",
    };
  }

  if (candidate.fitScore === null || candidate.fitScore < 75) {
    return { ok: false, reason: "Fit score must be 75 or higher before outreach." };
  }

  if ((evidenceRank[expert.evidenceLevel] ?? 0) < 2) {
    return { ok: false, reason: "Evidence level must be E2 or higher before outreach." };
  }

  if (["unsubscribed", "do_not_contact", "delete_requested"].includes(expert.consentState)) {
    return { ok: false, reason: "Candidate has opted out or requested no contact." };
  }

  const contact = parseJson<Record<string, unknown>>(expert.contactJson, {});
  const hasContactPermission =
    contact.contactPermissionBasis === "public_outreach_allowed" ||
    contact.contactPermissionBasis === "direct_consent" ||
    contact.contactPermissionBasis === "referral_consent";
  if (contact.email && !hasContactPermission) {
    return { ok: false, reason: "No compliant contact path is recorded." };
  }
  const hasApprovedProfilePath =
    Boolean(contact.profileUrl || expert.sourceUrl) &&
    (contact.allowOutreach === true ||
      contact.profileAllowsOutreach === true ||
      contact.sourceAllowsOutreach === true ||
      hasContactPermission);
  if (!contact.email && !hasApprovedProfilePath) {
    return { ok: false, reason: "No compliant contact path is recorded." };
  }

  const risks = parseJson<string[]>(candidate.risksJson, []);
  if (risks.some((risk) => risk.toLowerCase().includes("protected attribute"))) {
    return { ok: false, reason: "Risk list references protected or sensitive attributes." };
  }

  return { ok: true };
}

export function requiresProjectReview(project?: Pick<Project, "riskLevel" | "domain"> | null) {
  if (!project) return false;
  if (project.riskLevel === "regulated" || project.riskLevel === "high") return true;
  return /medical|healthcare|clinical|legal|finance|insurance|biometric|defense|minors|safety|医学|医疗|法律|金融|保险|未成年人|生物识别|国防|安全/i.test(
    project.domain ?? "",
  );
}
