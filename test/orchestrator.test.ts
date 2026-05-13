import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AgentAdapter, AgentEvent, AgentSession, ApprovalDecision } from "../src/agent/types.js";
import type { ChannelEvent, ChannelMessage, MessageChannel } from "../src/channel/types.js";
import { runOrchestrator } from "../src/orchestrator.js";

const session: AgentSession = {
  sessionId: "thr_123",
  threadId: "thr_123",
  cwd: "/workspace",
  model: "gpt-5.4",
};

describe("runOrchestrator", () => {
  it("forwards Telegram messages into Codex and acknowledges them", async () => {
    const channel = new FakeChannel([{ type: "message", text: "list files", fromUserId: "u1" }]);
    const agent = new FakeAgent([]);

    await runOrchestrator({ agent, channel, session });

    expect(agent.sentMessages).toEqual([{ sessionId: "thr_123", text: "list files" }]);
    expect(channel.sentMessages).toEqual(["Sent to Codex."]);
  });

  it("forwards completed Codex messages and turn summaries to the channel", async () => {
    const channel = new FakeChannel([]);
    const agent = new FakeAgent([
      {
        type: "message_complete",
        sessionId: "thr_123",
        turnId: "turn_1",
        text: "README.md\nsrc/cli.ts",
      },
      {
        type: "turn_complete",
        sessionId: "thr_123",
        turnId: "turn_1",
        status: "completed",
      },
    ]);

    await runOrchestrator({ agent, channel, session });

    expect(channel.sentMessages).toEqual(["README.md\nsrc/cli.ts", "Codex finished."]);
  });

  it("sends changed file stats and the latest diff attachment when a turn completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apgr-diff-test-"));
    const diffRef = join(directory, "turn_1.diff");
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " Agent Pager",
      "+hello world",
    ].join("\n");
    await writeFile(diffRef, diff);

    const channel = new FakeChannel([]);
    const agent = new FakeAgent([
      {
        type: "diff_updated",
        sessionId: "thr_123",
        turnId: "turn_1",
        diffRef,
        changedFiles: ["README.md"],
        stats: { files: 1, additions: 1, deletions: 0 },
      },
      {
        type: "turn_complete",
        sessionId: "thr_123",
        turnId: "turn_1",
        status: "completed",
      },
    ]);

    await runOrchestrator({ agent, channel, session });

    expect(channel.sentMessages).toEqual(["Codex finished.\nChanged: README.md (+1 -0)"]);
    expect(channel.sentAttachments).toEqual([
      [
        {
          filename: "turn_1.diff",
          content: Buffer.from(diff),
          mimeType: "text/x-diff",
        },
      ],
    ]);
  });

  it("sends approval buttons and forwards button decisions to Codex", async () => {
    const channel = new FakeChannel([{ type: "button_press", callbackId: "apgr:1", fromUserId: "u1" }]);
    const agent = new FakeAgent([
      {
        type: "approval_required",
        sessionId: "thr_123",
        turnId: "turn_1",
        approvalId: "approval_1",
        kind: "shell",
        title: "Codex needs to run:",
        summary: "npm test",
        availableDecisions: ["accept", "decline"],
      },
    ]);

    await runOrchestrator({ agent, channel, session });

    expect(channel.sentMessages).toEqual(["Codex needs to run:\nnpm test", "Approved."]);
    expect(channel.sentButtons).toEqual([
      [
        { label: "Approve", callbackId: "apgr:1" },
        { label: "Deny", callbackId: "apgr:2" },
      ],
    ]);
    expect(agent.approvals).toEqual([
      { sessionId: "thr_123", approvalId: "approval_1", decision: "accept" },
    ]);
  });
});

class FakeChannel implements MessageChannel {
  readonly sentMessages: string[] = [];
  readonly sentAttachments: Array<NonNullable<ChannelMessage["attachments"]>> = [];
  readonly sentButtons: Array<NonNullable<ChannelMessage["buttons"]>> = [];

  constructor(private readonly channelEvents: ChannelEvent[]) {}

  async start(): Promise<void> {
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    return Promise.resolve();
  }

  async send(msg: ChannelMessage): Promise<void> {
    this.sentMessages.push(msg.text);
    if (msg.attachments !== undefined) {
      this.sentAttachments.push(msg.attachments);
    }
    if (msg.buttons !== undefined) {
      this.sentButtons.push(msg.buttons);
    }
  }

  async *events(): AsyncIterable<ChannelEvent> {
    await Promise.resolve();
    yield* this.channelEvents;
  }
}

class FakeAgent implements AgentAdapter {
  readonly sentMessages: Array<{ sessionId: string; text: string }> = [];
  readonly approvals: Array<{ sessionId: string; approvalId: string; decision: ApprovalDecision }> =
    [];

  constructor(private readonly agentEvents: AgentEvent[]) {}

  async startSession(): Promise<AgentSession> {
    return session;
  }

  async resumeSession(): Promise<AgentSession> {
    return session;
  }

  async listSessions(): Promise<[]> {
    return [];
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    this.sentMessages.push({ sessionId, text });
  }

  async steerActiveTurn(): Promise<void> {
    return Promise.resolve();
  }

  async answerApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    this.approvals.push({ sessionId, approvalId, decision });
  }

  async interrupt(): Promise<void> {
    return Promise.resolve();
  }

  async *streamEvents(): AsyncIterable<AgentEvent> {
    yield* this.agentEvents;
  }
}
