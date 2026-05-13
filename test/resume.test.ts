import { describe, expect, it } from "vitest";

import { formatResumeInstructions } from "../src/commands/resume.js";

describe("formatResumeInstructions", () => {
  it("prints the Codex resume command and stale-window note", () => {
    expect(formatResumeInstructions("thr_123")).toBe(
      [
        "Away Mode stopped.",
        "",
        "To continue this thread in your terminal:",
        "  codex resume thr_123",
        "",
        "Note: an already-open Codex window may not live-refresh phone updates. Reopen or resume the thread to view the phone-session transcript.",
      ].join("\n")
    );
  });
});
