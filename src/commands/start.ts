import { runDaemon } from "../daemon.js";

export type StartCommandOptions = {
  acceptAgentConfig?: boolean;
};

export function parseStartArgs(args: string[]): StartCommandOptions {
  let acceptAgentConfig = false;

  for (const arg of args) {
    if (arg === "--accept-agent-config") {
      acceptAgentConfig = true;
      continue;
    }

    throw new Error(`Unknown start option: ${arg}`);
  }

  return { acceptAgentConfig };
}

export async function startCommand(options: StartCommandOptions = {}): Promise<void> {
  await runDaemon({ acceptAgentConfig: options.acceptAgentConfig });
}
