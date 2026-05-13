import { describe, expect, it } from "vitest";

import { ApprovalRegistry } from "../src/approval.js";

describe("ApprovalRegistry", () => {
  it("maps short callback ids to pending approvals", () => {
    const approvals = new ApprovalRegistry();
    const buttons = approvals.register({
      sessionId: "thr_123",
      turnId: "turn_1",
      approvalId: "approval_with_a_long_id",
      title: "Codex needs to run:",
      summary: "npm test",
    });

    expect(buttons).toEqual([
      { label: "Approve", callbackId: "apgr:1" },
      { label: "Deny", callbackId: "apgr:2" },
    ]);
    expect(approvals.resolveCallback("apgr:1")).toEqual({
      approval: {
        sessionId: "thr_123",
        turnId: "turn_1",
        approvalId: "approval_with_a_long_id",
        title: "Codex needs to run:",
        summary: "npm test",
      },
      decision: "accept",
    });
    expect(approvals.resolveCallback("apgr:2")).toBeNull();
  });
});
