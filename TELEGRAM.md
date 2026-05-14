# Telegram Setup

Use this if you want to talk to CodeAFK from Telegram.

## Create a Bot

1. Open Telegram.
2. Message [@BotFather](https://t.me/BotFather).
3. Send `/newbot`.
4. Follow the prompts.
5. Copy the bot token.

## Pair Telegram

Run:

```bash
afk init telegram
```

Then:

1. Paste the bot token.
2. Send any message to your new Telegram bot.
3. Return to the terminal and confirm the chat.

AFK saves the pairing to `~/.config/afk/config.toml`.

## Use It

Start AFK from the project you want Codex to work in:

```bash
cd /path/to/your/project
afk telegram
```

On Telegram, send:

```text
/sessions
```

Choose a project, then choose a Codex session or reply `new`.

## Approvals

When Codex asks to run something, Telegram shows:

```text
[Approve] [Approve & Trust] [Deny]
```

`Approve & Trust` accepts the current request and trusts that approval category for the rest of the AFK session.

## Troubleshooting

If the bot does not reply, make sure `afk` is still running on your laptop.

If pairing finds the wrong chat, restart `afk init telegram` and message the bot from the Telegram account you want to use.

If the token leaks or stops working, reset it in BotFather and run `afk init telegram` again.

If approval buttons do not appear, Codex may already trust that action. AFK only shows buttons when Codex asks for approval.
