import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type SleepPreventionStatus =
  | { type: "active"; detail: string }
  | { type: "unsupported"; detail: string }
  | { type: "disabled"; detail: string };

export interface SleepPreventer {
  start(): SleepPreventionStatus;
  stop(): Promise<void>;
}

type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
const CAFFEINATE_DETAIL = "caffeinate";
const CAFFEINATE_ARGS: string[] = [];

export class NoopSleepPreventer implements SleepPreventer {
  constructor(private readonly detail = "not enabled") {}

  start(): SleepPreventionStatus {
    return { type: "disabled", detail: this.detail };
  }

  async stop(): Promise<void> {
    return Promise.resolve();
  }
}

export class CaffeinateSleepPreventer implements SleepPreventer {
  private child: ChildProcess | null = null;

  constructor(
    private readonly platform = process.platform,
    private readonly spawnImpl: SpawnLike = spawn
  ) {}

  start(): SleepPreventionStatus {
    if (this.platform !== "darwin") {
      return {
        type: "unsupported",
        detail: "caffeinate is only available on macOS",
      };
    }

    if (this.child !== null) {
      return { type: "active", detail: CAFFEINATE_DETAIL };
    }

    const child = this.spawnImpl("caffeinate", CAFFEINATE_ARGS, {
      stdio: "ignore",
    });
    child.once("exit", () => {
      if (this.child === child) {
        this.child = null;
      }
    });
    child.once("error", () => {
      if (this.child === child) {
        this.child = null;
      }
    });
    this.child = child;

    return { type: "active", detail: CAFFEINATE_DETAIL };
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;

    if (child === null || child.killed) {
      return;
    }

    child.kill("SIGTERM");
  }
}

export function createSleepPreventer(platform = process.platform): SleepPreventer {
  return new CaffeinateSleepPreventer(platform);
}

export function formatSleepPreventionStatus(status: SleepPreventionStatus): string {
  if (status.type === "active") {
    return `active (${status.detail})`;
  }

  return `${status.type} (${status.detail})`;
}
