import { describe, expect, it } from "vitest";

import {
  buildCodexAppServerArgs,
  encodeJsonRpcMessage,
  getDiffDirectory,
  JsonRpcLineParser,
  parseCodexCliVersion,
  summarizeUnifiedDiff,
} from "../../src/agent/codex.js";

describe("JSON-RPC line framing", () => {
  it("encodes one message per line", () => {
    const encoded = encodeJsonRpcMessage({
      id: 1,
      method: "initialize",
      params: { ok: true },
    });

    expect(encoded).toBe('{"id":1,"method":"initialize","params":{"ok":true}}\n');
  });

  it("buffers partial chunks until a newline arrives", () => {
    const parser = new JsonRpcLineParser();

    expect(parser.push('{"id":1')).toEqual([]);
    expect(parser.push(',"result":{"threadId":"thr_123"}}\n')).toEqual([
      { id: 1, result: { threadId: "thr_123" } },
    ]);
  });

  it("parses multiple messages from one chunk", () => {
    const parser = new JsonRpcLineParser();

    expect(parser.push('{"method":"turn/started","params":{}}\n{"id":2,"result":{}}\n')).toEqual([
      { method: "turn/started", params: {} },
      { id: 2, result: {} },
    ]);
  });

  it("rejects non-object JSON-RPC lines", () => {
    const parser = new JsonRpcLineParser();

    expect(() => parser.push("[]\n")).toThrow("JSON-RPC line must decode to an object");
  });
});

describe("Codex CLI version parsing", () => {
  it("extracts the codex-cli version from mixed command output", () => {
    const output = [
      "WARNING: proceeding, even though we could not update PATH",
      "codex-cli 0.130.0-alpha.5",
    ].join("\n");

    expect(parseCodexCliVersion(output)).toBe("0.130.0-alpha.5");
  });
});

describe("Codex app-server args", () => {
  it("forces remote sessions into approval ask-mode by default", () => {
    expect(buildCodexAppServerArgs()).toEqual([
      "app-server",
      "-c",
      'approval_policy="on-request"',
      "--listen",
      "stdio://",
    ]);
  });

  it("can explicitly inherit the user's Codex approval config", () => {
    expect(buildCodexAppServerArgs({ acceptAgentConfig: true })).toEqual([
      "app-server",
      "--listen",
      "stdio://",
    ]);
  });
});

describe("Codex diff helpers", () => {
  it("uses XDG_STATE_HOME for diff snapshots when present", () => {
    expect(getDiffDirectory({ XDG_STATE_HOME: "/tmp/afk-state" })).toBe(
      "/tmp/afk-state/afk/diffs"
    );
  });

  it("summarizes changed files and line stats from unified diffs", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,2 +1,3 @@",
      " AFK",
      "-old line",
      "+new line",
      "+hello world",
      "diff --git a/src/cli.ts b/src/cli.ts",
      "--- a/src/cli.ts",
      "+++ b/src/cli.ts",
      "@@ -1 +1 @@",
      "-console.log('old')",
      "+console.log('new')",
    ].join("\n");

    expect(summarizeUnifiedDiff(diff)).toEqual({
      changedFiles: ["README.md", "src/cli.ts"],
      stats: {
        files: 2,
        additions: 3,
        deletions: 2,
      },
    });
  });
});
