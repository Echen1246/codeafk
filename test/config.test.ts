import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  findExistingConfigPath,
  getConfigPath,
  getLegacyConfigPath,
  loadConfig,
  parseConfig,
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
      channel: { chat_id: 123456 },
    });
    await expect(findExistingConfigPath(env)).resolves.toBe(legacyConfigPath);
  });
});

describe("config persistence", () => {
  it("round-trips the v0 TOML config and locks down file permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-config-test-"));
    const configPath = join(directory, "config.toml");
    const config: AppConfig = {
      channel: {
        type: "telegram",
        bot_token: "123:abc",
        chat_id: 123456,
      },
      agent: {
        type: "codex",
      },
    };

    await saveConfig(config, configPath);

    await expect(loadConfig(configPath)).resolves.toEqual(config);
    await expect(readFile(configPath, "utf8")).resolves.toContain('[channel]');

    if (process.platform !== "win32") {
      const mode = (await stat(configPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("rejects configs without a telegram chat id", () => {
    expect(() =>
      parseConfig(`
[channel]
type = "telegram"
bot_token = "123:abc"

[agent]
type = "codex"
`)
    ).toThrow("Config channel.chat_id must be an integer");
  });
});
