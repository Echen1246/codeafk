import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  findExistingConfigPath,
  getConfigPath,
  isChannelType,
  loadConfig,
  saveConfig,
  type AppConfig,
  type ChannelType,
} from "../config.js";
import { DiscordChannel, discordBotInviteUrl } from "../channel/discord.js";
import {
  describeTelegramUser,
  nextTelegramOffset,
  TelegramChannel,
  type TelegramMessageUpdate,
} from "../channel/telegram.js";

const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;

export async function initCommand(args: string[] = []): Promise<void> {
  const rl = createInterface({ input, output });

  try {
    await runInit(rl, parseInitArgs(args));
  } finally {
    rl.close();
  }
}

export function parseInitArgs(args: string[]): ChannelType | undefined {
  if (args.length === 0) {
    return undefined;
  }

  if (args.length === 1 && isChannelType(args[0] as string)) {
    return args[0] as ChannelType;
  }

  throw new Error("Usage: afk init [telegram|discord]");
}

async function runInit(rl: Interface, requestedChannel: ChannelType | undefined): Promise<void> {
  const configPath = getConfigPath();

  console.log("Welcome to AFK.\n");

  const channel = requestedChannel ?? (await chooseChannel(rl));
  const existingConfigPath = await findExistingConfigPath();
  const existingConfig =
    existingConfigPath === null ? null : await loadConfig(existingConfigPath);

  if (channel === "discord") {
    await runDiscordInit(rl, existingConfig, existingConfigPath, configPath);
    return;
  }

  await runTelegramInit(rl, existingConfig, existingConfigPath, configPath);
}

async function runTelegramInit(
  rl: Interface,
  existingConfig: AppConfig | null,
  existingConfigPath: string | null,
  configPath: string
): Promise<void> {
  if (
    existingConfigPath !== null &&
    existingConfig?.channels.telegram !== undefined &&
    !(await confirmOverwrite(rl, "Telegram", existingConfigPath))
  ) {
    return;
  }

  console.log("\nTelegram setup:");
  console.log("  1. Open Telegram and search @BotFather");
  console.log("  2. Send /newbot and follow the prompts");
  console.log("  3. Copy the bot token here\n");

  const botToken = await askRequired(rl, "Bot token: ");
  const telegram = new TelegramChannel({ botToken });
  const bot = await telegram.getMe();
  console.log(`Token accepted for ${describeTelegramUser(bot, bot.id)}.`);

  const offset = await getInitialOffset(telegram);
  console.log("\nNow send any message to your bot from your phone.");
  console.log("Waiting for Telegram updates...");

  const pairedUpdate = await waitForPairingMessage(telegram, offset);
  const displayName = describeTelegramUser(pairedUpdate.from, pairedUpdate.chatId);
  console.log(`\nDetected message from ${displayName} (chat_id ${pairedUpdate.chatId}).`);

  const pair = await askYesNo(rl, "Pair this Telegram account with afk? [y/n]: ");
  if (!pair) {
    console.log("Pairing cancelled. No config was written.");
    return;
  }

  await saveConfig(
    withTelegramConfig(existingConfig, {
      bot_token: botToken,
      chat_id: pairedUpdate.chatId,
    }),
    configPath
  );

  await telegram.sendMessage(
    pairedUpdate.chatId,
    "Paired successfully. Run `afk` in a repo to begin."
  );

  console.log("\nPaired successfully.");
  console.log(`Config saved to ${configPath}`);
  console.log("\nYou're ready. Try `afk` in a repo.");
}

async function runDiscordInit(
  rl: Interface,
  existingConfig: AppConfig | null,
  existingConfigPath: string | null,
  configPath: string
): Promise<void> {
  if (
    existingConfigPath !== null &&
    existingConfig?.channels.discord !== undefined &&
    !(await confirmOverwrite(rl, "Discord", existingConfigPath))
  ) {
    return;
  }

  console.log("\nDiscord setup:");
  console.log("  1. Open https://discord.com/developers/applications");
  console.log("  2. Create an application, then open Bot > Reset Token");
  console.log("  3. Copy the bot token here\n");

  const botToken = await askRequired(rl, "Bot token: ");
  const discord = new DiscordChannel({ botToken });

  try {
    await discord.start();
    const bot = discord.getBotUser();
    console.log(`Token accepted for ${bot.tag}.`);
    console.log("\nInstall this bot into a private Discord server you control:");
    console.log(discordBotInviteUrl(bot.id));
    console.log("\nThen open a direct message with the bot and send any message.");
    console.log("Waiting for Discord DM...");

    const pairedMessage = await discord.waitForPairingMessage();
    console.log(
      `\nDetected DM from ${pairedMessage.tag} (user_id ${pairedMessage.userId}).`
    );

    const pair = await askYesNo(rl, "Pair this Discord account with afk? [y/n]: ");
    if (!pair) {
      console.log("Pairing cancelled. No config was written.");
      return;
    }

    await saveConfig(
      withDiscordConfig(existingConfig, {
        bot_token: botToken,
        user_id: pairedMessage.userId,
        channel_id: pairedMessage.channelId,
      }),
      configPath
    );

    await discord.sendToChannel(
      pairedMessage.channelId,
      { text: "Paired successfully. Run `afk discord` in a repo to begin." }
    );

    console.log("\nPaired successfully.");
    console.log(`Config saved to ${configPath}`);
    console.log("\nYou're ready. Try `afk discord` in a repo.");
  } finally {
    await discord.stop();
  }
}

function withTelegramConfig(
  existingConfig: AppConfig | null,
  telegram: NonNullable<AppConfig["channels"]["telegram"]>
): AppConfig {
  return {
    default_channel: existingConfig?.default_channel ?? "telegram",
    channels: {
      ...(existingConfig?.channels ?? {}),
      telegram,
    },
    agent: {
      type: "codex",
    },
  };
}

function withDiscordConfig(
  existingConfig: AppConfig | null,
  discord: NonNullable<AppConfig["channels"]["discord"]>
): AppConfig {
  return {
    default_channel: existingConfig?.default_channel ?? "discord",
    channels: {
      ...(existingConfig?.channels ?? {}),
      discord,
    },
    agent: {
      type: "codex",
    },
  };
}

async function chooseChannel(rl: Interface): Promise<ChannelType> {
  console.log("Choose your messaging channel:");
  console.log("  1) Telegram");
  console.log("  2) Discord\n");

  while (true) {
    const choice = (await rl.question("> ")).trim().toLowerCase();
    if (choice === "" || choice === "1" || choice === "telegram") {
      return "telegram";
    }
    if (choice === "2" || choice === "discord") {
      return "discord";
    }
    console.log("Choose 1 for Telegram or 2 for Discord.");
  }
}

async function confirmOverwrite(
  rl: Interface,
  channelName: string,
  existingConfigPath: string
): Promise<boolean> {
  console.log(`Existing ${channelName} pairing found at ${existingConfigPath}.`);
  const overwrite = await askYesNo(rl, "Overwrite it? [y/n]: ");
  if (!overwrite) {
    console.log("Leaving existing config unchanged.");
    return false;
  }
  console.log("");
  return true;
}

async function getInitialOffset(telegram: TelegramChannel): Promise<number | undefined> {
  const pendingUpdates = await telegram.getUpdates({ timeoutSeconds: 0 });
  return nextTelegramOffset(pendingUpdates);
}

async function waitForPairingMessage(
  telegram: TelegramChannel,
  initialOffset: number | undefined
): Promise<TelegramMessageUpdate> {
  let offset = initialOffset;

  while (true) {
    const updates = await telegram.getUpdates({
      ...(offset === undefined ? {} : { offset }),
      timeoutSeconds: TELEGRAM_POLL_TIMEOUT_SECONDS,
    });

    const nextOffset = nextTelegramOffset(updates);
    if (nextOffset !== undefined) {
      offset = nextOffset;
    }

    const update = updates.find(
      (candidate): candidate is TelegramMessageUpdate => candidate.type === "message"
    );
    if (update !== undefined) {
      return update;
    }

    console.log("Still waiting. Send any message to the bot from Telegram.");
  }
}

async function askRequired(rl: Interface, prompt: string): Promise<string> {
  while (true) {
    const value = (await rl.question(prompt)).trim();
    if (value.length > 0) {
      return value;
    }
    console.log("Please enter a value.");
  }
}

async function askYesNo(rl: Interface, prompt: string): Promise<boolean> {
  while (true) {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    console.log("Please answer y or n.");
  }
}
