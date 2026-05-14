import { mkdir, readFile, stat, chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as TOML from "@iarna/toml";

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;
const APP_CONFIG_DIR = "afk";
const LEGACY_APP_CONFIG_DIR = "apgr";
const CHANNEL_TYPES = ["telegram", "discord"] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];

type TelegramChannelConfig = {
  bot_token: string;
  chat_id: number;
};

type DiscordChannelConfig = {
  bot_token: string;
  user_id: string;
  channel_id: string;
};

export type AppConfig = {
  default_channel: ChannelType;
  channels: {
    telegram?: TelegramChannelConfig;
    discord?: DiscordChannelConfig;
  };
  agent: {
    type: "codex";
  };
};

export type ResolvedChannelConfig =
  | { type: "telegram"; config: TelegramChannelConfig }
  | { type: "discord"; config: DiscordChannelConfig };

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const appData = env.APPDATA;
    if (appData !== undefined && appData.length > 0) {
      return join(appData, APP_CONFIG_DIR, "config.toml");
    }
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const configHome =
    xdgConfigHome !== undefined && xdgConfigHome.length > 0
      ? xdgConfigHome
      : join(homedir(), ".config");

  return join(configHome, APP_CONFIG_DIR, "config.toml");
}

export function getLegacyConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const appData = env.APPDATA;
    if (appData !== undefined && appData.length > 0) {
      return join(appData, LEGACY_APP_CONFIG_DIR, "config.toml");
    }
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const configHome =
    xdgConfigHome !== undefined && xdgConfigHome.length > 0
      ? xdgConfigHome
      : join(homedir(), ".config");

  return join(configHome, LEGACY_APP_CONFIG_DIR, "config.toml");
}

async function configExists(configPath = getConfigPath()): Promise<boolean> {
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

export async function findExistingConfigPath(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const configPath = getConfigPath(env);
  if (await configExists(configPath)) {
    return configPath;
  }

  const legacyConfigPath = getLegacyConfigPath(env);
  return (await configExists(legacyConfigPath)) ? legacyConfigPath : null;
}

export async function loadConfig(configPath = getConfigPath()): Promise<AppConfig | null> {
  const readableConfigPath = await resolveReadableConfigPath(configPath);
  if (readableConfigPath === null) {
    return null;
  }

  let rawConfig: string;
  try {
    rawConfig = await readFile(readableConfigPath, "utf8");
  } catch (error) {
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
  const agent = getRecord(parsed, "agent");
  const agentType = agent.type;

  if (agentType !== "codex") {
    throw new Error("Config agent.type must be \"codex\"");
  }

  if (isRecord(parsed.channel)) {
    return parseLegacyTelegramConfig(parsed.channel);
  }

  const channels = getRecord(parsed, "channels");
  const configuredChannels = parseChannelConfigs(channels);
  const configuredTypes = configuredChannelTypes({
    default_channel: "telegram",
    channels: configuredChannels,
    agent: { type: "codex" },
  });

  if (configuredTypes.length === 0) {
    throw new Error("Config must include at least one configured channel");
  }

  const defaultChannel = defaultChannelFromParsedConfig(parsed.default_channel, configuredTypes);

  return {
    default_channel: defaultChannel,
    channels: configuredChannels,
    agent: {
      type: "codex",
    },
  };
}

export function configuredChannelTypes(config: AppConfig): ChannelType[] {
  return CHANNEL_TYPES.filter((type) => config.channels[type] !== undefined);
}

export function resolveChannelConfig(
  config: AppConfig,
  requestedChannel?: ChannelType
): ResolvedChannelConfig {
  const selectedChannel = requestedChannel ?? config.default_channel;

  if (selectedChannel === "telegram") {
    const telegram = config.channels.telegram;
    if (telegram === undefined) {
      throw new Error("Telegram is not configured. Run `afk init telegram` first.");
    }
    return { type: "telegram", config: telegram };
  }

  const discord = config.channels.discord;
  if (discord === undefined) {
    throw new Error("Discord is not configured. Run `afk init discord` first.");
  }
  return { type: "discord", config: discord };
}

export function isChannelType(value: string): value is ChannelType {
  return CHANNEL_TYPES.includes(value as ChannelType);
}

function parseLegacyTelegramConfig(channel: Record<string, unknown>): AppConfig {
  const channelType = channel.type;
  const botToken = channel.bot_token;
  const chatId = channel.chat_id;

  if (channelType !== "telegram") {
    throw new Error("Config channel.type must be \"telegram\"");
  }

  if (typeof botToken !== "string" || botToken.length === 0) {
    throw new Error("Config channel.bot_token must be a non-empty string");
  }

  if (typeof chatId !== "number" || !Number.isInteger(chatId)) {
    throw new Error("Config channel.chat_id must be an integer");
  }

  return {
    default_channel: "telegram",
    channels: {
      telegram: {
        bot_token: botToken,
        chat_id: chatId,
      },
    },
    agent: {
      type: "codex",
    },
  };
}

function parseChannelConfigs(channels: Record<string, unknown>): AppConfig["channels"] {
  const config: AppConfig["channels"] = {};

  if (channels.telegram !== undefined) {
    config.telegram = parseTelegramChannelConfig(getRecord(channels, "telegram"));
  }

  if (channels.discord !== undefined) {
    config.discord = parseDiscordChannelConfig(getRecord(channels, "discord"));
  }

  return config;
}

function parseTelegramChannelConfig(channel: Record<string, unknown>): TelegramChannelConfig {
  const botToken = channel.bot_token;
  const chatId = channel.chat_id;

  if (typeof botToken !== "string" || botToken.length === 0) {
    throw new Error("Config channels.telegram.bot_token must be a non-empty string");
  }

  if (typeof chatId !== "number" || !Number.isInteger(chatId)) {
    throw new Error("Config channels.telegram.chat_id must be an integer");
  }

  return {
    bot_token: botToken,
    chat_id: chatId,
  };
}

function parseDiscordChannelConfig(channel: Record<string, unknown>): DiscordChannelConfig {
  const botToken = channel.bot_token;
  const userId = channel.user_id;
  const channelId = channel.channel_id;

  if (typeof botToken !== "string" || botToken.length === 0) {
    throw new Error("Config channels.discord.bot_token must be a non-empty string");
  }

  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("Config channels.discord.user_id must be a non-empty string");
  }

  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new Error("Config channels.discord.channel_id must be a non-empty string");
  }

  return {
    bot_token: botToken,
    user_id: userId,
    channel_id: channelId,
  };
}

function defaultChannelFromParsedConfig(
  value: unknown,
  configuredTypes: ChannelType[]
): ChannelType {
  if (value === undefined) {
    if (configuredTypes.length === 1) {
      return configuredTypes[0] as ChannelType;
    }
    throw new Error("Config default_channel must be set when multiple channels are configured");
  }

  if (typeof value !== "string" || !isChannelType(value)) {
    throw new Error('Config default_channel must be "telegram" or "discord"');
  }

  if (!configuredTypes.includes(value)) {
    throw new Error(`Config default_channel "${value}" is not configured`);
  }

  return value;
}

async function resolveReadableConfigPath(configPath: string): Promise<string | null> {
  if (await configExists(configPath)) {
    return configPath;
  }

  if (configPath !== getConfigPath()) {
    const legacySiblingConfigPath = legacySiblingPath(configPath);
    if (legacySiblingConfigPath === null) {
      return null;
    }
    return (await configExists(legacySiblingConfigPath)) ? legacySiblingConfigPath : null;
  }

  const legacyConfigPath = getLegacyConfigPath();
  return (await configExists(legacyConfigPath)) ? legacyConfigPath : null;
}

function legacySiblingPath(configPath: string): string | null {
  const configDir = dirname(configPath);
  if (basename(configDir) !== APP_CONFIG_DIR) {
    return null;
  }

  return join(dirname(configDir), LEGACY_APP_CONFIG_DIR, basename(configPath));
}

function getRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    throw new Error(`Config ${key} section is missing or invalid`);
  }
  return nested as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
