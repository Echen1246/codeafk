import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { getConfigPath, loadConfig, parseConfig, saveConfig, type AppConfig } from "../src/config.js";

describe("config paths", () => {
  it("uses XDG_CONFIG_HOME when present", () => {
    expect(getConfigPath({ XDG_CONFIG_HOME: "/tmp/apgr-config" })).toBe(
      "/tmp/apgr-config/apgr/config.toml"
    );
  });
});

describe("config persistence", () => {
  it("round-trips the v0 TOML config and locks down file permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apgr-config-test-"));
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
