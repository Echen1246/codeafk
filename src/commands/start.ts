import { runDaemon } from "../daemon.js";

export async function startCommand(): Promise<void> {
  await runDaemon();
}
