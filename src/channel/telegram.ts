type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

import type { ChannelEvent, ChannelMessage, MessageChannel } from "./types.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;
const TELEGRAM_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000] as const;

type TelegramConnectionStatus = "connected" | "disconnected";

export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type TelegramMessageUpdate = {
  type: "message";
  updateId: number;
  chatId: number;
  from?: TelegramUser;
  text?: string;
};

type TelegramCallbackUpdate = {
  type: "callback_query";
  updateId: number;
  callbackQueryId: string;
  callbackId: string;
  from: TelegramUser;
  chatId?: number;
};

export type TelegramUpdate = TelegramMessageUpdate | TelegramCallbackUpdate;

type TelegramChannelOptions = {
  botToken: string;
  chatId?: number;
  fetch?: FetchLike;
  onConnectionStateChange?: (status: TelegramConnectionStatus, error?: Error) => void;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

export class TelegramChannel implements MessageChannel {
  private readonly apiBase: string;
  private readonly chatId: number | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly onConnectionStateChange:
    | ((status: TelegramConnectionStatus, error?: Error) => void)
    | undefined;
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private connectionStatus: TelegramConnectionStatus | null = null;
  private running = false;

  constructor(options: TelegramChannelOptions) {
    this.apiBase = `https://api.telegram.org/bot${options.botToken}`;
    this.chatId = options.chatId;
    this.fetchImpl = options.fetch ?? fetch;
    this.onConnectionStateChange = options.onConnectionStateChange;
    this.retryDelaysMs = options.retryDelaysMs ?? TELEGRAM_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? sleep;
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
      await this.sendMessage(this.chatId, chunk, msg.buttons);
    }

    for (const attachment of msg.attachments ?? []) {
      await this.sendDocument(this.chatId, attachment);
    }
  }

  async *events(): AsyncIterable<ChannelEvent> {
    if (this.chatId === undefined) {
      throw new Error("Telegram chat_id is required before polling channel events");
    }

    let offset: number | undefined;
    let drainedInitialUpdates = false;
    let retryAttempt = 0;

    while (this.running) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.getUpdates({
          ...(offset === undefined ? {} : { offset }),
          timeoutSeconds: drainedInitialUpdates ? TELEGRAM_POLL_TIMEOUT_SECONDS : 0,
        });
        this.setConnectionStatus("connected");
        retryAttempt = 0;
      } catch (error) {
        this.setConnectionStatus("disconnected", asError(error));
        await this.sleep(retryDelayMs(this.retryDelaysMs, retryAttempt));
        retryAttempt += 1;
        continue;
      }

      offset = nextTelegramOffset(updates) ?? offset;

      if (!drainedInitialUpdates) {
        drainedInitialUpdates = true;
        continue;
      }

      for (const update of updates) {
        if (update.type === "message" && update.chatId !== this.chatId) {
          continue;
        }

        if (update.type === "message" && update.text !== undefined) {
          yield {
            type: "message",
            text: update.text,
            fromUserId: String(update.from?.id ?? update.chatId),
          };
          continue;
        }

        if (update.type === "callback_query" && update.chatId === this.chatId) {
          await this.answerCallbackQuery(update.callbackQueryId);
          yield {
            type: "button_press",
            callbackId: update.callbackId,
            fromUserId: String(update.from.id),
          };
        }
      }
    }
  }

  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe", {});
  }

  async getUpdates(options: {
    offset?: number;
    timeoutSeconds: number;
  }): Promise<TelegramUpdate[]> {
    const result = await this.call<unknown[]>("getUpdates", {
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      timeout: options.timeoutSeconds,
      allowed_updates: ["message", "callback_query"],
    });

    return result.flatMap(parseTelegramUpdate);
  }

  async sendMessage(
    chatId: number,
    text: string,
    buttons?: Array<{ label: string; callbackId: string }>
  ): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(buttons === undefined || buttons.length === 0
        ? {}
        : { reply_markup: toInlineKeyboard(buttons) }),
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text === undefined ? {} : { text }),
    });
  }

  private async sendDocument(
    chatId: number,
    attachment: NonNullable<ChannelMessage["attachments"]>[number]
  ): Promise<void> {
    const content = Uint8Array.from(attachment.content);
    const body = new FormData();
    body.set("chat_id", String(chatId));
    body.set(
      "document",
      new File([content], attachment.filename, {
        type: attachment.mimeType,
      })
    );

    await this.callMultipart("sendDocument", body);
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

  private async callMultipart<T>(method: string, body: FormData): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}/${method}`, {
      method: "POST",
      body,
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

  private setConnectionStatus(status: TelegramConnectionStatus, error?: Error): void {
    if (this.connectionStatus === status) {
      return;
    }

    this.connectionStatus = status;
    this.onConnectionStateChange?.(status, error);
  }
}

export function nextTelegramOffset(updates: TelegramUpdate[]): number | undefined {
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

function toInlineKeyboard(buttons: Array<{ label: string; callbackId: string }>): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [
      buttons.map((button) => {
        if (Buffer.byteLength(button.callbackId, "utf8") > 64) {
          throw new Error("Telegram callback_data must be 64 bytes or less");
        }

        return {
          text: button.label,
          callback_data: button.callbackId,
        };
      }),
    ],
  };
}

function parseTelegramUpdate(update: unknown): TelegramUpdate[] {
  if (!isRecord(update) || typeof update.update_id !== "number") {
    return [];
  }

  if (isRecord(update.message)) {
    return parseMessageUpdate(update.update_id, update.message);
  }

  if (isRecord(update.callback_query)) {
    return parseCallbackUpdate(update.update_id, update.callback_query);
  }

  return [];
}

function parseMessageUpdate(updateId: number, message: Record<string, unknown>): TelegramMessageUpdate[] {
  if (!isRecord(message.chat) || typeof message.chat.id !== "number") {
    return [];
  }

  return [
    {
      type: "message",
      updateId,
      chatId: message.chat.id,
      ...(isTelegramUser(message.from) ? { from: message.from } : {}),
      ...(typeof message.text === "string" ? { text: message.text } : {}),
    },
  ];
}

function parseCallbackUpdate(
  updateId: number,
  callbackQuery: Record<string, unknown>
): TelegramCallbackUpdate[] {
  if (
    typeof callbackQuery.id !== "string" ||
    !isTelegramUser(callbackQuery.from) ||
    typeof callbackQuery.data !== "string"
  ) {
    return [];
  }

  const chatId = callbackQueryMessageChatId(callbackQuery);

  return [
    {
      type: "callback_query",
      updateId,
      callbackQueryId: callbackQuery.id,
      callbackId: callbackQuery.data,
      from: callbackQuery.from,
      ...(chatId === undefined ? {} : { chatId }),
    },
  ];
}

function callbackQueryMessageChatId(callbackQuery: Record<string, unknown>): number | undefined {
  if (
    isRecord(callbackQuery.message) &&
    isRecord(callbackQuery.message.chat) &&
    typeof callbackQuery.message.chat.id === "number"
  ) {
    return callbackQuery.message.chat.id;
  }

  return undefined;
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

function retryDelayMs(delays: readonly number[], attempt: number): number {
  if (delays.length === 0) {
    return 0;
  }

  return delays[Math.min(attempt, delays.length - 1)] ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
