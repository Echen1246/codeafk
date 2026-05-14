import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Events } from "discord.js";

import {
  DiscordChannel,
  discordBotInviteUrl,
  splitDiscordText,
  toDiscordComponents,
} from "../../src/channel/discord.js";

describe("DiscordChannel", () => {
  it("streams direct messages from the paired user and channel", async () => {
    const client = new FakeDiscordClient();
    const channel = new DiscordChannel({
      botToken: "token",
      userId: "user_1",
      channelId: "dm_1",
      client,
    });

    await channel.start();
    const iterator = channel.events()[Symbol.asyncIterator]();
    client.emit(
      Events.MessageCreate,
      discordMessage({ userId: "user_1", channelId: "dm_1", content: "run tests" })
    );

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "message", text: "run tests", fromUserId: "user_1" },
    });
    await channel.stop();
  });

  it("ignores unpaired direct messages", async () => {
    const client = new FakeDiscordClient();
    const channel = new DiscordChannel({
      botToken: "token",
      userId: "user_1",
      channelId: "dm_1",
      client,
    });

    await channel.start();
    client.emit(
      Events.MessageCreate,
      discordMessage({ userId: "other", channelId: "dm_1", content: "run tests" })
    );
    await channel.stop();

    await expect(channel.events()[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("returns the first direct message for pairing", async () => {
    const client = new FakeDiscordClient();
    const channel = new DiscordChannel({ botToken: "token", client });

    await channel.start();
    client.emit(
      Events.MessageCreate,
      discordMessage({ userId: "user_1", channelId: "dm_1", content: "pair" })
    );

    await expect(channel.waitForPairingMessage()).resolves.toEqual({
      userId: "user_1",
      channelId: "dm_1",
      username: "user_1",
      tag: "user_1#0000",
    });
    await channel.stop();
  });

  it("streams button interactions from the paired user and acknowledges them", async () => {
    const client = new FakeDiscordClient();
    const interaction = new FakeButtonInteraction("afk:1");
    const channel = new DiscordChannel({
      botToken: "token",
      userId: "user_1",
      channelId: "dm_1",
      client,
    });

    await channel.start();
    const iterator = channel.events()[Symbol.asyncIterator]();
    client.emit(Events.InteractionCreate, interaction);

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "button_press", callbackId: "afk:1", fromUserId: "user_1" },
    });
    expect(interaction.deferred).toBe(true);
    await channel.stop();
  });

  it("sends messages, buttons, and attachments to the paired DM", async () => {
    const client = new FakeDiscordClient();
    const channel = new DiscordChannel({
      botToken: "token",
      userId: "user_1",
      channelId: "dm_1",
      client,
    });

    await channel.start();
    await channel.send({
      text: "Approve command?",
      buttons: [
        { label: "Approve", callbackId: "afk:1" },
        { label: "Approve & Trust", callbackId: "afk:2" },
        { label: "Deny", callbackId: "afk:3" },
      ],
      attachments: [
        {
          filename: "turn.diff",
          content: Buffer.from("+hello"),
          mimeType: "text/x-diff",
        },
      ],
    });

    expect(client.sentMessages).toHaveLength(2);
    expect(client.sentMessages[0]?.content).toBe("Approve command?");
    expect(client.sentMessages[0]?.components).toHaveLength(1);
    expect(client.sentMessages[1]?.files).toHaveLength(1);
    await channel.stop();
  });
});

describe("Discord helpers", () => {
  it("builds a bot install URL", () => {
    expect(discordBotInviteUrl("123")).toBe(
      "https://discord.com/oauth2/authorize?client_id=123&scope=bot&permissions=0"
    );
  });

  it("splits long Discord messages", () => {
    expect(splitDiscordText("a".repeat(1901))).toEqual(["a".repeat(1900), "a"]);
  });

  it("maps AFK approval buttons to Discord components", () => {
    const components = toDiscordComponents([
      { label: "Approve", callbackId: "afk:1" },
      { label: "Approve & Trust", callbackId: "afk:2" },
      { label: "Deny", callbackId: "afk:3" },
    ]);

    expect(JSON.stringify(components[0]?.toJSON())).toContain("afk:2");
  });
});

class FakeDiscordClient extends EventEmitter {
  readonly sentMessages: unknown[] = [];
  user = { id: "bot_1", username: "afkbot", tag: "afkbot#0000" };
  channels = {
    fetch: async (channelId: string): Promise<FakeSendableChannel | null> =>
      channelId === "dm_1" ? new FakeSendableChannel(this.sentMessages) : null,
  };

  async login(_token: string): Promise<string> {
    this.emit(Events.ClientReady);
    return "token";
  }

  destroy(): void {
    return;
  }
}

class FakeSendableChannel {
  constructor(private readonly sentMessages: unknown[]) {}

  async send(options: unknown): Promise<void> {
    this.sentMessages.push(options);
  }
}

class FakeButtonInteraction {
  readonly channelId = "dm_1";
  readonly user = { id: "user_1" };
  deferred = false;

  constructor(readonly customId: string) {}

  isButton(): boolean {
    return true;
  }

  async deferUpdate(): Promise<void> {
    this.deferred = true;
  }
}

function discordMessage(options: {
  userId: string;
  channelId: string;
  content: string;
}): unknown {
  return {
    author: {
      id: options.userId,
      username: options.userId,
      tag: `${options.userId}#0000`,
    },
    channelId: options.channelId,
    content: options.content,
    channel: {
      isDMBased: () => true,
    },
  };
}
