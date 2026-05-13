import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { configExists, getConfigPath, saveConfig } from "../config.js";
import {
  describeTelegramUser,
  nextTelegramOffset,
  TelegramChannel,
  type TelegramMessageUpdate,
} from "../channel/telegram.js";

const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;

export async function initCommand(): Promise<void> {
  const rl = createInterface({ input, output });

  try {
    await runInit(rl);
  } finally {
    rl.close();
  }
}

async function runInit(rl: Interface): Promise<void> {
  const configPath = getConfigPath();

  console.log("Welcome to Agent Pager.\n");

  if (await configExists(configPath)) {
    console.log(`Existing pairing found at ${configPath}.`);
    const overwrite = await askYesNo(rl, "Overwrite it? [y/n]: ");
    if (!overwrite) {
      console.log("Leaving existing config unchanged.");
      return;
    }
    console.log("");
  }

  await chooseTelegram(rl);

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

  const pair = await askYesNo(rl, "Pair this Telegram account with apgr? [y/n]: ");
  if (!pair) {
    console.log("Pairing cancelled. No config was written.");
    return;
  }

  await saveConfig(
    {
      channel: {
        type: "telegram",
        bot_token: botToken,
        chat_id: pairedUpdate.chatId,
      },
      agent: {
        type: "codex",
      },
    },
    configPath
  );

  await telegram.sendMessage(
    pairedUpdate.chatId,
    "Paired successfully. Run `apgr start` in a repo to begin."
  );

  console.log("\nPaired successfully.");
  console.log(`Config saved to ${configPath}`);
  console.log("\nYou're ready. Try `apgr start` in a repo.");
}

async function chooseTelegram(rl: Interface): Promise<void> {
  console.log("Choose your messaging channel:");
  console.log("  1) Telegram");
  console.log("  2) Discord (coming in v0.5)\n");

  while (true) {
    const choice = (await rl.question("> ")).trim().toLowerCase();
    if (choice === "" || choice === "1" || choice === "telegram") {
      return;
    }
    if (choice === "2" || choice === "discord") {
      console.log("Discord pairing is deferred to v0.5. Choose Telegram for v0.");
      continue;
    }
    console.log("Choose 1 for Telegram.");
  }
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
