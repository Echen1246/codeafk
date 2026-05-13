import {
  isProcessRunning,
  markLastThreadStopped,
  readLastThreadState,
} from "../daemon.js";

export async function stopCommand(): Promise<void> {
  const state = await readLastThreadState();

  if (state === null) {
    console.log("No Agent Pager session found.");
    return;
  }

  if (state.status !== "running" || !isProcessRunning(state.pid)) {
    await markLastThreadStopped(state);
    console.log("Agent Pager is not running.");
    return;
  }

  process.kill(state.pid, "SIGTERM");
  console.log(`Sent stop signal to apgr process ${state.pid}.`);
}
