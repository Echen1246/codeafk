# AFK

AFK lets you keep working with Codex from your phone.

Start `afk` on your laptop, leave it running, and send prompts from Telegram while you are away. AFK forwards your messages to Codex, sends Codex replies back to Telegram, shows approval buttons when Codex asks to run a command, and gives you a diff when a turn finishes.

It is small on purpose: Codex, Telegram, and your laptop. No hosted relay, dashboard, accounts, analytics, or cloud sync.

AFK is experimental. It depends on Codex app-server behavior, which may change.

## When To Use It

- You are leaving your desk but want Codex to keep working.
- You want to answer Codex questions from your phone.
- You want to approve or deny shell commands while away.
- You want a quick phone-readable diff before you get back.
- You want to resume the same Codex thread on your laptop later.

AFK does not run Codex on your phone. Codex still runs on your laptop. Telegram is just the remote control.

## Requirements

- Node.js 20 or newer
- Codex installed with `codex app-server` support
- A Telegram account
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

macOS is the best-supported platform in v0 because AFK runs `caffeinate -dimsu` while Away Mode is active. Other desktop platforms can run the CLI, but v0 does not keep them awake automatically.

## Install

From npm:

```bash
npm install -g codeafk
afk --help
```

From a local checkout:

```bash
pnpm install
pnpm build
npm link
afk --help
```

## First-Time Setup

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Create a bot with `/newbot`.
3. Copy the bot token.
4. Run:

   ```bash
   afk init
   ```

5. Paste the bot token.
6. Send any Telegram message to your new bot.
7. Confirm the pairing in your terminal.

AFK saves the token on your laptop at `~/.config/afk/config.toml` with owner-only file permissions.

## Daily Workflow

Start AFK from the repo you want Codex to work in:

```bash
cd /path/to/your/project
afk
```

Keep that terminal open. It is the AFK process.

For remote sessions, AFK starts Codex with `approval_policy="on-request"` by default. This is intentional: phone control should not silently inherit a local Codex config that runs commands without asking. If you want AFK to use your existing Codex approval settings, start it explicitly:

```bash
afk --accept-agent-config
```

In Telegram:

```text
You:
/sessions

AFK:
Recent projects:

[1] myapp - /Users/you/projects/myapp (6 sessions)
[2] docs-site - /Users/you/projects/docs-site (3 sessions)

Reply with a number.
```

Choose a project, then choose a recent Codex session or reply `new`.

```text
AFK:
Recent sessions in myapp:

[1] today, 14m - "fix the failing auth callback test" (47 msg)
[2] today, 2h - "add tests for the expired-state case" (23 msg)
[3] yesterday - "refactor OAuth state validation" (89 msg)

Reply with a number, or "new" for a new session.
```

Now text the bot like you would text Codex:

```text
You:
look at the failing test and propose a fix

AFK:
Sent to Codex.

Codex:
I found the failing assertion...
```

If Codex asks to run a command, AFK shows Telegram buttons:

```text
AFK:
Codex needs to run:
pnpm test

[Approve] [Deny]
```

When Codex finishes, AFK sends a short summary and two diff attachments:

```text
AFK:
Codex finished.
Changed: README.md (+1 -0)

Attachments:
turn_abc123.html
turn_abc123.diff
```

The `.html` file is easier to read on a phone. The `.diff` file is the raw unified diff.

## Coming Back To Your Laptop

Press `Ctrl+C` in the terminal running `afk`.

AFK stops and prints:

```bash
codex resume <thread-id>
```

Run that command to continue the same Codex thread locally.

If you stopped AFK from another terminal, run this to print the same resume command:

```bash
afk resume
```

If an already-open Codex window looks stale, reopen or resume the thread. Codex may not live-refresh updates that happened while AFK was driving the session.

## Commands

```text
afk          Start Away Mode in the current workspace
afk init     Pair AFK with Telegram
afk start    Same as afk
afk stop     Stop Away Mode from another terminal
afk resume   Stop Away Mode and print the Codex resume command
afk status   Show current AFK status
```

Start option:

```text
--accept-agent-config  Use your Codex approval settings instead of AFK's remote-safe default
```

## What AFK Stores

AFK stores local config and local state only:

- Config: `~/.config/afk/config.toml`
- Last thread state: `~/.local/state/afk/last-thread.json`
- Diff snapshots: `~/.local/state/afk/diffs/<turnId>.diff`

Your Telegram bot token stays on your machine. AFK does not send code, repo contents, diffs, logs, or telemetry anywhere except the Telegram chat you paired.

During the rename from `apgr`, AFK also reads old config/state from `~/.config/apgr` and `~/.local/state/apgr` so existing local pairings keep working.

## Troubleshooting

If `afk` cannot find Codex, confirm `codex` works in the same terminal:

```bash
codex --version
```

If Telegram stops responding, check that your laptop is awake, online, and still running `afk`.

If approval buttons do not appear, Codex may already be allowed to run that command by your local Codex settings. AFK only shows buttons when Codex asks for approval.

If the phone session does not appear in an already-open Codex window, run the printed `codex resume <thread-id>` command.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:dry-run
```

Local Codex smoke test:

```bash
pnpm tsx src/dev/local-loop.ts "list files in this directory"
```

Dead-code check:

```bash
XDG_CACHE_HOME=/private/tmp/afk-cache pnpm dlx knip
```
