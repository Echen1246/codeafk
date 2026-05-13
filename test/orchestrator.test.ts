import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  AgentSessionSummary,
  AgentTranscriptMessage,
  ApprovalDecision,
  ListAgentSessionsOptions,
  StartSessionOptions,
} from "../src/agent/types.js";
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

  it("steers Telegram messages into an active Codex turn", async () => {
    const channel = new FakeChannel([
      { type: "message", text: "do work", fromUserId: "u1" },
      { type: "message", text: "actually focus on tests", fromUserId: "u1" },
    ]);
    const agent = new FakeAgent([]);

    await runOrchestrator({ agent, channel, session });

    expect(agent.sentMessages).toEqual([{ sessionId: "thr_123", text: "do work" }]);
    expect(agent.steeredMessages).toEqual([
      {
        sessionId: "thr_123",
        turnId: "turn_1",
        text: "actually focus on tests",
      },
    ]);
    expect(channel.sentMessages).toEqual(["Sent to Codex.", "Steered Codex."]);
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
          filename: "turn_1.html",
          content: expect.any(Buffer),
          mimeType: "text/html",
        },
        {
          filename: "turn_1.diff",
          content: Buffer.from(diff),
          mimeType: "text/x-diff",
        },
      ],
    ]);
    expect(channel.sentAttachments[0]?.[0]?.content.toString("utf8")).toContain("+hello world");
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

  it("switches to a selected Codex session and sends later messages there", async () => {
    const channel = new FakeChannel([
      { type: "message", text: "/switch", fromUserId: "u1" },
      { type: "message", text: "2", fromUserId: "u1" },
      { type: "message", text: "1", fromUserId: "u1" },
      { type: "message", text: "continue here", fromUserId: "u1" },
    ]);
    const agent = new FakeAgent([], [
      sessionSummary({
        threadId: "thr_other",
        cwd: "/other",
        title: "work in other project",
      }),
      sessionSummary({
        threadId: "thr_123",
        cwd: "/workspace",
        title: "current work",
      }),
    ]);
    const changedSessions: AgentSession[] = [];

    await runOrchestrator({
      agent,
      channel,
      session,
      onSessionChanged: (nextSession) => {
        changedSessions.push(nextSession);
      },
    });

    expect(agent.resumeCalls).toEqual([{ sessionId: "thr_other", cwd: "/other" }]);
    expect(changedSessions).toEqual([
      {
        sessionId: "thr_other",
        threadId: "thr_other",
        cwd: "/other",
        model: "gpt-5.4",
      },
    ]);
    expect(agent.sentMessages).toEqual([{ sessionId: "thr_other", text: "continue here" }]);
    expect(channel.sentMessages).toContain("Switching sessions.");
    expect(channel.sentMessages).toContain("Resumed thr_other. What would you like to do?");
  });

  it("starts a new Codex session from the switch picker", async () => {
    const channel = new FakeChannel([
      { type: "message", text: "/switch", fromUserId: "u1" },
      { type: "message", text: "1", fromUserId: "u1" },
      { type: "message", text: "new", fromUserId: "u1" },
    ]);
    const agent = new FakeAgent([], [
      sessionSummary({
        threadId: "thr_123",
        cwd: "/workspace",
        title: "current work",
      }),
    ]);

    await runOrchestrator({ agent, channel, session });

    expect(agent.startCalls).toEqual([{ cwd: "/workspace" }]);
    expect(channel.sentMessages).toContain(
      "Started a new session in workspace. What would you like to do?"
    );
  });

  it("sends bounded recent context when switching to an old session", async () => {
    const channel = new FakeChannel([
      { type: "message", text: "/switch", fromUserId: "u1" },
      { type: "message", text: "2", fromUserId: "u1" },
      { type: "message", text: "1", fromUserId: "u1" },
    ]);
    const agent = new FakeAgent(
      [],
      [
        sessionSummary({
          threadId: "thr_other",
          cwd: "/other",
          title: "work in other project",
        }),
        sessionSummary({
          threadId: "thr_123",
          cwd: "/workspace",
          title: "current work",
        }),
      ],
      [
        { role: "user", text: "fix auth" },
        { role: "agent", text: "I changed the callback test." },
      ]
    );

    await runOrchestrator({ agent, channel, session });

    expect(channel.sentMessages).toContain("Recent context from this Codex session:");
    expect(channel.sentMessages).toContain("You:\nfix auth");
    expect(channel.sentMessages).toContain("Codex:\nI changed the callback test.");
    expect(channel.sentMessages.at(-1)).toBe("Resumed thr_other. What would you like to do?");
  });

  it("does not switch sessions while Codex is still working", async () => {
    const channel = new FakeChannel([
      { type: "message", text: "do work", fromUserId: "u1" },
      { type: "message", text: "/switch", fromUserId: "u1" },
    ]);
    const agent = new FakeAgent([]);

    await runOrchestrator({ agent, channel, session });

    expect(agent.sentMessages).toEqual([{ sessionId: "thr_123", text: "do work" }]);
    expect(agent.listCalls).toEqual([]);
    expect(agent.resumeCalls).toEqual([]);
    expect(agent.startCalls).toEqual([]);
    expect(channel.sentMessages).toEqual([
      "Sent to Codex.",
      "Codex is still working. Switch sessions after it finishes.",
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
  readonly steeredMessages: Array<{ sessionId: string; turnId: string; text: string }> = [];
  readonly approvals: Array<{ sessionId: string; approvalId: string; decision: ApprovalDecision }> =
    [];
  readonly listCalls: ListAgentSessionsOptions[] = [];
  readonly resumeCalls: Array<{ sessionId: string; cwd: string }> = [];
  readonly startCalls: Array<{ cwd: string }> = [];

  constructor(
    private readonly agentEvents: AgentEvent[],
    private readonly sessions: AgentSessionSummary[] = [],
    private readonly recentMessages: AgentTranscriptMessage[] = []
  ) {}

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    this.startCalls.push({ cwd: options.cwd });
    return {
      sessionId: `new:${options.cwd}`,
      threadId: `new:${options.cwd}`,
      cwd: options.cwd,
      model: "gpt-5.4",
    };
  }

  async resumeSession(sessionId: string, options: { cwd?: string } = {}): Promise<AgentSession> {
    const cwd =
      options.cwd ?? this.sessions.find((item) => item.threadId === sessionId)?.cwd ?? session.cwd;
    this.resumeCalls.push({ sessionId, cwd });
    return {
      sessionId,
      threadId: sessionId,
      cwd,
      model: "gpt-5.4",
    };
  }

  async listSessions(options: ListAgentSessionsOptions = {}): Promise<AgentSessionSummary[]> {
    this.listCalls.push(options);
    if (options.cwd === undefined) {
      return this.sessions;
    }

    return this.sessions.filter((item) => item.cwd === options.cwd);
  }

  async readRecentMessages(): Promise<AgentTranscriptMessage[]> {
    return this.recentMessages;
  }

  async sendMessage(sessionId: string, text: string): Promise<{ turnId: string }> {
    this.sentMessages.push({ sessionId, text });
    return { turnId: `turn_${this.sentMessages.length}` };
  }

  async steerActiveTurn(sessionId: string, turnId: string, text: string): Promise<void> {
    this.steeredMessages.push({ sessionId, turnId, text });
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

function sessionSummary(overrides: Partial<AgentSessionSummary>): AgentSessionSummary {
  return {
    threadId: "thr_123",
    cwd: "/workspace",
    title: "current work",
    preview: "current work",
    createdAt: 1778650000,
    updatedAt: 1778659000,
    ...overrides,
  };
}
