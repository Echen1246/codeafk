import { describe, expect, it } from "vitest";

import { ApprovalRegistry } from "../src/approval.js";

describe("ApprovalRegistry", () => {
  it("maps short callback ids to pending approvals", () => {
    const approvals = new ApprovalRegistry();
    const buttons = approvals.register({
      type: "approval_required",
      sessionId: "thr_123",
      turnId: "turn_1",
      approvalId: "approval_with_a_long_id",
      kind: "shell",
      title: "Codex needs to run:",
      summary: "npm test",
      availableDecisions: ["accept", "acceptForSession", "decline"],
    });

    expect(buttons).toEqual([
      { label: "Approve", callbackId: "afk:1" },
      { label: "Approve & Trust", callbackId: "afk:2" },
      { label: "Deny", callbackId: "afk:3" },
    ]);
    expect(approvals.resolveCallback("afk:1")).toEqual({
      approval: {
        type: "approval_required",
        sessionId: "thr_123",
        turnId: "turn_1",
        approvalId: "approval_with_a_long_id",
        kind: "shell",
        title: "Codex needs to run:",
        summary: "npm test",
        availableDecisions: ["accept", "acceptForSession", "decline"],
      },
      decision: "accept",
    });
    expect(approvals.resolveCallback("afk:2")).toBeNull();
  });

  it("omits trust when an approval does not support session trust", () => {
    const approvals = new ApprovalRegistry();
    const buttons = approvals.register({
      type: "approval_required",
      sessionId: "thr_123",
      turnId: "turn_1",
      approvalId: "approval_1",
      kind: "shell",
      title: "Codex needs to run:",
      summary: "npm test",
      availableDecisions: ["accept", "decline"],
    });

    expect(buttons).toEqual([
      { label: "Approve", callbackId: "afk:1" },
      { label: "Deny", callbackId: "afk:2" },
    ]);
  });
});
