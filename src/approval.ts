import type { AgentEvent, ApprovalDecision } from "./agent/types.js";

type PendingApproval = Extract<AgentEvent, { type: "approval_required" }>;

type ResolvedApproval = {
  approval: PendingApproval;
  decision: ApprovalDecision;
};

export class ApprovalRegistry {
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly callbacks = new Map<string, { approvalId: string; decision: ApprovalDecision }>();
  private nextCallbackId = 1;

  register(approval: PendingApproval): Array<{ label: string; callbackId: string }> {
    this.clearApproval(approval.approvalId);
    this.approvals.set(approval.approvalId, approval);

    const buttons: Array<{ label: string; decision: ApprovalDecision }> = [
      { label: "Approve", decision: "accept" },
      { label: "Approve & Trust", decision: "acceptForSession" },
      { label: "Deny", decision: "decline" },
    ];

    return buttons
      .filter((button) => approval.availableDecisions.includes(button.decision))
      .map((button) =>
        this.registerCallback(approval.approvalId, button.label, button.decision)
      );
  }

  resolveCallback(callbackId: string): ResolvedApproval | null {
    const callback = this.callbacks.get(callbackId);
    if (callback === undefined) {
      return null;
    }

    const approval = this.approvals.get(callback.approvalId);
    this.clearApproval(callback.approvalId);

    if (approval === undefined) {
      return null;
    }

    return {
      approval,
      decision: callback.decision,
    };
  }

  clearApproval(approvalId: string): void {
    this.approvals.delete(approvalId);

    for (const [callbackId, callback] of this.callbacks.entries()) {
      if (callback.approvalId === approvalId) {
        this.callbacks.delete(callbackId);
      }
    }
  }

  private registerCallback(
    approvalId: string,
    label: string,
    decision: ApprovalDecision
  ): { label: string; callbackId: string } {
    const callbackId = `afk:${this.nextCallbackId}`;
    this.nextCallbackId += 1;
    this.callbacks.set(callbackId, { approvalId, decision });

    return { label, callbackId };
  }
}
