import { describe, expect, it } from "vitest";
import {
  MANUAL_OUTREACH_ACTION_LABEL,
  MANUAL_OUTREACH_SUCCESS_MESSAGE,
  formatOutreachDraftStatus,
} from "@/lib/outreach-status";

describe("manual outreach status copy", () => {
  it("does not imply that the platform sent an email", () => {
    expect(formatOutreachDraftStatus("sent")).toBe("已记录人工触达");
    expect(formatOutreachDraftStatus("draft")).toBe("草稿");
    expect(MANUAL_OUTREACH_ACTION_LABEL).toBe("记录人工触达");
    expect(MANUAL_OUTREACH_SUCCESS_MESSAGE).toBe("已记录人工触达状态。");
  });
});
