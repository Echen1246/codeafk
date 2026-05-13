import {
  isProcessRunning,
  markLastThreadStopped,
  readLastThreadStateWithPath,
} from "../daemon.js";

export async function stopCommand(): Promise<void> {
  const stateEntry = await readLastThreadStateWithPath();

  if (stateEntry === null) {
    console.log("No AFK session found.");
    return;
  }

  const { state, statePath } = stateEntry;
  if (state.status !== "running" || !isProcessRunning(state.pid)) {
    await markLastThreadStopped(state, statePath);
    console.log("AFK is not running.");
    return;
  }

  process.kill(state.pid, "SIGTERM");
  console.log(`Sent stop signal to afk process ${state.pid}.`);
}
