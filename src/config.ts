import { mkdir, readFile, stat, chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as TOML from "@iarna/toml";

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

export type AppConfig = {
  channel: {
    type: "telegram";
    bot_token: string;
    chat_id: number;
  };
  agent: {
    type: "codex";
  };
};

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const appData = env.APPDATA;
    if (appData !== undefined && appData.length > 0) {
      return join(appData, "apgr", "config.toml");
    }
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const configHome =
    xdgConfigHome !== undefined && xdgConfigHome.length > 0
      ? xdgConfigHome
      : join(homedir(), ".config");

  return join(configHome, "apgr", "config.toml");
}

export async function configExists(configPath = getConfigPath()): Promise<boolean> {
  try {
    await stat(configPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function loadConfig(configPath = getConfigPath()): Promise<AppConfig | null> {
  let rawConfig: string;
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  return parseConfig(rawConfig);
}

export async function saveConfig(config: AppConfig, configPath = getConfigPath()): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: CONFIG_DIR_MODE });
  await writeFile(configPath, TOML.stringify(config), { mode: CONFIG_FILE_MODE });

  if (process.platform !== "win32") {
    await chmod(configPath, CONFIG_FILE_MODE);
  }
}

export function parseConfig(rawConfig: string): AppConfig {
  const parsed = TOML.parse(rawConfig);
  const channel = getRecord(parsed, "channel");
  const agent = getRecord(parsed, "agent");
  const channelType = channel.type;
  const botToken = channel.bot_token;
  const chatId = channel.chat_id;
  const agentType = agent.type;

  if (channelType !== "telegram") {
    throw new Error("Config channel.type must be \"telegram\"");
  }

  if (typeof botToken !== "string" || botToken.length === 0) {
    throw new Error("Config channel.bot_token must be a non-empty string");
  }

  if (typeof chatId !== "number" || !Number.isInteger(chatId)) {
    throw new Error("Config channel.chat_id must be an integer");
  }

  if (agentType !== "codex") {
    throw new Error("Config agent.type must be \"codex\"");
  }

  return {
    channel: {
      type: "telegram",
      bot_token: botToken,
      chat_id: chatId,
    },
    agent: {
      type: "codex",
    },
  };
}

function getRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    throw new Error(`Config ${key} section is missing or invalid`);
  }
  return nested as Record<string, unknown>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
