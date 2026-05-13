import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CodexProcessError } from "../src/agent/codex.js";
import type { AgentAdapter, AgentEvent, AgentSession, ApprovalDecision } from "../src/agent/types.js";
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
    const channel = new FakeChannel();

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
