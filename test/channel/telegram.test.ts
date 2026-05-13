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
                from: { id: 456, username: "user" },
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
        type: "message",
        chatId: 123,
        from: { id: 456, username: "user" },
        text: "pair me",
      },
    ]);
    expect(requests).toEqual([
      {
        url: "https://api.telegram.org/bottoken/getUpdates",
        body: {
          offset: 40,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
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

  it("retries polling after transient Telegram failures", async () => {
    const sleeps: number[] = [];
    const connectionStates: string[] = [];
    const responses: Array<Error | unknown> = [
      { ok: true, result: [] },
      new Error("network offline"),
      {
        ok: true,
        result: [
          {
            update_id: 3,
            message: {
              chat: { id: 123 },
              from: { id: 456 },
              text: "back online",
            },
          },
        ],
      },
    ];
    const channel = new TelegramChannel({
      botToken: "token",
      chatId: 123,
      fetch: async () => {
        const response = responses.shift();
        if (response instanceof Error) {
          throw response;
        }

        return jsonResponse(response);
      },
      onConnectionStateChange: (status, error) => {
        connectionStates.push(error === undefined ? status : `${status}: ${error.message}`);
      },
      retryDelaysMs: [25],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await channel.start();
    const iterator = channel.events()[Symbol.asyncIterator]();
    const event = await iterator.next();
    await channel.stop();

    expect(event).toEqual({
      done: false,
      value: { type: "message", text: "back online", fromUserId: "456" },
    });
    expect(sleeps).toEqual([25]);
    expect(connectionStates).toEqual([
      "connected",
      "disconnected: network offline",
      "connected",
    ]);
  });

  it("sends inline keyboard buttons", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const channel = new TelegramChannel({
      botToken: "token",
      chatId: 123,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return jsonResponse({ ok: true, result: {} });
      },
    });

    await channel.send({
      text: "Approve command?",
      buttons: [
        { label: "Approve", callbackId: "afk:1" },
        { label: "Deny", callbackId: "afk:2" },
      ],
    });

    expect(requests).toEqual([
      {
        url: "https://api.telegram.org/bottoken/sendMessage",
        body: {
          chat_id: 123,
          text: "Approve command?",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Approve", callback_data: "afk:1" },
                { text: "Deny", callback_data: "afk:2" },
              ],
            ],
          },
        },
      },
    ]);
  });

  it("sends attachments as Telegram documents", async () => {
    const requests: Array<{ url: string; body: BodyInit | null | undefined }> = [];
    const channel = new TelegramChannel({
      botToken: "token",
      chatId: 123,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          body: init?.body,
        });
        return jsonResponse({ ok: true, result: {} });
      },
    });

    await channel.send({
      text: "Codex finished.",
      attachments: [
        {
          filename: "turn_1.diff",
          content: Buffer.from("diff --git a/README.md b/README.md\n"),
          mimeType: "text/x-diff",
        },
      ],
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://api.telegram.org/bottoken/sendMessage");
    expect(requests[1]?.url).toBe("https://api.telegram.org/bottoken/sendDocument");
    expect(requests[1]?.body).toBeInstanceOf(FormData);

    const body = requests[1]?.body as FormData;
    expect(body.get("chat_id")).toBe("123");

    const document = body.get("document");
    expect(document).toBeInstanceOf(File);
    expect((document as File).name).toBe("turn_1.diff");
    await expect((document as File).text()).resolves.toBe(
      "diff --git a/README.md b/README.md\n"
    );
  });

  it("streams callback queries from the paired chat", async () => {
    const requests: string[] = [];
    const responses = [
      { ok: true, result: [] },
      {
        ok: true,
        result: [
          {
            update_id: 10,
            callback_query: {
              id: "cbq_1",
              from: { id: 456 },
              message: { chat: { id: 123 } },
              data: "afk:1",
            },
          },
        ],
      },
      { ok: true, result: true },
    ];
    const channel = new TelegramChannel({
      botToken: "token",
      chatId: 123,
      fetch: async (input) => {
        requests.push(String(input));
        return jsonResponse(responses.shift());
      },
    });

    await channel.start();
    const iterator = channel.events()[Symbol.asyncIterator]();
    const event = await iterator.next();
    await channel.stop();

    expect(event).toEqual({
      done: false,
      value: { type: "button_press", callbackId: "afk:1", fromUserId: "456" },
    });
    expect(requests.at(-1)).toBe("https://api.telegram.org/bottoken/answerCallbackQuery");
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
    expect(describeTelegramUser({ id: 1, username: "afkuser" }, 123)).toBe("@afkuser");
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
