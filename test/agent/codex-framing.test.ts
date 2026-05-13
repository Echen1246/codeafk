import { describe, expect, it } from "vitest";

import {
  encodeJsonRpcMessage,
  JsonRpcLineParser,
  parseCodexCliVersion,
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
