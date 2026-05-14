import { runDaemon } from "../daemon.js";
import { isChannelType, type ChannelType } from "../config.js";

export type StartCommandOptions = {
  acceptAgentConfig?: boolean;
  channelType?: ChannelType;
};

export function parseStartArgs(args: string[]): StartCommandOptions {
  let acceptAgentConfig = false;
  let channelType: ChannelType | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--accept-agent-config") {
      acceptAgentConfig = true;
      continue;
    }

    if (arg === "--channel") {
      const value = args[index + 1];
      if (value === undefined || !isChannelType(value)) {
        throw new Error("--channel must be followed by telegram or discord");
      }
      channelType = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--channel=")) {
      const value = arg.slice("--channel=".length);
      if (!isChannelType(value)) {
        throw new Error("--channel must be telegram or discord");
      }
      channelType = value;
      continue;
    }

    if (isChannelType(arg)) {
      channelType = arg;
      continue;
    }

    throw new Error(`Unknown start option: ${arg}`);
  }

  return {
    acceptAgentConfig,
    ...(channelType === undefined ? {} : { channelType }),
  };
}

export async function startCommand(options: StartCommandOptions = {}): Promise<void> {
  await runDaemon({
    acceptAgentConfig: options.acceptAgentConfig,
    channelType: options.channelType,
  });
}
