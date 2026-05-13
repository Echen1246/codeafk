import { loadConfig } from "../config.js";
import { isProcessRunning, readLastThreadState } from "../daemon.js";

export async function statusCommand(): Promise<void> {
  const [config, state] = await Promise.all([loadConfig(), readLastThreadState()]);
  const configuredChannel = config === null ? "not paired" : config.channel.type;

  console.log("Agent Pager status\n");
  console.log(`Channel: ${configuredChannel}`);

  if (state === null) {
    console.log("Thread:  none");
    console.log("Daemon:  stopped");
    return;
  }

  const running = state.status === "running" && isProcessRunning(state.pid);
  console.log(`Thread:  ${state.threadId}`);
  console.log(`Workspace: ${state.cwd}`);
  console.log(`Daemon:  ${running ? `running (pid ${state.pid})` : "stopped"}`);
}
