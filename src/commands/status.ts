import { loadConfig } from "../config.js";
import { isProcessRunning, readLastThreadState, type LastThreadState } from "../daemon.js";

export async function statusCommand(): Promise<void> {
  const [config, state] = await Promise.all([loadConfig(), readLastThreadState()]);
  const configuredChannel = config === null ? "not paired" : config.channel.type;
  const daemonRunning = state !== null && state.status === "running" && isProcessRunning(state.pid);

  console.log(
    formatStatusReport({
      configuredChannel,
      daemonRunning,
      now: new Date(),
      state,
    })
  );
}

export function formatStatusReport(options: {
  configuredChannel: string;
  daemonRunning: boolean;
  now: Date;
  state: LastThreadState | null;
}): string {
  const lines = ["AFK status", ""];

  if (options.state === null) {
    lines.push(`Channel: ${options.configuredChannel}`);
    lines.push("Codex:  none");
    lines.push("Thread:  none");
    lines.push("Daemon:  stopped");
    return lines.join("\n");
  }

  const channelStatus = options.daemonRunning
    ? options.state.channelStatus ?? "connected"
    : "disconnected";
  const codexStatus =
    options.state.agentStatus === "dead"
      ? "dead"
      : options.daemonRunning
        ? "running"
        : "stopped";

  lines.push(`Channel: ${options.configuredChannel} (${channelStatus})`);
  lines.push(`Codex:  ${codexStatus}`);
  lines.push(`Thread:  ${options.state.threadId ?? "none"}`);
  lines.push(`Workspace: ${options.state.cwd}`);
  lines.push(
    `Daemon:  ${
      options.daemonRunning ? `running (pid ${options.state.pid})` : "stopped"
    }`
  );
  lines.push(`Uptime:  ${formatUptime(options.state, options.now)}`);

  return lines.join("\n");
}

export function formatUptime(state: LastThreadState, now: Date): string {
  const startedAt = Date.parse(state.startedAt);
  const endedAt =
    state.status === "stopped" && state.stoppedAt !== undefined
      ? Date.parse(state.stoppedAt)
      : now.getTime();

  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return "unknown";
  }

  return formatDurationMs(endedAt - startedAt);
}

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}
