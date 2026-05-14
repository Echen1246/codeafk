import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { CodexAdapter, isCodexProcessError } from "./agent/codex.js";
import type { AgentAdapter } from "./agent/types.js";
import type { MessageChannel } from "./channel/types.js";
import { DiscordChannel } from "./channel/discord.js";
import { TelegramChannel } from "./channel/telegram.js";
import {
  loadConfig,
  resolveChannelConfig,
  type AppConfig,
  type ChannelType,
  type ResolvedChannelConfig,
} from "./config.js";
import { runOrchestrator, sendSessionCatchUp } from "./orchestrator.js";
import {
  channelEventsFromIterator,
  isSessionSelectionAborted,
  selectSessionFromChannel,
} from "./session-picker.js";
import {
  createSleepPreventer,
  formatSleepPreventionStatus,
  type SleepPreventer,
} from "./sleep.js";

const STATE_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;
const APP_STATE_DIR = "afk";
const LEGACY_APP_STATE_DIR = "apgr";
const CODEX_CRASH_MESSAGE = "Codex crashed unexpectedly. Restart with `afk`.";

type AgentHealthStatus = "running" | "dead";
type ChannelHealthStatus = "connected" | "disconnected";

export type LastThreadState = {
  threadId: string | null;
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
  sleepPreventer?: SleepPreventer;
  stdout?: OutputWriter;
  acceptAgentConfig?: boolean;
  channelType?: ChannelType;
};

export function getStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdgStateHome = env.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome !== undefined && xdgStateHome.length > 0
      ? xdgStateHome
      : join(homedir(), ".local", "state");

  return join(stateHome, APP_STATE_DIR, "last-thread.json");
}

export function getLegacyStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdgStateHome = env.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome !== undefined && xdgStateHome.length > 0
      ? xdgStateHome
      : join(homedir(), ".local", "state");

  return join(stateHome, LEGACY_APP_STATE_DIR, "last-thread.json");
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
  const acceptAgentConfig = options.acceptAgentConfig ?? false;
  const agent = options.agent ?? new CodexAdapter({ acceptAgentConfig });
  const selectedChannel = resolveChannelConfig(config, options.channelType);
  const channel = options.channel ?? createChannel(selectedChannel, updateChannelStatus);
  const stdout = options.stdout ?? process.stdout;
  const sleepPreventer = options.sleepPreventer ?? createSleepPreventer();
  const abortController = new AbortController();
  const startedAt = new Date().toISOString();

  await writeLastThreadState(
    {
      threadId: null,
      cwd,
      pid: process.pid,
      status: "running",
      agentStatus,
      channelStatus,
      startedAt,
    },
    statePath
  );

  let activeThreadId: string | null = null;
  let activeCwd = cwd;
  let channelStarted = false;
  let removeSignalHandlers = (): void => undefined;

  try {
    const sleepStatus = sleepPreventer.start();
    writeLine(stdout, "afk is running.\n");
    writeLine(stdout, `Workspace:  ${cwd}`);
    writeLine(stdout, "Agent:      Codex");
    writeLine(stdout, "Thread:     choosing");
    writeLine(stdout, `Channel:    ${formatChannelName(selectedChannel.type)}`);
    writeLine(
      stdout,
      `Approval:   ${
        acceptAgentConfig
          ? "Codex config (--accept-agent-config)"
          : "untrusted (AFK remote default)"
      }`
    );
    writeLine(stdout, `Sleep:      ${formatSleepPreventionStatus(sleepStatus)}`);
    writeLine(stdout, "\nAway Mode is ON.");
    writeLine(
      stdout,
      `Text your ${formatChannelName(selectedChannel.type)} bot /sessions to choose a project and Codex session.`
    );
    writeLine(stdout, "Keep this terminal open while Away Mode runs.");
    writeLine(
      stdout,
      "Press Ctrl+C here to stop, or run `afk resume` from another terminal to stop and print the Codex resume command."
    );

    await channel.start();
    channelStarted = true;
    const channelEvents = channel.events()[Symbol.asyncIterator]();
    removeSignalHandlers = installSignalHandlers(() => abortController.abort());

    const selection = await selectSessionFromChannel({
      agent,
      channel,
      events: channelEvents,
      defaultCwd: cwd,
      signal: abortController.signal,
    });
    activeCwd = selection.cwd;
    const session =
      selection.threadId === undefined
        ? await agent.startSession({ cwd: selection.cwd })
        : await agent.resumeSession(selection.threadId, { cwd: selection.cwd });
    activeThreadId = session.threadId;

    await patchLastThreadState(statePath, {
      threadId: session.threadId,
      cwd: selection.cwd,
    });
    if (selection.threadId !== undefined) {
      await sendSessionCatchUp(agent, channel, session.threadId);
    }
    await channel.send({
      text:
        selection.threadId === undefined
          ? `Started a new session in ${basename(selection.cwd)}. What would you like to do?`
          : `Resumed ${shortThreadId(session.threadId)}. What would you like to do?`,
    });
    writeLine(stdout, `Selected workspace: ${selection.cwd}`);
    writeLine(stdout, `Selected thread:    ${session.threadId}`);

    await runOrchestrator({
      agent,
      channel,
      session,
      channelEvents: channelEventsFromIterator(channelEvents),
      onSessionChanged: async (nextSession) => {
        activeThreadId = nextSession.threadId;
        activeCwd = nextSession.cwd;
        await patchLastThreadState(statePath, {
          threadId: nextSession.threadId,
          cwd: nextSession.cwd,
        });
      },
      signal: abortController.signal,
    });
  } catch (error) {
    if (isSessionSelectionAborted(error)) {
      return;
    }

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
    await sleepPreventer.stop();
    if (channelStarted) {
      await channel.stop();
    }
    await agent.dispose?.();
    channelStatus = "disconnected";
    await writeLastThreadState(
      {
        threadId: activeThreadId,
        cwd: activeCwd,
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
    if (activeThreadId !== null) {
      writeLine(stdout, "\nTo continue this thread in your terminal:");
      writeLine(stdout, `  codex resume ${activeThreadId}`);
      writeLine(stdout, "\nYou can also run `afk resume` later to print this command again.");
    }
  }
}

export async function readLastThreadState(
  statePath = getStatePath()
): Promise<LastThreadState | null> {
  const resolvedStatePath = await resolveReadableStatePath(statePath);
  if (resolvedStatePath === null) {
    return null;
  }

  return readLastThreadStateAtPath(resolvedStatePath);
}

export async function readLastThreadStateWithPath(
  statePath = getStatePath()
): Promise<{ state: LastThreadState; statePath: string } | null> {
  const resolvedStatePath = await resolveReadableStatePath(statePath);
  if (resolvedStatePath === null) {
    return null;
  }

  return {
    state: await readLastThreadStateAtPath(resolvedStatePath),
    statePath: resolvedStatePath,
  };
}

async function readLastThreadStateAtPath(statePath: string): Promise<LastThreadState> {
  let rawState: string;
  try {
    rawState = await readFile(statePath, "utf8");
  } catch (error) {
    throw error;
  }

  const parsed: unknown = JSON.parse(rawState);
  if (!isLastThreadState(parsed)) {
    throw new Error(`State file is invalid: ${statePath}`);
  }
  return parsed;
}

async function resolveReadableStatePath(statePath: string): Promise<string | null> {
  if (await fileExists(statePath)) {
    return statePath;
  }

  if (statePath !== getStatePath()) {
    const legacySiblingStatePath = legacySiblingPath(statePath);
    if (legacySiblingStatePath === null) {
      return null;
    }
    return (await fileExists(legacySiblingStatePath)) ? legacySiblingStatePath : null;
  }

  const legacyStatePath = getLegacyStatePath();
  return (await fileExists(legacyStatePath)) ? legacyStatePath : null;
}

function legacySiblingPath(statePath: string): string | null {
  const stateDir = dirname(statePath);
  if (basename(stateDir) !== APP_STATE_DIR) {
    return null;
  }

  return join(dirname(stateDir), LEGACY_APP_STATE_DIR, basename(statePath));
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
    throw new Error("No AFK config found. Run `afk init` first.");
  }
  return config;
}

function createChannel(
  selectedChannel: ResolvedChannelConfig,
  onConnectionStateChange: (status: ChannelHealthStatus, error?: Error) => void
): MessageChannel {
  if (selectedChannel.type === "telegram") {
    return new TelegramChannel({
      botToken: selectedChannel.config.bot_token,
      chatId: selectedChannel.config.chat_id,
      onConnectionStateChange,
    });
  }

  return new DiscordChannel({
    botToken: selectedChannel.config.bot_token,
    userId: selectedChannel.config.user_id,
    channelId: selectedChannel.config.channel_id,
    onConnectionStateChange,
  });
}

function formatChannelName(channelType: ChannelType): string {
  return channelType === "telegram" ? "Telegram" : "Discord";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
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

function shortThreadId(threadId: string): string {
  return threadId.length <= 12 ? threadId : threadId.slice(0, 12);
}

function isLastThreadState(value: unknown): value is LastThreadState {
  return (
    isRecord(value) &&
    (typeof value.threadId === "string" || value.threadId === null) &&
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
