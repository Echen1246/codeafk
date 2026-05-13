#!/usr/bin/env node
import { CodexAdapter } from "../agent/codex.js";

const prompt = process.argv.slice(2).join(" ").trim();

if (prompt.length === 0) {
  console.error('Usage: pnpm tsx src/dev/local-loop.ts "list files in this directory"');
  process.exit(1);
}

const adapter = new CodexAdapter();

try {
  const session = await adapter.startSession({
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "read-only",
  });

  const events = adapter.streamEvents(session.sessionId);
  await adapter.sendMessage(session.sessionId, prompt);

  for await (const event of events) {
    if (event.type === "message_delta") {
      process.stdout.write(event.text);
    }

    if (event.type === "error") {
      console.error(`\nCodex error: ${event.summary}`);
    }

    if (event.type === "turn_complete") {
      process.stdout.write(`\n\nTurn ${event.status} (${event.turnId})\n`);
      break;
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`AFK local loop failed:\n${message}`);
  process.exitCode = 1;
} finally {
  await adapter.dispose();
}
