type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

import type { ChannelEvent, ChannelMessage, MessageChannel } from "./types.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;

export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type TelegramMessageUpdate = {
  updateId: number;
  chatId: number;
  from?: TelegramUser;
  text?: string;
};

type TelegramChannelOptions = {
  botToken: string;
  chatId?: number;
  fetch?: FetchLike;
};

export class TelegramChannel implements MessageChannel {
  private readonly apiBase: string;
  private readonly chatId: number | undefined;
  private readonly fetchImpl: FetchLike;
  private running = false;

  constructor(options: TelegramChannelOptions) {
    this.apiBase = `https://api.telegram.org/bot${options.botToken}`;
    this.chatId = options.chatId;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async send(msg: ChannelMessage): Promise<void> {
    if (this.chatId === undefined) {
      throw new Error("Telegram chat_id is required before sending channel messages");
    }

    for (const chunk of splitTelegramText(msg.text)) {
      await this.sendMessage(this.chatId, chunk);
    }
  }

  async *events(): AsyncIterable<ChannelEvent> {
    if (this.chatId === undefined) {
      throw new Error("Telegram chat_id is required before polling channel events");
    }

    let offset = nextTelegramOffset(await this.getUpdates({ timeoutSeconds: 0 }));

    while (this.running) {
      const updates = await this.getUpdates({
        ...(offset === undefined ? {} : { offset }),
        timeoutSeconds: TELEGRAM_POLL_TIMEOUT_SECONDS,
      });
      const nextOffset = nextTelegramOffset(updates);
      if (nextOffset !== undefined) {
        offset = nextOffset;
      }

      for (const update of updates) {
        if (update.chatId !== this.chatId || update.text === undefined) {
          continue;
        }

        yield {
          type: "message",
          text: update.text,
          fromUserId: String(update.from?.id ?? update.chatId),
        };
      }
    }
  }

  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe", {});
  }

  async getUpdates(options: {
    offset?: number;
    timeoutSeconds: number;
  }): Promise<TelegramMessageUpdate[]> {
    const result = await this.call<unknown[]>("getUpdates", {
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      timeout: options.timeoutSeconds,
      allowed_updates: ["message"],
    });

    return result.flatMap(parseMessageUpdate);
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
    });
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload: unknown = await response.json();
    if (!isTelegramResponse(payload)) {
      throw new Error(`Telegram ${method} returned an invalid response`);
    }

    if (!payload.ok) {
      throw new Error(`Telegram ${method} failed: ${payload.description}`);
    }

    return payload.result as T;
  }
}

export function nextTelegramOffset(updates: TelegramMessageUpdate[]): number | undefined {
  const latest = updates.reduce<number | null>(
    (current, update) => (current === null || update.updateId > current ? update.updateId : current),
    null
  );

  return latest === null ? undefined : latest + 1;
}

export function splitTelegramText(text: string): string[] {
  if (text.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(text.slice(index, index + TELEGRAM_MESSAGE_LIMIT));
  }
  return chunks;
}

export function describeTelegramUser(user: TelegramUser | undefined, chatId: number): string {
  if (user?.username !== undefined) {
    return `@${user.username}`;
  }

  const fullName = [user?.first_name, user?.last_name].filter(isPresent).join(" ");
  if (fullName.length > 0) {
    return fullName;
  }

  return `chat_id ${chatId}`;
}

function parseMessageUpdate(update: unknown): TelegramMessageUpdate[] {
  if (!isRecord(update) || typeof update.update_id !== "number" || !isRecord(update.message)) {
    return [];
  }

  const message = update.message;
  if (!isRecord(message.chat) || typeof message.chat.id !== "number") {
    return [];
  }

  return [
    {
      updateId: update.update_id,
      chatId: message.chat.id,
      ...(isTelegramUser(message.from) ? { from: message.from } : {}),
      ...(typeof message.text === "string" ? { text: message.text } : {}),
    },
  ];
}

function isTelegramResponse(value: unknown): value is
  | { ok: true; result: unknown }
  | { ok: false; description: string } {
  return (
    isRecord(value) &&
    ((value.ok === true && "result" in value) ||
      (value.ok === false && typeof value.description === "string"))
  );
}

function isTelegramUser(value: unknown): value is TelegramUser {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    (value.username === undefined || typeof value.username === "string") &&
    (value.first_name === undefined || typeof value.first_name === "string") &&
    (value.last_name === undefined || typeof value.last_name === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
