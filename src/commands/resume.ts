import {
  isProcessRunning,
  markLastThreadStopped,
  readLastThreadStateWithPath,
} from "../daemon.js";

export async function resumeCommand(): Promise<void> {
  const stateEntry = await readLastThreadStateWithPath();

  if (stateEntry === null) {
    console.log("No AFK thread found.");
    return;
  }

  const { state, statePath } = stateEntry;
  if (state.status === "running" && isProcessRunning(state.pid)) {
    process.kill(state.pid, "SIGTERM");
  }

  await markLastThreadStopped(state, statePath);

  if (state.threadId === null) {
    console.log("Away Mode stopped.");
    console.log("No Codex thread was selected yet.");
    return;
  }

  console.log(formatResumeInstructions(state.threadId));
}

export function formatResumeInstructions(threadId: string): string {
  return [
    "Away Mode stopped.",
    "",
    "To continue this thread in your terminal:",
    `  codex resume ${threadId}`,
    "",
    "Note: an already-open Codex window may not live-refresh phone updates. Reopen or resume the thread to view the phone-session transcript.",
  ].join("\n");
}
