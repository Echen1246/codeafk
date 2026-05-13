import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { CodexAdapter } from "./agent/codex.js";
import type { AgentAdapter } from "./agent/types.js";
import type { MessageChannel } from "./channel/types.js";
import { TelegramChannel } from "./channel/telegram.js";
import { loadConfig, type AppConfig } from "./config.js";
import { runOrchestrator } from "./orchestrator.js";

const STATE_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

export type LastThreadState = {
  threadId: string;
  cwd: string;
  pid: number;
  status: "running" | "stopped";
  startedAt: string;
  stoppedAt?: string;
};

type OutputWriter = {
  write(text: string): unknown;
};

export type DaemonOptions = {
  cwd?: string;
  config?: AppConfig;
  agent?: AgentAdapter & { dispose?: () => Promise<void> };
  channel?: MessageChannel;
  statePath?: string;
  stdout?: OutputWriter;
};

export function getStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdgStateHome = env.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome !== undefined && xdgStateHome.length > 0
      ? xdgStateHome
      : join(homedir(), ".local", "state");

  return join(stateHome, "apgr", "last-thread.json");
}

export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? (await requireConfig());
  const agent = options.agent ?? new CodexAdapter();
  const channel =
    options.channel ??
    new TelegramChannel({
      botToken: config.channel.bot_token,
      chatId: config.channel.chat_id,
    });
  const statePath = options.statePath ?? getStatePath();
  const stdout = options.stdout ?? process.stdout;
  const abortController = new AbortController();

  const session = await agent.startSession({
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const startedAt = new Date().toISOString();

  await writeLastThreadState(
    {
      threadId: session.threadId,
      cwd,
      pid: process.pid,
      status: "running",
      startedAt,
    },
    statePath
  );

  writeLine(stdout, "apgr is running.\n");
  writeLine(stdout, `Workspace:  ${cwd}`);
  writeLine(stdout, "Agent:      Codex");
  writeLine(stdout, `Thread:     ${session.threadId}`);
  writeLine(stdout, "Channel:    Telegram");
  writeLine(stdout, "\nAway Mode is ON.");
  writeLine(stdout, "Text your bot to send prompts to Codex.");
  writeLine(stdout, "Press Ctrl+C or run `apgr stop` to end.");

  await channel.start();
  await channel.send({
    text: `Pager started for ${basename(cwd)}.\nSend a message to begin.`,
  });

  const removeSignalHandlers = installSignalHandlers(() => abortController.abort());

  try {
    await runOrchestrator({
      agent,
      channel,
      session,
      signal: abortController.signal,
    });
  } finally {
    removeSignalHandlers();
    await channel.stop();
    await agent.dispose?.();
    await writeLastThreadState(
      {
        threadId: session.threadId,
        cwd,
        pid: process.pid,
        status: "stopped",
        startedAt,
        stoppedAt: new Date().toISOString(),
      },
      statePath
    );
    writeLine(stdout, "\nAway Mode stopped.");
  }
}

export async function readLastThreadState(
  statePath = getStatePath()
): Promise<LastThreadState | null> {
  let rawState: string;
  try {
    rawState = await readFile(statePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(rawState);
  if (!isLastThreadState(parsed)) {
    throw new Error(`State file is invalid: ${statePath}`);
  }
  return parsed;
}

export async function writeLastThreadState(
  state: LastThreadState,
  statePath = getStatePath()
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true, mode: STATE_DIR_MODE });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: STATE_FILE_MODE });
}

export async function markLastThreadStopped(
  state: LastThreadState,
  statePath = getStatePath()
): Promise<void> {
  await writeLastThreadState(
    {
      ...state,
      status: "stopped",
      stoppedAt: new Date().toISOString(),
    },
    statePath
  );
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    if (isNodeError(error) && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function requireConfig(): Promise<AppConfig> {
  const config = await loadConfig();
  if (config === null) {
    throw new Error("No Agent Pager config found. Run `apgr init` first.");
  }
  return config;
}

function installSignalHandlers(onSignal: () => void): () => void {
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

function writeLine(stdout: OutputWriter, line: string): void {
  stdout.write(`${line}\n`);
}

function isLastThreadState(value: unknown): value is LastThreadState {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.cwd === "string" &&
    typeof value.pid === "number" &&
    (value.status === "running" || value.status === "stopped") &&
    typeof value.startedAt === "string" &&
    (value.stoppedAt === undefined || typeof value.stoppedAt === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
