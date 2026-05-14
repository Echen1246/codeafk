import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  CaffeinateSleepPreventer,
  formatSleepPreventionStatus,
  NoopSleepPreventer,
} from "../src/sleep.js";

describe("sleep prevention", () => {
  it("starts caffeinate on macOS and stops it later", async () => {
    const child = new FakeChildProcess();
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const preventer = new CaffeinateSleepPreventer("darwin", (command, args) => {
      spawnCalls.push({ command, args });
      return child as unknown as ChildProcess;
    });

    expect(preventer.start()).toEqual({ type: "active", detail: "caffeinate" });
    await preventer.stop();

    expect(spawnCalls).toEqual([{ command: "caffeinate", args: [] }]);
    expect(child.killSignal).toBe("SIGTERM");
  });

  it("reports unsupported platforms without spawning caffeinate", () => {
    const preventer = new CaffeinateSleepPreventer("linux", () => {
      throw new Error("should not spawn");
    });

    expect(preventer.start()).toEqual({
      type: "unsupported",
      detail: "caffeinate is only available on macOS",
    });
  });

  it("formats sleep prevention status for terminal output", () => {
    const noop = new NoopSleepPreventer("tests disabled it");

    expect(formatSleepPreventionStatus({ type: "active", detail: "caffeinate" })).toBe(
      "active (caffeinate)"
    );
    expect(formatSleepPreventionStatus(noop.start())).toBe("disabled (tests disabled it)");
  });
});

class FakeChildProcess extends EventEmitter {
  killed = false;
  killSignal: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = typeof signal === "string" ? signal : undefined;
    this.emit("exit", null, this.killSignal);
    return true;
  }
}
