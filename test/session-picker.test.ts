import { describe, expect, it } from "vitest";

import type { AgentAdapter, AgentEvent, AgentSession, AgentSessionSummary, ApprovalDecision } from "../src/agent/types.js";
import type { ChannelEvent, ChannelMessage, MessageChannel } from "../src/channel/types.js";
import {
  formatSessionList,
  formatSessionTime,
  projectOptions,
  selectSessionFromChannel,
} from "../src/session-picker.js";

describe("selectSessionFromChannel", () => {
  it("lets the user choose a project and resume a recent session", async () => {
    const agent = new FakeAgent([
      {
        threadId: "thr_recent",
        cwd: "/Users/eddie/Documents/myapp",
        title: "fix the failing auth callback test",
        preview: "fix the failing auth callback test",
        createdAt: 1778650000,
        updatedAt: 1778659000,
        messageCount: 47,
      },
      {
        threadId: "thr_other",
        cwd: "/Users/eddie/Documents/other",
        title: "other work",
        preview: "other work",
        createdAt: 1778640000,
        updatedAt: 1778645000,
      },
    ]);
    const channel = new FakeChannel();
    const events = eventsFrom([
      { type: "message", text: "/sessions", fromUserId: "u1" },
      { type: "message", text: "1", fromUserId: "u1" },
      { type: "message", text: "1", fromUserId: "u1" },
    ]);

    const selection = await selectSessionFromChannel({
      agent,
      channel,
      events,
      defaultCwd: "/Users/eddie/Documents/myapp",
      now: new Date(1778659840000),
    });

    expect(selection).toEqual({
      cwd: "/Users/eddie/Documents/myapp",
      threadId: "thr_recent",
    });
    expect(agent.listCalls).toEqual([
      { limit: 50 },
      { cwd: "/Users/eddie/Documents/myapp", limit: 8, includeMessageCounts: true },
    ]);
    expect(channel.sentMessages.at(-1)).toContain("[1] today, 14m");
  });

  it("lets the user start a new session when a project has no history", async () => {
    const agent = new FakeAgent([]);
    const channel = new FakeChannel();
    const events = eventsFrom([
      { type: "message", text: "/sessions", fromUserId: "u1" },
      { type: "message", text: "1", fromUserId: "u1" },
      { type: "message", text: "new", fromUserId: "u1" },
    ]);

    const selection = await selectSessionFromChannel({
      agent,
      channel,
      events,
      defaultCwd: "/Users/eddie/Documents/newapp",
    });

    expect(selection).toEqual({ cwd: "/Users/eddie/Documents/newapp" });
    expect(channel.sentMessages.at(-1)).toContain("No recent sessions in newapp.");
  });
});

describe("session picker formatting", () => {
  it("keeps the current project first", () => {
    expect(
      projectOptions(
        [
          sessionSummary({
            threadId: "thr_1",
            cwd: "/Users/eddie/Documents/other",
            updatedAt: 20,
          }),
          sessionSummary({
            threadId: "thr_2",
            cwd: "/Users/eddie/Documents/current",
            updatedAt: 10,
          }),
        ],
        "/Users/eddie/Documents/current"
      ).map((project) => project.cwd)
    ).toEqual(["/Users/eddie/Documents/current", "/Users/eddie/Documents/other"]);
  });

  it("formats session recency for mobile scanning", () => {
    const now = new Date("2026-05-13T12:00:00.000Z");

    expect(formatSessionTime(Date.parse("2026-05-13T11:46:00.000Z") / 1000, now)).toBe(
      "today, 14m"
    );
    expect(formatSessionTime(Date.parse("2026-05-12T11:46:00.000Z") / 1000, now)).toBe(
      "yesterday"
    );
  });

  it("includes message counts when Codex history details are available", () => {
    expect(
      formatSessionList(
        {
          cwd: "/Users/eddie/Documents/myapp",
          name: "myapp",
          sessionCount: 1,
          updatedAt: 1778659000,
        },
        [
          sessionSummary({
            threadId: "thr_recent",
            title: "fix the failing auth callback test",
            messageCount: 47,
          }),
        ],
        new Date(1778659840000)
      )
    ).toContain('(47 msg)');
  });
});

function sessionSummary(overrides: Partial<AgentSessionSummary>): AgentSessionSummary {
  return {
    threadId: "thr_123",
    cwd: "/Users/eddie/Documents/myapp",
    title: "work on myapp",
    preview: "work on myapp",
    createdAt: 1778650000,
    updatedAt: 1778659000,
    ...overrides,
  };
}

function eventsFrom(events: ChannelEvent[]): AsyncIterator<ChannelEvent> {
  return (async function* () {
    yield* events;
  })()[Symbol.asyncIterator]();
}

class FakeChannel implements MessageChannel {
  readonly sentMessages: string[] = [];

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
    await Promise.resolve();
  }
}

class FakeAgent implements AgentAdapter {
  readonly listCalls: unknown[] = [];

  constructor(private readonly sessions: AgentSessionSummary[]) {}

  async startSession(): Promise<AgentSession> {
    return testSession;
  }

  async resumeSession(): Promise<AgentSession> {
    return testSession;
  }

  async listSessions(options: unknown): Promise<AgentSessionSummary[]> {
    this.listCalls.push(options);
    if (
      typeof options === "object" &&
      options !== null &&
      "cwd" in options &&
      typeof options.cwd === "string"
    ) {
      return this.sessions.filter((session) => session.cwd === options.cwd);
    }

    return this.sessions;
  }

  async sendMessage(): Promise<void> {
    return Promise.resolve();
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
    await Promise.resolve();
  }
}

const testSession: AgentSession = {
  sessionId: "thr_recent",
  threadId: "thr_recent",
  cwd: "/Users/eddie/Documents/myapp",
  model: "gpt-5.4",
};
