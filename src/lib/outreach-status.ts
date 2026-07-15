export const MANUAL_OUTREACH_ACTION_LABEL = "记录人工触达";
export const MANUAL_OUTREACH_SUCCESS_MESSAGE = "已记录人工触达状态。";

export function formatOutreachDraftStatus(status: string) {
  return status === "sent" ? "已记录人工触达" : "草稿";
}
