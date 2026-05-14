import { describe, expect, it } from "vitest";

import { parseInitArgs } from "../src/commands/init.js";

describe("parseInitArgs", () => {
  it("prompts for a channel when none is provided", () => {
    expect(parseInitArgs([])).toBeUndefined();
  });

  it("accepts explicit channel names", () => {
    expect(parseInitArgs(["telegram"])).toBe("telegram");
    expect(parseInitArgs(["discord"])).toBe("discord");
  });

  it("rejects unknown init arguments", () => {
    expect(() => parseInitArgs(["slack"])).toThrow("Usage: afk init [telegram|discord]");
  });
});
