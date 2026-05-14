# Discord Setup

Use this if you want to talk to CodeAFK from Discord.

## Create a Bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create an application.
3. Open **Bot**.
4. Copy the bot token. If Discord only shows **Reset Token**, reset it and copy the new token.

## Pair Discord

Run:

```bash
afk init discord
```

Then:

1. Paste the bot token.
2. Open the install URL that AFK prints.
3. Add the bot to a private server you control.
4. Open a DM with the bot and send any message.
5. Return to the terminal and confirm the pairing.

AFK saves the pairing to `~/.config/afk/config.toml`.

AFK uses normal direct messages. You do not need to set up Discord slash commands.

## Use It

Start AFK from the project you want Codex to work in:

```bash
cd /path/to/your/project
afk discord
```

In the bot DM, send:

```text
/sessions
```

Choose a project, then choose a Codex session or reply `new`.

## Approvals

When Codex asks to run something, Discord shows:

```text
[Approve] [Approve & Trust] [Deny]
```

`Approve & Trust` accepts the current request and trusts that approval category for the rest of the AFK session.

## Troubleshooting

If no server appears in the Discord invite screen, make sure your Discord account has permission to manage that server.

If you cannot DM the bot, check your Discord privacy settings and make sure you share a server with the bot.

If the bot looks offline, make sure `afk` is still running on your laptop.

If approval buttons do not appear, Codex may already trust that action. AFK only shows buttons when Codex asks for approval.
