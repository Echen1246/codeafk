import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CodexProcessError } from "../src/agent/codex.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  AgentSessionSummary,
  ApprovalDecision,
  ListAgentSessionsOptions,
  StartSessionOptions,
} from "../src/agent/types.js";
import type { ChannelEvent, ChannelMessage, MessageChannel } from "../src/channel/types.js";
import type { AppConfig } from "../src/config.js";
import {
  getStatePath,
  markLastThreadStopped,
  readLastThreadState,
  runDaemon,
  writeLastThreadState,
  type LastThreadState,
} from "../src/daemon.js";

describe("daemon state", () => {
  it("uses XDG_STATE_HOME when present", () => {
    expect(getStatePath({ XDG_STATE_HOME: "/tmp/apgr-state" })).toBe(
      "/tmp/apgr-state/apgr/last-thread.json"
    );
  });

  it("round-trips last thread state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apgr-state-test-"));
    const statePath = join(directory, "last-thread.json");
    const state: LastThreadState = {
      threadId: "thr_123",
      cwd: "/workspace",
      pid: 1234,
      status: "running",
      agentStatus: "running",
      channelStatus: "connected",
      startedAt: "2026-05-13T00:00:00.000Z",
    };

    await writeLastThreadState(state, statePath);
    await expect(readLastThreadState(statePath)).resolves.toEqual(state);
  });

  it("marks a running thread as stopped", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apgr-state-test-"));
    const statePath = join(directory, "last-thread.json");
    const state: LastThreadState = {
      threadId: "thr_123",
      cwd: "/workspace",
      pid: 1234,
      status: "running",
      agentStatus: "running",
      channelStatus: "connected",
      startedAt: "2026-05-13T00:00:00.000Z",
    };

    await markLastThreadStopped(state, statePath);

    await expect(readLastThreadState(statePath)).resolves.toMatchObject({
      threadId: "thr_123",
      status: "stopped",
    });
  });

  it("reports Codex crashes to the channel and marks the last thread dead", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apgr-state-test-"));
    const statePath = join(directory, "last-thread.json");
    const channel = new FakeChannel([
      { type: "message", text: "/sessions", fromUserId: "u1" },
      { type: "message", text: "1", fromUserId: "u1" },
      { type: "message", text: "new", fromUserId: "u1" },
    ]);

    await runDaemon({
      agent: new CrashingAgent(),
      channel,
      config: testConfig,
      cwd: "/workspace",
      statePath,
      stdout: { write: () => undefined },
    });

    expect(channel.sentMessages).toContain(
      "Codex crashed unexpectedly. Restart with `apgr start`."
    );
    await expect(readLastThreadState(statePath)).resolves.toMatchObject({
      agentStatus: "dead",
      channelStatus: "disconnected",
      status: "stopped",
      threadId: "thr_123",
    });
  });

  it("updates daemon state when Telegram switches to another session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apgr-state-test-"));
    const statePath = join(directory, "last-thread.json");
    const channel = new FakeChannel([
      { type: "message", text: "/sessions", fromUserId: "u1" },
      { type: "message", text: "1", fromUserId: "u1" },
      { type: "message", text: "new", fromUserId: "u1" },
      { type: "message", text: "/switch", fromUserId: "u1" },
      { type: "message", text: "2", fromUserId: "u1" },
      { type: "message", text: "1", fromUserId: "u1" },
    ]);

    await runDaemon({
      agent: new SwitchingAgent([
        sessionSummary({
          threadId: "thr_other",
          cwd: "/other",
          title: "other project work",
        }),
        sessionSummary({
          threadId: "thr_current",
          cwd: "/workspace",
          title: "current work",
        }),
      ]),
      channel,
      config: testConfig,
      cwd: "/workspace",
      statePath,
      stdout: { write: () => undefined },
    });

    expect(channel.sentMessages).toContain("Resumed thr_other. What would you like to do?");
    await expect(readLastThreadState(statePath)).resolves.toMatchObject({
      threadId: "thr_other",
      cwd: "/other",
      status: "stopped",
    });
  });
});

const testConfig: AppConfig = {
  channel: {
    type: "telegram",
    bot_token: "token",
    chat_id: 123,
  },
  agent: {
    type: "codex",
  },
};

const session: AgentSession = {
  sessionId: "thr_123",
  threadId: "thr_123",
  cwd: "/workspace",
  model: "gpt-5.4",
};

class CrashingAgent implements AgentAdapter {
  async startSession(): Promise<AgentSession> {
    return session;
  }

  async resumeSession(): Promise<AgentSession> {
    return session;
  }

  async listSessions(): Promise<[]> {
    return [];
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
    throw new CodexProcessError("Codex app-server exited with code null signal SIGKILL");
  }
}

class SwitchingAgent implements AgentAdapter {
  constructor(private readonly sessions: AgentSessionSummary[]) {}

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    return {
      sessionId: `new:${options.cwd}`,
      threadId: `new:${options.cwd}`,
      cwd: options.cwd,
      model: "gpt-5.4",
    };
  }

  async resumeSession(sessionId: string, options: { cwd?: string } = {}): Promise<AgentSession> {
    const cwd =
      options.cwd ?? this.sessions.find((item) => item.threadId === sessionId)?.cwd ?? "/workspace";
    return {
      sessionId,
      threadId: sessionId,
      cwd,
      model: "gpt-5.4",
    };
  }

  async listSessions(options: ListAgentSessionsOptions = {}): Promise<AgentSessionSummary[]> {
    if (options.cwd === undefined) {
      return this.sessions;
    }

    return this.sessions.filter((item) => item.cwd === options.cwd);
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

class FakeChannel implements MessageChannel {
  readonly sentMessages: string[] = [];

  constructor(private readonly channelEvents: ChannelEvent[] = []) {}

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
    yield* this.channelEvents;
  }
}

function sessionSummary(overrides: Partial<AgentSessionSummary>): AgentSessionSummary {
  return {
    threadId: "thr_current",
    cwd: "/workspace",
    title: "current work",
    preview: "current work",
    createdAt: 1778650000,
    updatedAt: 1778659000,
    ...overrides,
  };
}
