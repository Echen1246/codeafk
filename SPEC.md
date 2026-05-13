# Agent Pager — Product Spec

## One-line concept

A pager for your coding agent. You stay in the loop when you're away from keyboard.

You leave the laptop running with Codex working on a task. From your phone — on Telegram or Discord — you receive updates, answer the agent's questions, approve risky actions, and steer it when needed. When you get back to your laptop, you resume the same Codex thread in your terminal and pick up where the agent left off.

---

## Core philosophy

Most products in this space are trying to remove the human from the loop. We're trying to keep the human in the loop even when the human isn't at the desk.

Current coding agents don't have enough context or reliability to run unsupervised on real codebases for hours. They need a human in the approval seat — to clarify ambiguous requests, approve commands, redirect when they go off track, and review diffs. But the human leaves their desk for many reasons every day: workouts, meals, errands, walks, sleep. Today, that means the agent stops being useful the moment you step away.

Agent Pager is the missing piece: a thin layer that lets the human stay reachable from anywhere, while the agent keeps working in a sandboxed, configured environment that the user already trusts.

We are not a mobile IDE. We are not an autonomous-agent platform. We are a pager.

---

## What this is not

- Not a remote desktop tool
- Not a mobile IDE or mobile code editor
- Not a new coding agent
- Not a replacement for Codex or Cursor
- Not a way to bypass IDE approval/sandbox settings
- Not an autonomous-agent system
- Not a mass-messaging or team product
- Not a hosted SaaS — v0 ships with zero hosted infrastructure

---

## Why Telegram and Discord, not SMS

We considered SMS first. We rejected it for clear reasons:

1. **SMS requires a paid service like Twilio**, which is incompatible with the OSS model — every contributor would need their own paid account, registered campaigns, and US-only carrier compliance.
2. **Telegram and Discord have free, official bot APIs** with global reach, no provisioning, no carrier filtering, and richer UX than SMS (inline approval buttons, file attachments, markdown formatting).
3. **Telegram supports long polling** — the laptop daemon can talk outbound to `api.telegram.org` and never expose an inbound port, eliminating the need for any relay server.
4. **Discord is the natural fit for developer audiences** ("vibes channel") while Telegram covers everyone else.

The user runs the daemon, pairs it with a bot they created, and the entire communication path is daemon ↔ Telegram/Discord servers ↔ phone. No hosted infrastructure exists in v0.

---

## Architecture

### High-level diagram

```
Phone (Telegram or Discord app)
  ↕
Telegram / Discord servers   (free, third-party)
  ↕  (outbound long-poll or webhook from daemon)
Laptop daemon (apgr)
  ↕  (stdio JSON-RPC)
Codex app-server
  ↕
Local repo, git, shell sandbox, AGENTS.md, ~/.codex/config.toml
```

The daemon is the only process that talks to Codex. The phone never has a route to Codex. There is no relay server in v0.

### Components

**Daemon (`apgr`)**

A single binary the user runs on their laptop. Responsibilities:

- Spawn and own a `codex app-server` process over stdio
- Start or resume a Codex thread
- Long-poll the configured messaging channel (Telegram bot, Discord bot) for inbound user messages
- Forward user messages into Codex as `turn/start` or `turn/steer`
- Consume Codex app-server events (`turn/diff/updated`, approval requests, completion, errors)
- Translate Codex events into AgentEvents (internal abstraction)
- Render AgentEvents into channel-appropriate messages (Telegram inline buttons, Discord embeds, etc.)
- Handle approval decisions sent from the phone
- Send completion summaries with diff attachments
- Manage Away Mode (on/off) and session ownership lock

**Codex app-server (subprocess)**

Spawned by the daemon over stdio. Communicates via documented JSON-RPC protocol. Bound to no network port. Source of truth for agent state.

**Messaging channel adapters**

Pluggable adapters implementing a `MessageChannel` interface. v0 ships:

- `TelegramChannel` (long-polling Telegram Bot API)
- `DiscordChannel` (Discord Bot API, gateway connection)

Both adapters present the same surface to the daemon. Adding future channels (SMS via Twilio for users who want it, Slack DMs, Matrix, Signal-via-signal-cli) means writing a new adapter, not changing the daemon.

**Mobile diff viewing**

In v0, when a diff needs review, the daemon renders a lightweight HTML file locally and sends it alongside the raw `.diff` attachment via Telegram. The user opens it in their messaging app's built-in viewer. No hosted page, no signed URLs, no relay.

In v0.5, the HTML diff can become richer and syntax-highlighted. For very small diffs (≤30 lines), the daemon may also send the diff inline as a code block in the chat.

---

## Security invariants

These are architectural rules, not deployment notes. They must hold in all builds.

1. **Codex is never exposed to the public internet.** The daemon spawns Codex over stdio. There is no listening port. If future versions use a local WebSocket transport, it binds to `127.0.0.1` only.

2. **The phone never connects directly to the laptop.** All communication flows through the messaging service (Telegram/Discord servers).

3. **The daemon is the only client of Codex.** No other process, including the user's IDE, talks to the same app-server instance.

4. **Inbound messages are authenticated by channel.** The daemon only accepts messages from the chat_id / user_id pre-configured during `apgr init`. Messages from any other source are dropped.

5. **The bot token is the user's secret.** It is stored locally (e.g. `~/.config/apgr/config.toml`) with file-mode 0600. It is never sent over the wire to anything except the channel's official API.

6. **No code or repo contents leave the laptop except through the channel.** Diffs are sent as file attachments to Telegram/Discord; the user trusts these services with their messages. The daemon does not upload code to any other endpoint.

---

## Session ownership

Only one writer owns a Codex thread at a time. This is enforced by explicit user action, not heuristics.

**States:**

- **Away Mode ON** — phone/daemon owns the thread. SMS prompts are forwarded to Codex. Local TUI use is discouraged (the daemon won't actively block it, but mixing both will produce a confusing dual-writer state the user can recover from with `apgr resume`).

- **Away Mode OFF** — laptop/TUI owns the thread. Inbound messages from the phone receive a "Pager is paused, resume with `apgr start`" reply.

**Transitions:**

- `apgr start` → Away Mode ON, daemon owns thread
- `apgr stop` or `apgr resume` → Away Mode OFF, daemon releases lock
- `apgr resume` additionally prints `codex resume <thread-id>` for the user to run in their terminal

v0 does **not** implement automatic detection of "user is at laptop." If the user wants to take over, they explicitly run `apgr resume`.

---

## Adapter abstraction

The daemon talks to coding agents through an `AgentAdapter` interface. v0 implements `CodexAdapter`. Future versions add `ClaudeCodeAdapter`, `AiderAdapter`, and `CursorAdapter` (the last using Cursor's SDK/CLI/ACP, not native chat).

### TypeScript signature

```ts
type AgentEvent =
  | {
      type: "message_delta";
      sessionId: string;
      turnId: string;
      text: string;
    }
  | {
      type: "message_complete";
      sessionId: string;
      turnId: string;
      text: string;
    }
  | {
      type: "approval_required";
      sessionId: string;
      turnId: string;
      approvalId: string;
      kind: "shell" | "file_change" | "network" | "user_input";
      title: string;
      summary: string;
      detailsRef?: string;
      availableDecisions: Array<"accept" | "decline" | "cancel" | "acceptForSession">;
    }
  | {
      type: "diff_updated";
      sessionId: string;
      turnId: string;
      diffRef: string;
      changedFiles: string[];
      stats?: { files: number; additions: number; deletions: number };
    }
  | {
      type: "turn_complete";
      sessionId: string;
      turnId: string;
      status: "completed" | "interrupted" | "failed";
      summary?: string;
      changedFiles?: string[];
      latestDiffRef?: string;
    }
  | {
      type: "error";
      sessionId: string;
      turnId?: string;
      summary: string;
      detailsRef?: string;
    };

interface AgentAdapter {
  startSession(options: StartSessionOptions): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  steerActiveTurn(sessionId: string, turnId: string, text: string): Promise<void>;
  answerApproval(
    sessionId: string,
    approvalId: string,
    decision: "accept" | "decline" | "cancel" | "acceptForSession"
  ): Promise<void>;
  interrupt(sessionId: string, turnId: string): Promise<void>;
  streamEvents(sessionId: string): AsyncIterable<AgentEvent>;
}
```

Diffs come through events, not as a separate `getDiff()` call. The daemon snapshots them as `diffRef`s when `diff_updated` events arrive.

### MessageChannel signature

```ts
type ChannelMessage = {
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; mimeType: string }>;
  buttons?: Array<{ label: string; callbackId: string }>;
};

type ChannelEvent =
  | { type: "message"; text: string; fromUserId: string }
  | { type: "button_press"; callbackId: string; fromUserId: string };

interface MessageChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: ChannelMessage): Promise<void>;
  events(): AsyncIterable<ChannelEvent>;
}
```

---

## Codex event mapping

When the `CodexAdapter` consumes Codex app-server events, it translates them to AgentEvents. The daemon then decides how to surface each AgentEvent on the channel.

| Codex event / request | AgentEvent | Channel behavior |
|---|---|---|
| `turn/started` | — | No message (too chatty) |
| `turn/plan/updated` | buffered | If turn runs >60s, send progress note |
| `item/agentMessage/delta` | `message_delta` | Buffer text |
| `item/completed: agentMessage` | `message_complete` | Send if short and meaningful |
| `item/commandExecution/requestApproval` | `approval_required` (shell) | Send approval card with command, cwd, inline buttons |
| `networkApprovalContext` | `approval_required` (network) | Send approval card with host/port |
| `item/fileChange/requestApproval` | `approval_required` (file_change) | If tiny, inline summary + buttons; else file attachment + buttons |
| `turn/diff/updated` | `diff_updated` | Snapshot `diffRef` immediately |
| `item/commandExecution/outputDelta` | — | Buffer for log file if turn fails |
| `error` | `error` | Send terse error message; attach details file if available |
| `turn/completed` | `turn_complete` | Send completion summary with changed files and diff attachment |
| `tool/requestUserInput` | `approval_required` (user_input) | Send question; user reply is the response |
| `serverRequest/resolved` | — | Mark approval ID consumed |

For v0, only these are implemented:

- `turn_complete`
- `error`
- `message_delta` buffering → `message_complete`
- `approval_required` (shell only)
- `diff_updated` snapshotting

`file_change` approvals and richer event surfaces come in v0.5 and v1.

---

## User flow

### First-time setup

```
$ apgr init

Welcome to Agent Pager.

Choose your messaging channel:
  1) Telegram
  2) Discord

> 1

Telegram setup:
  1. Open Telegram and search @BotFather
  2. Send /newbot, follow prompts
  3. Copy the bot token here:

> 7891234567:AAH_example_token

Now send any message to your bot from your phone, then press Enter.

> (waits)

Detected message from @ayocheddie (chat_id 12345678).
Pair this Telegram account with apgr? [y/n]: y

Paired successfully.
Config saved to ~/.config/apgr/config.toml

You're ready. Try `apgr start` in a repo.
```

### Daily use

```
$ cd ~/projects/myapp
$ apgr start

apgr is running.

Workspace:  ~/projects/myapp
Agent:      Codex
Thread:     thr_abc123 (new)
Channel:    Telegram (@ayocheddie)

Away Mode is ON.
Text your bot to send prompts to Codex.
Press Ctrl+C or run `apgr stop` to end.
```

Phone receives via Telegram:

```
Pager started for myapp.
Send a message to begin, or /help for commands.
```

User texts:

```
look at the failing test in auth.test.ts and fix it
```

Bot replies:

```
Sent to Codex.
```

A minute later:

```
Codex needs to run:
  npm test -- auth.test.ts

[ Approve ]  [ Deny ]
```

User taps Approve. Codex runs, fails, retries with a fix, and finishes:

```
Codex finished ✓

Changed:
  src/auth/callback.ts  (+12 -5)
  test/auth.test.ts     (+8 -2)

Tests: 42/42 passed

📎 diff.html (8 KB)

[ Continue ]  [ Stop ]
```

User taps the attached `diff.html`, reviews on phone, taps Continue:

```
Send your next instruction:
```

User replies:

```
nice, also add a test for the expired-state case
```

(...continues)

### Returning to laptop

```
$ apgr resume

Away Mode stopped.

To continue this thread in your terminal:
  codex resume thr_abc123
```

User runs `codex resume thr_abc123` in their preferred shell or IDE terminal, and the same thread — with full transcript, plan, and approvals — is now driven locally.

---

## Roadmap

### v0 — Codex + Telegram, minimal

The shippable weekend project. One binary. No hosted infra. Telegram only. Codex only. Shell approvals only. Diffs are sent as local HTML and raw `.diff` file attachments.

Deliverables:

- `apgr init` (Telegram channel setup, phone pairing)
- `apgr start` (spawns Codex app-server, opens Telegram polling, starts thread)
- `apgr stop`
- `apgr resume` (prints `codex resume <thread-id>`)
- `apgr status` (shows current thread, channel state, uptime)
- Send prompts from phone → Codex `turn/start` or `turn/steer`
- Receive Codex agent messages buffered → Telegram
- Shell command approval flow with inline buttons
- `turn/completed` summary with file list
- HTML and raw `.diff` attachments on completion
- Basic error handling and "Codex crashed" reporting

Success criterion: Eddie can leave for the gym, send a real prompt from his phone, get a real response, approve a real command, and come back to a usable diff he can review and resume in `codex resume`.

### v0.5 — Polish + Discord

- Discord channel adapter
- File-change approval flow
- Richer syntax-highlighted diff attachment (one Shiki render → HTML file → send via channel)
- Channel-side `/help`, `/status`, `/stop`, `/resume` commands
- Heartbeat and "laptop offline" detection
- Bot token rotation flow

### v1 — VS Code extension + Cursor compatibility

The VS Code extension is a convenience layer. It works in Cursor because Cursor uses the VS Code extension API. The extension does **not** try to mirror Cursor's native chat.

- VS Code extension: `Agent Pager: Start Away Mode` command (spawns daemon as child process)
- Extension sidebar: shows current thread, channel pairing, recent phone activity log
- Extension: "Resume from Phone Session" command, runs `codex resume <id>` in the integrated terminal
- One-click pairing UI inside the extension
- Available on the VS Code Marketplace and OpenVSX (so Cursor users can install it)

### v2 — More agents

- `ClaudeCodeAdapter` (PTY/stdio-based, baton-pass works)
- `AiderAdapter` (CLI-based)
- `GeminiCLIAdapter`

These share Codex's baton-pass model — they're CLI agents with resumable sessions.

### v3 — Cursor as a parallel agent

- `CursorAdapter` using `@cursor/sdk` or `cursor agent acp`
- Positioned as "Cursor-style agent working your repo while you're away" — not "remote control your Cursor chat"
- Clear UX distinction so users understand this is a parallel session, not the same one they have open in Cursor's sidebar

---

## Out of scope (forever or near-forever)

- Native Cursor sidebar chat mirroring (Cursor doesn't expose the API; we will not scrape)
- Mobile native apps (the channel app is the mobile app)
- Hosted SaaS with user accounts
- Team / multi-user features
- Audit logs, SSO, enterprise admin
- Mass-messaging
- Web dashboard
- Anything that requires running a public server

If we later need any of these, they belong in a separate product, not in `apgr`.

---

## Naming

- **Project name (public):** Agent Pager
- **Repo:** `agent-pager`
- **CLI binary:** `apgr`
- **Tagline:** "A pager for your coding agent."

`apgr` is short, unique, doesn't collide with `pager` (which is overloaded with `$PAGER` semantics), and types easily.

---

## Implementation choices

- **Language:** TypeScript / Node.js. Reasons: Codex app-server is JSON-RPC over stdio (trivial in Node), Telegram and Discord have first-class Node SDKs, fast to ship, easy for contributors to extend. Future Rust rewrite is an option once the product is validated.
- **Distribution:** `npm install -g agent-pager` for v0. Single-binary builds (via `pkg` or `bun build`) come later.
- **Config:** `~/.config/apgr/config.toml` (Linux/macOS), `%APPDATA%\apgr\config.toml` (Windows). File mode 0600 on POSIX.
- **Logging:** Structured logs to `~/.local/state/apgr/apgr.log`. No telemetry sent anywhere.

---

## Risks and open questions

**Codex app-server is marked experimental.** The protocol may change. Mitigation: pin Codex version in `apgr`'s config and validate on startup. Surface clear errors when the user's installed Codex version is unsupported.

**Telegram bot tokens, if leaked, allow anyone to message the bot.** Mitigation: the daemon enforces a `chat_id` whitelist set during pairing. Even a leaked token gets a stranger nowhere because the daemon ignores their messages.

**Long-polling latency.** Telegram long-polls have ~1s tail latency. Acceptable for this use case. If it becomes a problem, switch to webhooks (which would require a tunnel — re-introduces complexity we deliberately avoided).

**Laptop sleep / network loss.** v0 surfaces this as best-effort: if the daemon is dead, Telegram messages queue at Telegram, and the daemon will see them when it next polls. If the laptop is gone for hours, the user will figure it out from the silence. v0.5 adds a heartbeat status command.

**Codex session resumption is imperfect** — there are known issues where long sessions get truncated on resume. Mitigation: surface this in `apgr resume` output ("resumed session, note: very long sessions may have truncated history") and link to the relevant Codex issue.

**Concurrency between phone and laptop.** Already covered by the Away Mode lock. If users find themselves wanting both, we revisit in v1.

---

## Success criteria

We will consider v0 a success if **one real person** — Eddie — uses Agent Pager to drive a real Codex session from their phone during one real workout, returns to their laptop, runs `codex resume`, and finds the work was actually useful.

We will consider the project a success if 100 GitHub stars and 10 outside contributors arrive within 90 days of public release. Beyond that is gravy.

If neither happens, the product was wrong, and we move on.
