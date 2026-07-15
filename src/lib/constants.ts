export const PIPELINE_STAGES = [
  "sourced",
  "enriched",
  "verified",
  "approved_for_outreach",
  "contacted",
  "replied",
  "screening",
  "trial",
  "contracting",
  "onboarded",
  "active",
  "screened_out",
  "do_not_contact",
] as const;

export const EVIDENCE_LEVELS = ["E0", "E1", "E2", "E3", "E4"] as const;

export const RISK_LEVELS = ["low", "medium", "high", "regulated"] as const;

export const CONSENT_STATES = [
  "unknown",
  "legitimate_interest",
  "consented",
  "unsubscribed",
  "do_not_contact",
  "delete_requested",
] as const;

export const HIGH_RISK_DOMAINS = [
  "medical",
  "healthcare",
  "clinical",
  "legal",
  "finance",
  "insurance",
  "biometric",
  "defense",
  "minors",
  "safety",
];

export const MARKETING_CHANNELS = [
  "linkedin",
  "xiaohongshu",
  "wechat",
  "zhihu",
  "community",
  "email_newsletter",
] as const;

export const MARKETING_POST_STATUSES = [
  "draft",
  "needs_review",
  "approved",
  "scheduled",
  "published",
  "archived",
] as const;
