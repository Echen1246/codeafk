# AFK

AFK lets you leave Codex running on your laptop and keep working from Telegram. Send prompts from your phone, approve shell commands with buttons, get Codex's replies, review the final HTML/raw diff, then resume the same Codex thread when you are back at your desk.

This is experimental. The Codex app-server protocol is still moving, and v0 is intentionally small: Codex only, Telegram only, no hosted relay, no web dashboard, no accounts.

## What Works In v0

- `afk init` pairs a Telegram bot with your laptop.
- `afk` starts Away Mode, keeps your Mac awake, and lets you pick a recent project/session from Telegram.
- `afk start` is the explicit form of the same start command.
- Telegram messages become Codex prompts.
- Telegram messages sent while Codex is working steer the active Codex turn.
- Resumed sessions send a short recent-context catch-up into Telegram.
- Codex replies are sent back to Telegram.
- Shell command approvals show up as inline Approve and Deny buttons.
- Completed turns send a changed-file summary, phone-friendly `.html` diff, and raw `.diff` attachment.
- `afk status` shows the current thread, daemon state, Codex state, channel state, and uptime.
- `afk resume` stops Away Mode and prints the `codex resume <thread-id>` command.

## Requirements

- macOS or another Node-supported desktop environment
- Node.js 20 or newer
- Codex installed with `codex app-server` support
- A Telegram account
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

For local development, this repo uses pnpm 10.

## Install

Once v0.1.0 is published:

```bash
npm install -g codeafk
```

From a local checkout:

```bash
pnpm install
pnpm build
npm link
```

Confirm the CLI is available:

```bash
afk --help
```

## Quick Start

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather), then copy the bot token.
2. Pair AFK:

   ```bash
   afk init
   ```

3. Paste the token when prompted.
4. Send any message to your bot from Telegram.
5. Confirm the pairing prompt in your terminal.
6. Start Away Mode from the repo you want Codex to work in:

   ```bash
   cd /path/to/your/project
   afk
   ```

7. In Telegram, send `/sessions`.
8. Choose a project.
9. Choose a recent Codex session, or reply `new` to start a new one.
10. Text your bot from your phone.
11. When you are back at your desk, press `Ctrl+C` in the terminal running `afk`. AFK prints the Codex command for continuing locally:

   ```bash
   codex resume <thread-id>
   ```

   If you stopped AFK from another terminal, run `afk resume` there to print the same command.

   If an already-open Codex window still looks stale, reopen or resume the thread. Codex may not live-refresh updates written by AFK while Away Mode was active.

## Telegram Flow

The v0 UI is plain Telegram messages and inline buttons:

```text
You:
/sessions

AFK:
Recent projects:

[1] codeafk - /Users/eddie/Documents/codeafk (6 sessions)
[2] myapp - /Users/eddie/Documents/myapp (3 sessions)

Reply with a number.

You:
2

AFK:
Recent sessions in myapp:

[1] today, 14m - "fix the failing auth callback test" (47 msg)
[2] today, 2h - "add tests for the expired-state case" (23 msg)
[3] yesterday - "refactor the OAuth state validation" (89 msg)

Reply with a number, or "new" for a new session.

You:
1

AFK:
Resumed thr_ghi789. What would you like to do?

You:
look at the failing test and propose a fix

Codex:
I found the failing assertion. The parser returns an empty path for /dev/null...

AFK:
Codex needs to run:
pnpm test

[Approve] [Deny]

AFK:
Codex finished.
Changed: README.md (+1 -0)

Attachment:
turn_abc123.html
turn_abc123.diff
```

AFK sends both a phone-friendly `.html` diff and the raw `.diff`. In the raw diff, a line starting with `+` was added, a line starting with `-` was removed, and unchanged lines are shown for context.

## Commands

```text
afk          Start Away Mode in the current workspace
afk init     Pair AFK with Telegram
afk start    Start Away Mode and choose a project/session from Telegram
afk stop     Stop Away Mode
afk resume   Release the session and print the Codex resume command
afk status   Show AFK status
```

## Files On Disk

AFK stores only local config and local state:

- Config: `~/.config/afk/config.toml`
- Last thread state: `~/.local/state/afk/last-thread.json`
- Diff snapshots: `~/.local/state/afk/diffs/<turnId>.diff`

During the rename from `apgr`, AFK also reads existing config/state from the old `~/.config/apgr` and `~/.local/state/apgr` paths so existing pairings keep working.

Config files are written with owner-only permissions. Bot tokens stay on your machine.

## Security Model

AFK does not run a hosted service. Your laptop talks directly to Telegram's Bot API and the local Codex app-server process.

No code, repo contents, diffs, logs, or telemetry are sent anywhere except the messaging channel you configured. For v0, that means Telegram. The project deliberately avoids a web UI, cloud relay, account system, analytics, and third-party crash reporting.

Shell approvals are surfaced to Telegram because Codex asks for them. AFK does not add a separate file-change approval layer in v0.

## Architecture

```text
Telegram bot API
      ^
      |
TelegramChannel
      ^
      |
Orchestrator
      |
      v
CodexAdapter
      |
      v
codex app-server
```

The adapter turns Codex app-server events into internal `AgentEvent`s. The orchestrator decides how to render those events into Telegram messages, buttons, and file attachments.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
XDG_CACHE_HOME=/private/tmp/afk-cache pnpm dlx knip
```

Local Codex smoke test:

```bash
pnpm tsx src/dev/local-loop.ts "list files in this directory"
```

Package dry run:

```bash
pnpm pack:dry-run
```

## Roadmap

- v0: Codex + Telegram, shell approvals, HTML and raw `.diff` attachments.
- v0.5: Discord, file-change approval flow, richer diff rendering.
- v1: VS Code extension that also works in Cursor.
- v2: More CLI coding agents.
- v3: Cursor SDK adapter when the right integration surface exists.

See [SPEC.md](./SPEC.md) for the full product document.
