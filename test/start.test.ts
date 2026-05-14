import { describe, expect, it } from "vitest";

import { parseStartArgs } from "../src/commands/start.js";

describe("parseStartArgs", () => {
  it("uses AFK's remote-safe approval default unless told otherwise", () => {
    expect(parseStartArgs([])).toEqual({ acceptAgentConfig: false });
  });

  it("accepts the explicit Codex config escape hatch", () => {
    expect(parseStartArgs(["--accept-agent-config"])).toEqual({ acceptAgentConfig: true });
  });

  it("accepts an explicit channel", () => {
    expect(parseStartArgs(["telegram"])).toEqual({
      acceptAgentConfig: false,
      channelType: "telegram",
    });
    expect(parseStartArgs(["--channel", "discord"])).toEqual({
      acceptAgentConfig: false,
      channelType: "discord",
    });
    expect(parseStartArgs(["--channel=telegram"])).toEqual({
      acceptAgentConfig: false,
      channelType: "telegram",
    });
  });

  it("rejects unknown start options", () => {
    expect(() => parseStartArgs(["--approval-policy=never"])).toThrow(
      "Unknown start option: --approval-policy=never"
    );
  });
});
