#!/usr/bin/env node
import { initCommand } from "./commands/init.js";
import { resumeCommand } from "./commands/resume.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";

type CommandName = "init" | "start" | "stop" | "resume" | "status";

type Command = {
  name: CommandName;
  description: string;
  run: () => Promise<void> | void;
};

let fatalHandlersInstalled = false;

const commands: Command[] = [
  {
    name: "init",
    description: "Pair AFK with a messaging channel",
    run: initCommand,
  },
  {
    name: "start",
    description: "Start Away Mode in the current workspace",
    run: startCommand,
  },
  {
    name: "stop",
    description: "Stop Away Mode",
    run: stopCommand,
  },
  {
    name: "resume",
    description: "Release the session and print the Codex resume command",
    run: resumeCommand,
  },
  {
    name: "status",
    description: "Show AFK status",
    run: statusCommand,
  },
];

function printHelp(): void {
  console.log(`AFK

Usage:
  afk              Start Away Mode in the current workspace
  afk <command>
  afk --help

Commands:
${commands.map((command) => `  ${command.name.padEnd(8)} ${command.description}`).join("\n")}
`);
}

async function main(args: string[]): Promise<void> {
  const [commandName] = args;

  if (commandName === undefined) {
    await startCommand();
    return;
  }

  if (commandName === "--help" || commandName === "-h") {
    printHelp();
    return;
  }

  const command = commands.find((candidate) => candidate.name === commandName);

  if (command === undefined) {
    console.error(`Unknown command: ${commandName}`);
    console.error("Run `afk --help` to see available commands.");
    process.exitCode = 1;
    return;
  }

  await command.run();
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});

installFatalErrorHandlers();

function installFatalErrorHandlers(): void {
  if (fatalHandlersInstalled) {
    return;
  }

  fatalHandlersInstalled = true;
  process.on("uncaughtException", (error) => {
    console.error(`AFK crashed: ${errorStack(error)}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`AFK crashed: ${errorStack(reason)}`);
    process.exit(1);
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function errorStack(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}
