<img width="600" height="150" alt="afkcodedesk-ezgif com-resize" src="https://github.com/user-attachments/assets/f8e50fbf-1dc4-4e5e-9d94-3cb7f641ee3e" />

## Keep your coding agent working while you're away from your keyboard

Need to shower? Grab groceries? Go workout? Walk back from campus? Not without agentmaxxing you aren't.

Enter `afk` on your laptop, leave your desk/shut the lid (auto-caffeinated), and talk to Codex from your phone through Telegram or Discord. You can send prompts, approve commands, trust approvals for the session, view diffs, and come back to the same Codex thread when you reopen your laptop.

CodeAFK is intentionally small: your laptop, Codex, and a chat app. There is no hosted relay, web dashboard, account system, login, or cloud sync. Just keep your laptop and phone online.

## Supported platforms

Communicate through:

- Telegram
- Discord

Code with:

- Codex

*Star the project to stay up-to-date on future platform updates! In development: Cursor*

## Why Use CodeAFK?

Use CodeAFK when Codex is already working and you need to leave your desk.

- Keep steering a task from your phone or send a completely new prompt.
- Approve or deny shell commands remotely.
- Use `Approve & Trust` to reduce repeated prompts for the current session.
- Read summaries and phone-friendly diffs when Codex finishes a turn.
- Resume the same Codex thread when you get back for seamless real-world environment switching.

FYI: This is not a mobile IDE. It is a remote control for the Codex session on your own laptop.

## Install

For normal use, install CodeAFK globally:

```bash
npm install -g codeafk
```

That makes `afk` available from any project on your laptop.

```bash
cd /path/to/your/project
afk
```

You can also install it inside one project:

```bash
npm install codeafk
npx afk
```

A local install only gives that one project a copy. In that project, run it with `npx afk`.

## First-Time Setup

Pick the chat app you want to use:

- [Telegram setup](./TELEGRAM.md)
- [Discord setup](./DISCORD.md)

Codex setup notes are here:

- [Codex setup and known issues](./CODEX.md)

After setup, enter 'afk' from the repo you want Codex to work in:

```bash
cd /path/to/your/project
afk
```

If you configured both Telegram and Discord, choose one:

```bash
afk telegram
afk discord
```

## Daily Flow

1. Run `afk` from your project folder and pre-select Telegram or Discord.
2. Shut your laptop (stays awake) or leave your desk.
3. While away, on your phone, send `/sessions` in your chat of choice.
4. Pick a project.
5. Pick an existing Codex chat session, or reply `new`.
6. Text the bot like you would text Codex.
7. Approve, trust, or deny commands when Codex asks.
8. All code changes are sent to your phone as .html and .diff files for review.
9. Press `Ctrl+C` when you are back at your laptop.

AFK prints a `codex resume <thread-id>` command when it stops. Run that to continue the same thread locally.

## Sleep Behavior

On macOS, AFK starts `caffeinate -dimsu` while it is running. That helps keep the laptop awake during Away Mode.

Closed-lid behavior still depends on your Mac, power, network, and sleep settings. Test your own setup before relying on it for a long errand.

## Commands

```text
afk                  Start Away Mode in the current workspace
afk telegram         Start Away Mode with Telegram
afk discord          Start Away Mode with Discord
afk init             Pair AFK with a channel
afk init telegram    Pair Telegram
afk init discord     Pair Discord
afk stop             Stop Away Mode from another terminal
afk resume           Stop Away Mode and print the Codex resume command
afk status           Show current AFK status
```

## Security

Remote sessions use Codex `approval_policy="untrusted"` by default. AFK shows approval buttons when Codex asks to run something outside its trusted set.

To use your existing Codex approval settings instead:

```bash
afk --accept-agent-config
```

AFK stores pairing data locally at `~/.config/afk/config.toml`. Bot tokens stay on your machine.

## Development

```bash
pnpm install
pnpm check
pnpm build
pnpm pack:dry-run
```
Give codeafk a try! Feedback welcome.

Do NOT use afk while driving.
