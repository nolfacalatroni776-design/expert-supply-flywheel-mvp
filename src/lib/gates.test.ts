import { describe, expect, it } from "vitest";
import { canApproveForOutreach } from "./gates";

const baseExpert = {
  evidenceLevel: "E2",
  consentState: "unknown",
  contactJson: JSON.stringify({ email: "expert@example.com", contactPermissionBasis: "direct_consent" }),
  sourceUrl: "https://example.com/profile",
};
const baseCandidate = { risksJson: JSON.stringify([]), humanReviewNeeded: false, fitScore: 82, stage: "verified" };

describe("canApproveForOutreach", () => {
  it("allows E2 candidates with a contact path", () => {
    expect(canApproveForOutreach({ candidate: baseCandidate, expert: baseExpert })).toEqual({ ok: true });
  });

  it("blocks candidates still requiring human review", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, humanReviewNeeded: true },
      expert: baseExpert,
    });
    expect(result).toEqual({ ok: false, reason: "Candidate requires human review before outreach." });
  });

  it("blocks candidates below the outreach score threshold", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, fitScore: 74 },
      expert: baseExpert,
    });
    expect(result).toEqual({ ok: false, reason: "Fit score must be 75 or higher before outreach." });
  });

  it("blocks candidates without a score", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, fitScore: null },
      expert: baseExpert,
    });
    expect(result).toEqual({ ok: false, reason: "Fit score must be 75 or higher before outreach." });
  });

  it("blocks low evidence candidates", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: { ...baseExpert, evidenceLevel: "E1" },
    });
    expect(result.ok).toBe(false);
  });

  it("blocks opt-outs", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: { ...baseExpert, consentState: "do_not_contact" },
    });
    expect(result.ok).toBe(false);
  });

  it("blocks missing contact path", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: { ...baseExpert, contactJson: "{}", sourceUrl: null },
    });
    expect(result.ok).toBe(false);
  });

  it("does not treat email as compliant without permission basis", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: { ...baseExpert, contactJson: JSON.stringify({ email: "expert@example.com" }) },
    });
    expect(result).toEqual({ ok: false, reason: "No compliant contact path is recorded." });
  });

  it("blocks project-level do-not-contact stage", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, stage: "do_not_contact" },
      expert: baseExpert,
    });
    expect(result).toEqual({ ok: false, reason: "Candidate is marked do not contact for this project." });
  });

  it("does not treat a profile URL as a compliant contact path without explicit permission", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: {
        ...baseExpert,
        contactJson: JSON.stringify({ profileUrl: "https://example.com/profile" }),
        sourceUrl: "https://example.com/profile",
      },
    });
    expect(result).toEqual({ ok: false, reason: "No compliant contact path is recorded." });
  });

  it("allows public profile outreach only when permission basis is explicit", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: {
        ...baseExpert,
        contactJson: JSON.stringify({
          profileUrl: "https://example.com/profile",
          contactPermissionBasis: "public_outreach_allowed",
        }),
        sourceUrl: "https://example.com/profile",
      },
    });
    expect(result).toEqual({ ok: true });
  });

  it("keeps regulated projects behind human review", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, humanReviewNeeded: true },
      expert: baseExpert,
      project: { riskLevel: "regulated", domain: "医学影像" },
    });
    expect(result).toEqual({
      ok: false,
      reason: "Regulated or high-risk project requires human review before outreach.",
    });
  });
});
