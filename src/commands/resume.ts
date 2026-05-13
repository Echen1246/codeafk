import {
  isProcessRunning,
  markLastThreadStopped,
  readLastThreadState,
} from "../daemon.js";

export async function resumeCommand(): Promise<void> {
  const state = await readLastThreadState();

  if (state === null) {
    console.log("No Agent Pager thread found.");
    return;
  }

  if (state.status === "running" && isProcessRunning(state.pid)) {
    process.kill(state.pid, "SIGTERM");
  }

  await markLastThreadStopped(state);

  console.log("Away Mode stopped.\n");
  console.log("To continue this thread in your terminal:");
  console.log(`  codex resume ${state.threadId}`);
}
