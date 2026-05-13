import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  getStatePath,
  markLastThreadStopped,
  readLastThreadState,
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
      startedAt: "2026-05-13T00:00:00.000Z",
    };

    await markLastThreadStopped(state, statePath);

    await expect(readLastThreadState(statePath)).resolves.toMatchObject({
      threadId: "thr_123",
      status: "stopped",
    });
  });
});
