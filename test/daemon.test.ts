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
  AgentTranscriptMessage,
  ApprovalDecision,
  ListAgentSessionsOptions,
  StartSessionOptions,
} from "../src/agent/types.js";
import type { ChannelEvent, ChannelMessage, MessageChannel } from "../src/channel/types.js";
import type { AppConfig } from "../src/config.js";
import {
  getLegacyStatePath,
  getStatePath,
  markLastThreadStopped,
  readLastThreadState,
  readLastThreadStateWithPath,
  runDaemon,
  writeLastThreadState,
  type LastThreadState,
} from "../src/daemon.js";
import type { SleepPreventer, SleepPreventionStatus } from "../src/sleep.js";

describe("daemon state", () => {
  it("uses XDG_STATE_HOME when present", () => {
    expect(getStatePath({ XDG_STATE_HOME: "/tmp/afk-state" })).toBe(
      "/tmp/afk-state/afk/last-thread.json"
    );
  });

  it("can read the legacy apgr state path during the rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-state-test-"));
    const env = { XDG_STATE_HOME: directory };
    const state: LastThreadState = {
      threadId: "thr_legacy",
      cwd: "/workspace",
      pid: 1234,
      status: "stopped",
      startedAt: "2026-05-13T00:00:00.000Z",
    };

    await writeLastThreadState(state, getLegacyStatePath(env));

    await expect(readLastThreadState(getStatePath(env))).resolves.toEqual(state);
    await expect(readLastThreadStateWithPath(getStatePath(env))).resolves.toMatchObject({
      state,
      statePath: getLegacyStatePath(env),
    });
  });

  it("round-trips last thread state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-state-test-"));
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
    const directory = await mkdtemp(join(tmpdir(), "afk-state-test-"));
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
    const directory = await mkdtemp(join(tmpdir(), "afk-state-test-"));
    const statePath = join(directory, "last-thread.json");
    const sleepPreventer = new FakeSleepPreventer();
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
      sleepPreventer,
      stdout: { write: () => undefined },
    });

    expect(channel.sentMessages).toContain(
      "Codex crashed unexpectedly. Restart with `afk`."
    );
    expect(sleepPreventer.starts).toBe(1);
    expect(sleepPreventer.stops).toBe(1);
    await expect(readLastThreadState(statePath)).resolves.toMatchObject({
      agentStatus: "dead",
      channelStatus: "disconnected",
      status: "stopped",
      threadId: "thr_123",
    });
  });

  it("updates daemon state when Telegram switches to another session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-state-test-"));
    const statePath = join(directory, "last-thread.json");
    const stdout = new FakeOutputWriter();
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
      sleepPreventer: new FakeSleepPreventer(),
      stdout,
    });

    expect(channel.sentMessages).toContain("Resumed thr_other. What would you like to do?");
    expect(stdout.text).toContain("Keep this terminal open while Away Mode runs.");
    expect(stdout.text).toContain("codex resume thr_other");
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

  async readRecentMessages(): Promise<AgentTranscriptMessage[]> {
    return [];
  }

  async sendMessage(): Promise<{ turnId: string }> {
    return { turnId: "turn_1" };
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

class FakeSleepPreventer implements SleepPreventer {
  starts = 0;
  stops = 0;

  start(): SleepPreventionStatus {
    this.starts += 1;
    return { type: "active", detail: "test sleep prevention" };
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }
}

class FakeOutputWriter {
  text = "";

  write(text: string): void {
    this.text += text;
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

  async readRecentMessages(): Promise<AgentTranscriptMessage[]> {
    return [];
  }

  async sendMessage(): Promise<{ turnId: string }> {
    return { turnId: "turn_1" };
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
