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
