import { describe, expect, it } from "vitest";

import { formatStatusReport, formatUptime } from "../src/commands/status.js";
import type { LastThreadState } from "../src/daemon.js";

describe("formatStatusReport", () => {
  it("shows health, current thread, and uptime for a running daemon", () => {
    expect(
      formatStatusReport({
        configuredChannel: "telegram",
        daemonRunning: true,
        now: new Date("2026-05-13T00:01:05.000Z"),
        state: {
          threadId: "thr_123",
          cwd: "/workspace",
          pid: 1234,
          status: "running",
          agentStatus: "running",
          channelStatus: "connected",
          startedAt: "2026-05-13T00:00:00.000Z",
        },
      })
    ).toBe(
      [
        "Agent Pager status",
        "",
        "Channel: telegram (connected)",
        "Codex:  running",
        "Thread:  thr_123",
        "Workspace: /workspace",
        "Daemon:  running (pid 1234)",
        "Uptime:  1m 5s",
      ].join("\n")
    );
  });

  it("shows dead Codex and disconnected channel when the daemon is stopped", () => {
    expect(
      formatStatusReport({
        configuredChannel: "telegram",
        daemonRunning: false,
        now: new Date("2026-05-13T00:03:00.000Z"),
        state: {
          threadId: "thr_123",
          cwd: "/workspace",
          pid: 1234,
          status: "stopped",
          agentStatus: "dead",
          channelStatus: "disconnected",
          startedAt: "2026-05-13T00:00:00.000Z",
          stoppedAt: "2026-05-13T00:02:30.000Z",
        },
      })
    ).toContain("Codex:  dead");
  });
});

describe("formatUptime", () => {
  it("uses stoppedAt for completed runs", () => {
    const state: LastThreadState = {
      threadId: "thr_123",
      cwd: "/workspace",
      pid: 1234,
      status: "stopped",
      startedAt: "2026-05-13T00:00:00.000Z",
      stoppedAt: "2026-05-13T01:02:03.000Z",
    };

    expect(formatUptime(state, new Date("2026-05-13T02:00:00.000Z"))).toBe("1h 2m 3s");
  });
});
