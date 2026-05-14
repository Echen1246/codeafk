import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  configuredChannelTypes,
  findExistingConfigPath,
  getConfigPath,
  getLegacyConfigPath,
  loadConfig,
  parseConfig,
  resolveChannelConfig,
  saveConfig,
  type AppConfig,
} from "../src/config.js";

describe("config paths", () => {
  it("uses XDG_CONFIG_HOME when present", () => {
    expect(getConfigPath({ XDG_CONFIG_HOME: "/tmp/afk-config" })).toBe(
      "/tmp/afk-config/afk/config.toml"
    );
  });

  it("can read the legacy apgr config path during the rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-config-test-"));
    const env = { XDG_CONFIG_HOME: directory };
    const legacyConfigPath = getLegacyConfigPath(env);
    await mkdir(join(directory, "apgr"), { recursive: true });
    await writeFile(
      legacyConfigPath,
      [
        "[channel]",
        'type = "telegram"',
        'bot_token = "123:abc"',
        "chat_id = 123456",
        "",
        "[agent]",
        'type = "codex"',
        "",
      ].join("\n")
    );

    await expect(loadConfig(getConfigPath(env))).resolves.toMatchObject({
      default_channel: "telegram",
      channels: {
        telegram: { chat_id: 123456 },
      },
    });
    await expect(findExistingConfigPath(env)).resolves.toBe(legacyConfigPath);
  });
});

describe("config persistence", () => {
  it("round-trips the multi-channel TOML config and locks down file permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-config-test-"));
    const configPath = join(directory, "config.toml");
    const config: AppConfig = {
      default_channel: "telegram",
      channels: {
        telegram: {
          bot_token: "123:abc",
          chat_id: 123456,
        },
      },
      agent: {
        type: "codex",
      },
    };

    await saveConfig(config, configPath);

    await expect(loadConfig(configPath)).resolves.toEqual(config);
    await expect(readFile(configPath, "utf8")).resolves.toContain('[channels.telegram]');

    if (process.platform !== "win32") {
      const mode = (await stat(configPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("rejects configs without a telegram chat id", () => {
    expect(() =>
      parseConfig(`
[channels.telegram]
bot_token = "123:abc"

[agent]
type = "codex"
`)
    ).toThrow("Config channels.telegram.chat_id must be an integer");
  });

  it("resolves configured channels by default or explicit selection", () => {
    const config: AppConfig = {
      default_channel: "telegram",
      channels: {
        telegram: {
          bot_token: "123:abc",
          chat_id: 123456,
        },
        discord: {
          bot_token: "discord-token",
          user_id: "user-1",
          channel_id: "channel-1",
        },
      },
      agent: {
        type: "codex",
      },
    };

    expect(configuredChannelTypes(config)).toEqual(["telegram", "discord"]);
    expect(resolveChannelConfig(config)).toMatchObject({ type: "telegram" });
    expect(resolveChannelConfig(config, "discord")).toMatchObject({ type: "discord" });
  });
});
