import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";

import type { ChannelEvent, ChannelMessage, MessageChannel } from "./types.js";

const DISCORD_MESSAGE_LIMIT = 1900;

type DiscordConnectionStatus = "connected" | "disconnected";

type DiscordUser = {
  id: string;
  username: string;
  tag: string;
};

type DiscordPairingMessage = {
  userId: string;
  channelId: string;
  username: string;
  tag: string;
};

type DiscordChannelOptions = {
  botToken: string;
  userId?: string;
  channelId?: string;
  client?: DiscordClientLike;
  onConnectionStateChange?: (status: DiscordConnectionStatus, error?: Error) => void;
};

type DiscordClientLike = {
  user: DiscordUser | null;
  channels: {
    fetch(channelId: string): Promise<unknown>;
  };
  login(token: string): Promise<string>;
  destroy(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
};

type DiscordMessageLike = {
  author: {
    id: string;
    bot?: boolean;
    username?: string;
    tag?: string;
  };
  channelId: string;
  channel: {
    type?: unknown;
    isDMBased?: () => boolean;
  };
  content: string;
};

type DiscordButtonInteractionLike = {
  customId: string;
  channelId: string | null;
  user: {
    id: string;
    bot?: boolean;
  };
  isButton: () => boolean;
  deferUpdate: () => Promise<unknown>;
};

type DiscordSendableChannel = {
  send(options: DiscordSendOptions): Promise<unknown>;
};

type DiscordSendOptions = {
  content?: string;
  components?: Array<ActionRowBuilder<ButtonBuilder>>;
  files?: AttachmentBuilder[];
};

type QueueWaiter<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: Error) => void;
};

export class DiscordChannel implements MessageChannel {
  private readonly botToken: string;
  private readonly userId: string | undefined;
  private readonly channelId: string | undefined;
  private readonly client: DiscordClientLike;
  private readonly eventsQueue = new AsyncEventQueue<ChannelEvent>();
  private readonly pairingQueue = new AsyncEventQueue<DiscordPairingMessage>();
  private readonly onConnectionStateChange:
    | ((status: DiscordConnectionStatus, error?: Error) => void)
    | undefined;
  private connectionStatus: DiscordConnectionStatus | null = null;
  private running = false;
  private listenersInstalled = false;

  constructor(options: DiscordChannelOptions) {
    this.botToken = options.botToken;
    this.userId = options.userId;
    this.channelId = options.channelId;
    this.client = options.client ?? createDiscordClient();
    this.onConnectionStateChange = options.onConnectionStateChange;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.installListeners();

    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, () => {
        this.setConnectionStatus("connected");
        resolve();
      });
      this.client.login(this.botToken).catch((error: unknown) => {
        reject(asError(error));
      });
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.eventsQueue.close();
    this.pairingQueue.close();
    this.client.destroy();
    this.setConnectionStatus("disconnected");
  }

  async send(msg: ChannelMessage): Promise<void> {
    if (this.channelId === undefined) {
      throw new Error("Discord channel_id is required before sending channel messages");
    }

    await this.sendToChannel(this.channelId, msg);
  }

  async sendToChannel(channelId: string, msg: ChannelMessage): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!isDiscordSendableChannel(channel)) {
      throw new Error("Discord channel is not sendable");
    }

    const chunks = splitDiscordText(msg.text);
    const components =
      msg.buttons === undefined || msg.buttons.length === 0
        ? undefined
        : toDiscordComponents(msg.buttons);

    for (const [index, chunk] of chunks.entries()) {
      await channel.send({
        content: chunk,
        ...(index === chunks.length - 1 && components !== undefined ? { components } : {}),
      });
    }

    if (msg.attachments !== undefined && msg.attachments.length > 0) {
      await channel.send({
        files: msg.attachments.map(
          (attachment) =>
            new AttachmentBuilder(attachment.content, {
              name: attachment.filename,
              description: attachment.mimeType,
            })
        ),
      });
    }
  }

  async *events(): AsyncIterable<ChannelEvent> {
    yield* this.eventsQueue;
  }

  async waitForPairingMessage(): Promise<DiscordPairingMessage> {
    const event = await this.pairingQueue.next();
    if (event.done === true) {
      throw new Error("Discord channel stopped before pairing completed");
    }
    return event.value;
  }

  getBotUser(): DiscordUser {
    const user = this.client.user;
    if (user === null) {
      throw new Error("Discord bot is not ready");
    }
    return user;
  }

  private installListeners(): void {
    if (this.listenersInstalled) {
      return;
    }

    this.listenersInstalled = true;
    this.client.on(Events.MessageCreate, (message: unknown) => {
      this.handleMessageCreate(message).catch((error: unknown) => {
        this.setConnectionStatus("disconnected", asError(error));
      });
    });
    this.client.on(Events.InteractionCreate, (interaction: unknown) => {
      this.handleInteractionCreate(interaction).catch((error: unknown) => {
        this.setConnectionStatus("disconnected", asError(error));
      });
    });
    this.client.on(Events.Error, (error: unknown) => {
      this.setConnectionStatus("disconnected", asError(error));
    });
    this.client.on(Events.ShardDisconnect, (error: unknown) => {
      this.setConnectionStatus("disconnected", asError(error));
    });
  }

  private async handleMessageCreate(message: unknown): Promise<void> {
    if (!this.running || !isDiscordDirectMessage(message) || message.author.bot === true) {
      return;
    }

    this.pairingQueue.push({
      userId: message.author.id,
      channelId: message.channelId,
      username: message.author.username ?? message.author.id,
      tag: message.author.tag ?? message.author.username ?? message.author.id,
    });

    if (!this.isAllowedUser(message.author.id) || !this.isAllowedChannel(message.channelId)) {
      return;
    }

    this.eventsQueue.push({
      type: "message",
      text: message.content,
      fromUserId: message.author.id,
    });
  }

  private async handleInteractionCreate(interaction: unknown): Promise<void> {
    if (
      !this.running ||
      !isDiscordButtonInteraction(interaction) ||
      interaction.user.bot === true ||
      !this.isAllowedUser(interaction.user.id) ||
      !this.isAllowedChannel(interaction.channelId)
    ) {
      return;
    }

    await interaction.deferUpdate();
    this.eventsQueue.push({
      type: "button_press",
      callbackId: interaction.customId,
      fromUserId: interaction.user.id,
    });
  }

  private isAllowedUser(userId: string): boolean {
    return this.userId === undefined || userId === this.userId;
  }

  private isAllowedChannel(channelId: string | null): boolean {
    return this.channelId === undefined || channelId === this.channelId;
  }

  private setConnectionStatus(status: DiscordConnectionStatus, error?: Error): void {
    if (this.connectionStatus === status) {
      return;
    }

    this.connectionStatus = status;
    this.onConnectionStateChange?.(status, error);
  }
}

export function discordBotInviteUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: "bot",
    permissions: "0",
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function splitDiscordText(text: string): string[] {
  if (text.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += DISCORD_MESSAGE_LIMIT) {
    chunks.push(text.slice(index, index + DISCORD_MESSAGE_LIMIT));
  }
  return chunks;
}

export function toDiscordComponents(
  buttons: Array<{ label: string; callbackId: string }>
): Array<ActionRowBuilder<ButtonBuilder>> {
  const row = new ActionRowBuilder<ButtonBuilder>();

  for (const button of buttons) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(button.callbackId)
        .setLabel(button.label)
        .setStyle(discordButtonStyle(button.label))
    );
  }

  return [row];
}

function createDiscordClient(): DiscordClientLike {
  return new Client({
    intents: [GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });
}

function discordButtonStyle(label: string): ButtonStyle {
  if (label.toLowerCase().includes("deny")) {
    return ButtonStyle.Danger;
  }

  if (label.toLowerCase().includes("trust")) {
    return ButtonStyle.Secondary;
  }

  return ButtonStyle.Primary;
}

function isDiscordDirectMessage(value: unknown): value is DiscordMessageLike {
  if (!isRecord(value) || !isRecord(value.author) || !isRecord(value.channel)) {
    return false;
  }

  return (
    typeof value.author.id === "string" &&
    (value.author.bot === undefined || typeof value.author.bot === "boolean") &&
    (value.author.username === undefined || typeof value.author.username === "string") &&
    (value.author.tag === undefined || typeof value.author.tag === "string") &&
    typeof value.channelId === "string" &&
    typeof value.content === "string" &&
    ((typeof value.channel.isDMBased === "function" && value.channel.isDMBased() === true) ||
      value.channel.type === ChannelType.DM)
  );
}

function isDiscordButtonInteraction(value: unknown): value is DiscordButtonInteractionLike {
  if (!isRecord(value) || !isRecord(value.user)) {
    return false;
  }

  return (
    typeof value.customId === "string" &&
    (typeof value.channelId === "string" || value.channelId === null) &&
    typeof value.user.id === "string" &&
    (value.user.bot === undefined || typeof value.user.bot === "boolean") &&
    typeof value.isButton === "function" &&
    value.isButton() === true &&
    typeof value.deferUpdate === "function"
  );
}

function isDiscordSendableChannel(value: unknown): value is DiscordSendableChannel {
  return isRecord(value) && typeof value.send === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly items: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: item });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ done: false, value: item });
    }

    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
