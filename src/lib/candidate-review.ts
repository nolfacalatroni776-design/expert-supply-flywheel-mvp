import { parseJson, stringifyJson } from "@/lib/json";
import { canTransitionCandidateStage } from "@/lib/state-machines";

export type CandidateReviewDecision = "approved" | "needs_more_evidence" | "rejected";

export function buildCandidateReviewUpdate({
  decision,
  note,
  currentStage,
  missingJson,
}: {
  decision: CandidateReviewDecision;
  note: string;
  currentStage: string;
  missingJson: string;
}) {
  const normalizedNote = note.trim();

  if (decision === "rejected") {
    if (normalizedNote.length < 3) {
      throw new Error("请填写本项目暂不推进的原因。");
    }
    const transition = canTransitionCandidateStage(currentStage, "screened_out");
    if (!transition.ok) {
      throw new Error("当前候选阶段不能标记为暂不推进。");
    }
    return {
      humanReviewNeeded: false,
      stage: "screened_out",
      nextAction: `本项目暂不推进：${trimSentenceEnding(normalizedNote)}。如有新证据，可重新复核。`,
    } as const;
  }

  if (decision === "needs_more_evidence") {
    if (normalizedNote.length < 3) {
      throw new Error("请说明需要补充哪些证据。");
    }
    const missing = parseJson<unknown[]>(missingJson, [])
      .map((item) => String(item).trim())
      .filter(Boolean);
    return {
      humanReviewNeeded: true,
      missingJson: stringifyJson(Array.from(new Set([...missing, normalizedNote]))),
      nextAction: `补证据：${normalizedNote}`,
    } as const;
  }

  return {
    humanReviewNeeded: false,
    stage: nextReviewedStage(currentStage),
    nextAction: "联系路径确认后生成触达草稿。",
  } as const;
}

function nextReviewedStage(stage: string) {
  if (canTransitionCandidateStage(stage, "verified").ok) return "verified";
  return stage;
}

function trimSentenceEnding(value: string) {
  return value.replace(/[。！？.!?]+$/u, "");
}
