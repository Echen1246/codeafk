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
  run: () => void;
};

const commands: Command[] = [
  {
    name: "init",
    description: "Pair Agent Pager with a messaging channel",
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
    description: "Show Agent Pager status",
    run: statusCommand,
  },
];

function printHelp(): void {
  console.log(`Agent Pager

Usage:
  apgr <command>
  apgr --help

Commands:
${commands.map((command) => `  ${command.name.padEnd(8)} ${command.description}`).join("\n")}
`);
}

function main(args: string[]): void {
  const [commandName] = args;

  if (commandName === undefined || commandName === "--help" || commandName === "-h") {
    printHelp();
    return;
  }

  const command = commands.find((candidate) => candidate.name === commandName);

  if (command === undefined) {
    console.error(`Unknown command: ${commandName}`);
    console.error("Run `apgr --help` to see available commands.");
    process.exitCode = 1;
    return;
  }

  command.run();
}

main(process.argv.slice(2));
