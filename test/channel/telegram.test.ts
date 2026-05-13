import { describe, expect, it } from "vitest";

import {
  describeTelegramUser,
  nextTelegramOffset,
  splitTelegramText,
  TelegramChannel,
} from "../../src/channel/telegram.js";

describe("TelegramChannel", () => {
  it("polls message updates with offset and timeout", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const channel = new TelegramChannel({
      botToken: "token",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });

        return jsonResponse({
          ok: true,
          result: [
            {
              update_id: 42,
              message: {
                chat: { id: 123 },
                from: { id: 456, username: "eddie" },
                text: "pair me",
              },
            },
          ],
        });
      },
    });

    await expect(channel.getUpdates({ offset: 40, timeoutSeconds: 30 })).resolves.toEqual([
      {
        updateId: 42,
        chatId: 123,
        from: { id: 456, username: "eddie" },
        text: "pair me",
      },
    ]);
    expect(requests).toEqual([
      {
        url: "https://api.telegram.org/bottoken/getUpdates",
        body: {
          offset: 40,
          timeout: 30,
          allowed_updates: ["message"],
        },
      },
    ]);
  });

  it("surfaces Telegram API errors", async () => {
    const channel = new TelegramChannel({
      botToken: "bad-token",
      fetch: async () =>
        jsonResponse({
          ok: false,
          description: "Unauthorized",
        }),
    });

    await expect(channel.getMe()).rejects.toThrow("Telegram getMe failed: Unauthorized");
  });

  it("streams messages from the paired chat only", async () => {
    const responses = [
      {
        ok: true,
        result: [{ update_id: 1, message: { chat: { id: 999 }, text: "old" } }],
      },
      {
        ok: true,
        result: [
          { update_id: 2, message: { chat: { id: 999 }, text: "drop" } },
          {
            update_id: 3,
            message: {
              chat: { id: 123 },
              from: { id: 456 },
              text: "send to codex",
            },
          },
        ],
      },
    ];
    const channel = new TelegramChannel({
      botToken: "token",
      chatId: 123,
      fetch: async () => jsonResponse(responses.shift()),
    });

    await channel.start();
    const iterator = channel.events()[Symbol.asyncIterator]();
    const event = await iterator.next();
    await channel.stop();

    expect(event).toEqual({
      done: false,
      value: { type: "message", text: "send to codex", fromUserId: "456" },
    });
  });
});

describe("Telegram helpers", () => {
  it("computes the next update offset", () => {
    expect(
      nextTelegramOffset([
        { updateId: 10, chatId: 1 },
        { updateId: 12, chatId: 1 },
      ])
    ).toBe(13);
  });

  it("prefers usernames in user descriptions", () => {
    expect(describeTelegramUser({ id: 1, username: "ayocheddie" }, 123)).toBe("@ayocheddie");
  });

  it("splits long Telegram messages with headroom under the API limit", () => {
    const chunks = splitTelegramText("x".repeat(4001));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4000);
    expect(chunks[1]).toHaveLength(1);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
  });
}
