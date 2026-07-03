import { BailianClient, MissingBailianKeyError } from "@/lib/ai/bailian-client";
import type { ZodType } from "zod";
import {
  analyzeProjectOutputSchema,
  extractCandidatesOutputSchema,
  marketingCampaignOutputSchema,
  recruitmentRetrospectiveOutputSchema,
  outreachOutputSchema,
  scoreCandidateOutputSchema,
  supplyGapOutputSchema,
  supplyRankOutputSchema,
  trialTaskOutputSchema,
  type AnalyzeProjectOutput,
  type ExtractCandidatesOutput,
  type MarketingCampaignOutput,
  type ScoreCandidateOutput,
} from "@/lib/schemas";
import {
  CANDIDATE_EXTRACTION_PROMPT,
  MARKETING_CAMPAIGN_PROMPT,
  OUTREACH_PROMPT,
  PROJECT_ANALYSIS_PROMPT,
  RECRUITMENT_RETROSPECTIVE_PROMPT,
  SCORE_PROMPT,
  SUPPLY_GAP_PROMPT,
  SUPPLY_RANK_PROMPT,
  TRIAL_PROMPT,
} from "@/lib/ai/prompts";
import { publicErrorMessage } from "@/lib/redaction";

export type WorkflowResult<T> =
  | { ok: true; data: T; rawText: string; usage: unknown }
  | { ok: false; error: string; rawText?: string; usage?: unknown; status?: number };

function toWorkflowError(error: unknown): WorkflowResult<never> {
  if (error instanceof MissingBailianKeyError) {
    return { ok: false, error: "DASHSCOPE_API_KEY is not configured." };
  }
  if (error instanceof Error) {
    return { ok: false, error: publicErrorMessage(error.message) };
  }
  return { ok: false, error: "Unknown workflow error." };
}

async function run<T>(input: {
  taskName: string;
  systemPrompt: string;
  userPayload: unknown;
  schema: ZodType<T>;
}): Promise<WorkflowResult<T>> {
  try {
    const result = await new BailianClient().runStructured<T>(input);
    if (!result.ok) {
      return {
        ok: false,
        error: publicErrorMessage(result.error),
        rawText: result.rawText,
        usage: result.usage,
        status: result.status,
      };
    }
    return {
      ok: true,
      data: result.data,
      rawText: result.rawText,
      usage: result.usage,
    };
  } catch (error) {
    return toWorkflowError(error);
  }
}

export function analyzeProjectDemand(payload: unknown) {
  return run<AnalyzeProjectOutput>({
    taskName: "analyze_project_demand",
    systemPrompt: PROJECT_ANALYSIS_PROMPT,
    userPayload: payload,
    schema: analyzeProjectOutputSchema,
  });
}

export function extractCandidatesFromSearch(payload: unknown) {
  return run<ExtractCandidatesOutput>({
    taskName: "extract_candidates_from_search_results",
    systemPrompt: CANDIDATE_EXTRACTION_PROMPT,
    userPayload: payload,
    schema: extractCandidatesOutputSchema,
  });
}

export function scoreCandidateFit(payload: unknown) {
  return run<ScoreCandidateOutput>({
    taskName: "score_candidate_fit",
    systemPrompt: SCORE_PROMPT,
    userPayload: payload,
    schema: scoreCandidateOutputSchema,
  });
}

export function draftOutreach(payload: unknown) {
  return run<{
    subject: string;
    body: string;
    replyTemplates: {
      interested: string;
      unavailable: string;
      referral: string;
      priceQuestion: string;
      ndaQuestion: string;
      noInterest: string;
      unsubscribe: string;
      deletionRequest: string;
    };
  }>({
    taskName: "draft_outreach_and_reply_templates",
    systemPrompt: OUTREACH_PROMPT,
    userPayload: payload,
    schema: outreachOutputSchema,
  });
}

export function designTrialTask(payload: unknown) {
  return run<{
    instructions: string;
    rubric: {
      criteria: Array<{
        name: string;
        weight: number;
        description: string;
      }>;
      passThreshold: number;
      reviewNotes: string[];
    };
  }>({
    taskName: "design_trial_labeling_task",
    systemPrompt: TRIAL_PROMPT,
    userPayload: payload,
    schema: trialTaskOutputSchema,
  });
}

export function draftMarketingCampaign(payload: unknown) {
  return run<MarketingCampaignOutput>({
    taskName: "draft_marketing_campaign",
    systemPrompt: MARKETING_CAMPAIGN_PROMPT,
    userPayload: payload,
    schema: marketingCampaignOutputSchema,
  });
}

export function analyzeSupplyGap(payload: unknown) {
  return run<{
    gaps: Array<{
      gapType: string;
      description: string;
      requiredCount: number;
      availableCount: number;
      severity: "low" | "medium" | "high" | "critical";
      recommendedAction: string;
    }>;
    searchDirections: string[];
    summary: string;
  }>({
    taskName: "analyze_supply_gap",
    systemPrompt: SUPPLY_GAP_PROMPT,
    userPayload: payload,
    schema: supplyGapOutputSchema,
  });
}

export function rankSupplyCandidates(payload: unknown) {
  return run<{
    candidates: Array<{
      candidateId: string;
      conversionProbability: number;
      rankReasons: string[];
      risks: string[];
      nextAction: string;
    }>;
  }>({
    taskName: "rank_supply_candidates",
    systemPrompt: SUPPLY_RANK_PROMPT,
    userPayload: payload,
    schema: supplyRankOutputSchema,
  });
}

export function draftRecruitmentRetrospective(payload: unknown) {
  return run<{
    summary: string;
    wins: string[];
    bottlenecks: string[];
    sourceInsights: string[];
    nextActions: string[];
  }>({
    taskName: "draft_recruitment_retrospective",
    systemPrompt: RECRUITMENT_RETROSPECTIVE_PROMPT,
    userPayload: payload,
    schema: recruitmentRetrospectiveOutputSchema,
  });
}
