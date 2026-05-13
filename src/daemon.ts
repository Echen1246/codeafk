import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { CodexAdapter, isCodexProcessError } from "./agent/codex.js";
import type { AgentAdapter } from "./agent/types.js";
import type { MessageChannel } from "./channel/types.js";
import { TelegramChannel } from "./channel/telegram.js";
import { loadConfig, type AppConfig } from "./config.js";
import { runOrchestrator } from "./orchestrator.js";

const STATE_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;
const CODEX_CRASH_MESSAGE = "Codex crashed unexpectedly. Restart with `apgr start`.";

type AgentHealthStatus = "running" | "dead";
type ChannelHealthStatus = "connected" | "disconnected";

export type LastThreadState = {
  threadId: string;
  cwd: string;
  pid: number;
  status: "running" | "stopped";
  agentStatus?: AgentHealthStatus;
  channelStatus?: ChannelHealthStatus;
  lastAgentError?: string;
  lastChannelError?: string;
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
  const statePath = options.statePath ?? getStatePath();
  let agentStatus: AgentHealthStatus = "running";
  let channelStatus: ChannelHealthStatus = "connected";
  let lastAgentError: string | undefined;
  let lastChannelError: string | undefined;
  const updateChannelStatus = (status: ChannelHealthStatus, error?: Error): void => {
    channelStatus = status;
    lastChannelError = error?.message;
    void patchLastThreadState(statePath, {
      channelStatus,
      ...(lastChannelError === undefined ? {} : { lastChannelError }),
    }).catch((patchError: unknown) => {
      console.error(`Failed to update channel status: ${asError(patchError).message}`);
    });
  };
  const agent = options.agent ?? new CodexAdapter();
  const channel =
    options.channel ??
    new TelegramChannel({
      botToken: config.channel.bot_token,
      chatId: config.channel.chat_id,
      onConnectionStateChange: updateChannelStatus,
    });
  const stdout = options.stdout ?? process.stdout;
  const abortController = new AbortController();

  const session = await agent.startSession({ cwd });
  const startedAt = new Date().toISOString();

  await writeLastThreadState(
    {
      threadId: session.threadId,
      cwd,
      pid: process.pid,
      status: "running",
      agentStatus,
      channelStatus,
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
  } catch (error) {
    if (!isCodexProcessError(error)) {
      throw error;
    }

    agentStatus = "dead";
    lastAgentError = error.message;
    await patchLastThreadState(statePath, {
      agentStatus,
      lastAgentError,
    });
    await sendIfPossible(channel, CODEX_CRASH_MESSAGE);
  } finally {
    removeSignalHandlers();
    await channel.stop();
    await agent.dispose?.();
    channelStatus = "disconnected";
    await writeLastThreadState(
      {
        threadId: session.threadId,
        cwd,
        pid: process.pid,
        status: "stopped",
        agentStatus,
        channelStatus,
        ...(lastAgentError === undefined ? {} : { lastAgentError }),
        ...(lastChannelError === undefined ? {} : { lastChannelError }),
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

async function patchLastThreadState(statePath: string, patch: Partial<LastThreadState>): Promise<void> {
  const state = await readLastThreadState(statePath);
  if (state === null) {
    return;
  }

  await writeLastThreadState({ ...state, ...patch }, statePath);
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

async function sendIfPossible(channel: MessageChannel, text: string): Promise<void> {
  try {
    await channel.send({ text });
  } catch (error) {
    console.error(`Failed to send channel error message: ${asError(error).message}`);
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
    (value.agentStatus === undefined ||
      value.agentStatus === "running" ||
      value.agentStatus === "dead") &&
    (value.channelStatus === undefined ||
      value.channelStatus === "connected" ||
      value.channelStatus === "disconnected") &&
    (value.lastAgentError === undefined || typeof value.lastAgentError === "string") &&
    (value.lastChannelError === undefined || typeof value.lastChannelError === "string") &&
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

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
