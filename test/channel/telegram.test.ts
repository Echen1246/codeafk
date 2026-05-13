import { describe, expect, it } from "vitest";

import {
  describeTelegramUser,
  nextTelegramOffset,
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
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
  });
}
