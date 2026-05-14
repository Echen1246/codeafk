# Codex Setup

CodeAFK drives Codex through `codex app-server`.

## Check Codex

Make sure Codex works in the same terminal where you run AFK:

```bash
codex --version
codex app-server --help
```

If either command fails, fix your Codex install before starting AFK.

## How AFK Starts Codex

AFK starts `codex app-server` for you. You do not need to run it manually.

Remote sessions use Codex `approval_policy="untrusted"` by default. That gives you approval buttons on Telegram or Discord when Codex asks to run a command or make a change that needs permission.

If you want AFK to use your existing Codex approval settings instead:

```bash
afk --accept-agent-config
```

## Sessions

From Telegram or Discord, send:

```text
/sessions
```

Pick a project first, then pick a recent Codex session or reply `new`.

When AFK stops, it prints:

```bash
codex resume <thread-id>
```

Run that command to continue the same thread locally.

## Known Issues

Codex app-server is experimental, so behavior may change between Codex releases.

An already-open Codex GUI window may not live-update while AFK is driving a session from your phone. If the chat looks stale, quit and reopen Codex, or run the printed `codex resume <thread-id>` command.

Your phone cannot start AFK if AFK is not already running on the laptop. The laptop still needs to be awake, online, and running the AFK process.

Start AFK from the repo you want Codex to work in. Starting it from a broad folder like your home directory can expose more files than you meant to expose.

On macOS, AFK starts `caffeinate -dimsu` while it runs. Closed-lid behavior still depends on your Mac, power, network, and sleep settings.
