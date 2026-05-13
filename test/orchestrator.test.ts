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
});

class FakeChannel implements MessageChannel {
  readonly sentMessages: string[] = [];

  constructor(private readonly channelEvents: ChannelEvent[]) {}

  async start(): Promise<void> {
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    return Promise.resolve();
  }

  async send(msg: ChannelMessage): Promise<void> {
    this.sentMessages.push(msg.text);
  }

  async *events(): AsyncIterable<ChannelEvent> {
    yield* this.channelEvents;
  }
}

class FakeAgent implements AgentAdapter {
  readonly sentMessages: Array<{ sessionId: string; text: string }> = [];

  constructor(private readonly agentEvents: AgentEvent[]) {}

  async startSession(): Promise<AgentSession> {
    return session;
  }

  async resumeSession(): Promise<AgentSession> {
    return session;
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    this.sentMessages.push({ sessionId, text });
  }

  async steerActiveTurn(): Promise<void> {
    return Promise.resolve();
  }

  async answerApproval(
    _sessionId: string,
    _approvalId: string,
    _decision: ApprovalDecision
  ): Promise<void> {
    return Promise.resolve();
  }

  async interrupt(): Promise<void> {
    return Promise.resolve();
  }

  async *streamEvents(): AsyncIterable<AgentEvent> {
    yield* this.agentEvents;
  }
}
