# GOAL.md — AFK Implementation Guide

This file is the implementation guide for coding agents (Codex, Cursor, Claude Code) working on AFK. Read this in full before writing code. Each checkpoint is an end-to-end demoable state, not a feature checklist.

If you are a coding agent and you find yourself wanting to build something not described here, **stop and ask the user**. Do not add features. Do not over-engineer. Resist the urge to make this a framework.

---

## Required reading order

1. This file
2. `SPEC.md` (in the repo root)
3. Codex app-server documentation: https://developers.openai.com/codex/app-server
4. Telegram Bot API docs (for v0): https://core.telegram.org/bots/api

If anything in this file contradicts `SPEC.md`, `SPEC.md` wins. If anything contradicts the official Codex docs, the docs win — flag the contradiction to the user.

---

## Architectural invariants

These rules hold across all checkpoints. Violating them is never acceptable, even temporarily.

1. **Codex is never exposed to a network port.** It is spawned as a subprocess and communicated with over stdio (JSON-RPC). No listening sockets.

2. **The daemon is the only client of its Codex subprocess.** No other process — IDE extensions, helper scripts, debug tools — connects to the same Codex instance.

3. **All channel communication is outbound from the daemon.** The daemon long-polls Telegram or maintains an outbound WebSocket to Discord's gateway. No inbound webhook listeners on the laptop.

4. **Inbound messages are filtered by an authenticated identity.** Only messages from the pre-paired `chat_id` (Telegram) or `user_id` (Discord) are forwarded to Codex. Anything else is silently dropped.

5. **Bot tokens and config are stored locally with 0600 permissions.** Never logged. Never transmitted to anywhere other than the official channel API.

6. **No code, repo contents, or diffs are sent to any service other than the configured channel.** No telemetry, no error reporting to third-party services, no auto-uploaded logs.

7. **One writer per Codex thread at a time.** The daemon owns the thread while Away Mode is ON. `afk resume` releases the lock and ends Away Mode.

8. **Diffs come through events, not on-demand calls.** Snapshot diffs when `turn/diff/updated` arrives. Do not implement a `getDiff()` method.

If a checkpoint would require violating any of these, the checkpoint is wrong. Stop and flag it.

---

## Tech stack (decided, do not change without asking)

- **Language:** TypeScript on Node.js (≥20)
- **Package manager:** pnpm
- **Build:** tsc → dist/, no bundler for v0
- **Distribution:** `npm publish` as `codeafk`, binary `afk`
- **Telegram SDK:** `node-telegram-bot-api` (or `grammy` if it's substantially better — flag the choice)
- **Discord SDK:** deferred to v0.5 — do not install for v0
- **Codex transport:** Node's `child_process.spawn` + line-delimited JSON over stdin/stdout
- **Config format:** TOML (`@iarna/toml`)
- **Config location:** `~/.config/afk/config.toml` (use `env-paths` or hand-roll for cross-platform)
- **Logging:** `pino` to file at `~/.local/state/afk/afk.log` + optional pretty stdout for `afk`
- **Testing:** `vitest`

Avoid adding more dependencies. If a checkpoint seems to require a new dependency, propose it to the user before installing.

---

## Repository layout

```
codeafk/
├── README.md
├── SPEC.md
├── GOAL.md                 (this file)
├── LICENSE                 (MIT)
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts              (entrypoint, command dispatch)
│   ├── commands/
│   │   ├── init.ts
│   │   ├── start.ts
│   │   ├── stop.ts
│   │   ├── resume.ts
│   │   └── status.ts
│   ├── daemon.ts           (main daemon orchestration)
│   ├── config.ts           (load/save ~/.config/afk/config.toml)
│   ├── agent/
│   │   ├── types.ts        (AgentAdapter, AgentEvent interfaces)
│   │   └── codex.ts        (CodexAdapter)
│   ├── channel/
│   │   ├── types.ts        (MessageChannel, ChannelEvent interfaces)
│   │   └── telegram.ts     (TelegramChannel)
│   ├── orchestrator.ts     (translates AgentEvents → channel messages, channel events → adapter calls)
│   ├── approval.ts         (pending-approval registry, button-callback resolution)
│   └── sleep.ts            (macOS caffeinate lifecycle)
├── test/
│   └── ...
└── dist/                   (gitignored, tsc output)
```

Do not create files outside this layout without asking. No `src/utils/`, no `src/lib/helpers/`, no `src/shared/`. If something needs to be shared, it goes in `src/` directly or in the obvious module.

---

## Checkpoints

Each checkpoint is an end-to-end demoable state. Do not move on until the previous checkpoint's demo works on the maintainer's laptop.

### Checkpoint 0: Repo skeleton compiles and runs

**Demo:** `pnpm install && pnpm build && ./dist/cli.js --help` prints a help message showing bare `afk` as the default start path and listing the commands `init`, `start`, `stop`, `resume`, `status`.

**Scope:**
- `package.json` with bin entry `"afk": "./dist/cli.js"`
- `tsconfig.json` (strict mode, target ES2022, module NodeNext)
- `src/cli.ts` with command dispatch (use a tiny hand-rolled parser or `commander`)
- All command files exist as stubs that print "not implemented"
- README.md with one-paragraph project description and the demo command above

**Out of scope:** Any real functionality. This is purely scaffolding.

---

### Checkpoint 1: Local fake-channel + Codex echo

**Demo:** With Codex CLI installed and signed in, running `pnpm tsx src/dev/local-loop.ts "list files in this directory"` spawns Codex app-server, sends the prompt as a `turn/start`, prints streamed assistant messages to the terminal, and exits cleanly when the turn completes.

**Scope:**
- `src/agent/codex.ts` implementing `CodexAdapter`:
  - Spawn `codex app-server` via `child_process.spawn`
  - Implement JSON-RPC framing (line-delimited JSON, request/response correlation by id)
  - Implement `startSession`, `sendMessage`, `streamEvents` for the basic happy path
  - Handle `item/agentMessage/delta` → `message_delta` and `turn/completed` → `turn_complete`
- `src/dev/local-loop.ts` — a development-only script that wires CodexAdapter to stdin/stdout. **Not** shipped to users.
- Unit tests for the JSON-RPC framing

**Out of scope:** Approvals, errors, diff events, channel integration, config files. This checkpoint proves we can talk to Codex.

**Architectural notes for the agent:**

- Read the Codex app-server protocol carefully. Method names, request shapes, and event shapes must match exactly.
- Codex events arrive as JSON-RPC notifications (no `id` field). Requests have `id`s and expect responses. Don't conflate them.
- Buffer `item/agentMessage/delta` events by `turnId` so message text streams come out coherent.
- Pin the Codex version checked at startup. Read it from `codex --version` and compare to a constant in `src/agent/codex.ts`. Warn (but don't fail) on mismatch in v0.

---

### Checkpoint 2: `afk init` + Telegram pairing

**Demo:** A new user runs `afk init`, follows the prompts to create a Telegram bot via @BotFather, pastes the token, sends a message to their bot from their phone, and the CLI detects the message and pairs the chat_id. Re-running `afk init` warns that pairing exists and asks to overwrite.

**Scope:**
- `src/commands/init.ts`
- `src/config.ts` with read/save, ensures 0600 permissions on POSIX
- `src/channel/telegram.ts` — minimal: just enough to do `getUpdates` long-poll during pairing
- Config schema:
  ```toml
  [channel]
  type = "telegram"
  bot_token = "..."
  chat_id = 12345678

  [agent]
  type = "codex"
  ```

**Out of scope:** Discord, anything beyond pairing flow.

**Notes:**
- Use Telegram's `getUpdates` with `timeout=30` for long polling during the "send me a message" wait
- Once paired, immediately reply via Telegram: "Paired successfully. Run `afk` in a repo to begin."

---

### Checkpoint 3: `afk` end-to-end happy path

**Demo:** the maintainer runs `afk` in a real repo. The daemon starts Codex, starts Telegram polling, and on macOS starts `caffeinate -dimsu` so the laptop stays awake. From their phone via Telegram, they send "list the files in src/". The bot replies "Sent to Codex." A few seconds later, the bot sends the file list as a Telegram message. They send another prompt. Same thing. They press Ctrl+C, and the daemon shuts down cleanly, including the caffeinate child process. AFK prints `codex resume thr_xyz`; they run that in their terminal, and Codex picks up the conversation with full history. If they stopped AFK from another terminal, `afk resume` prints the same command.

**Scope:**
- `src/daemon.ts` — orchestrates CodexAdapter + TelegramChannel
- `src/orchestrator.ts` — the translation layer:
  - Telegram `message` event → CodexAdapter `sendMessage`
  - CodexAdapter `message_complete` AgentEvent → Telegram message
  - CodexAdapter `turn_complete` → Telegram summary message
- `src/commands/start.ts`, `stop.ts`, `resume.ts`, `status.ts`
- Graceful shutdown on SIGINT/SIGTERM
- The thread ID is persisted (in config or a state file) so `afk resume` can print it

**Out of scope:** Approvals (no shell commands needed for "list files" — Codex will just list them). Errors. Diffs. Multi-message buffering of agent thinking.

**Notes:**
- The `start` command should print clear status to stdout. The user runs it in a terminal that stays open.
- Use a sensible buffering strategy: if `message_delta` events come in fast, send the consolidated `message_complete` text, not every delta.
- Limit individual Telegram messages to 4000 chars (Telegram's limit is 4096; leave headroom). Split if necessary.
- Save the thread ID to `~/.local/state/afk/last-thread.json` so `afk resume` can find it.

---

### Checkpoint 4: Shell command approval

**Demo:** the maintainer sends "run the tests" from their phone. Codex requests approval to execute `npm test`. The daemon sends a Telegram message with the command text and inline buttons "Approve" and "Deny". The maintainer taps Approve. Codex runs the command. The output is summarized and sent back when the turn completes. Tapping Deny does the opposite path and Codex acknowledges the denial.

**Scope:**
- Extend `CodexAdapter` to handle `item/commandExecution/requestApproval` → `approval_required` AgentEvent
- Implement `answerApproval` on the adapter
- `src/approval.ts` — registry mapping `approvalId` → pending state, plus mapping channel `callbackId` → `approvalId`
- Telegram inline keyboard rendering
- Orchestrator handles `button_press` ChannelEvents → adapter `answerApproval`

**Out of scope:** File-change approvals. Network approvals. `acceptForSession` decision (just `accept` / `decline` for v0).

**Notes:**
- Inline button `callback_data` is limited to 64 bytes. Don't put the full approval ID in it — use a short hash or a counter, and map it in `approval.ts`.
- If the user taps a button for a stale approval (already resolved or session ended), reply with a "this approval is no longer pending" toast via Telegram's `answerCallbackQuery`.

---

### Checkpoint 5: Diffs on completion

**Demo:** the maintainer sends "add a hello world comment to README.md". Codex makes the change, runs to completion, and the daemon sends a Telegram message: "Codex finished ✓ Changed: README.md (+1 -0)" with the diff attached as a `.diff` file. The maintainer opens the file in Telegram, sees a clean unified diff, and is happy.

**Scope:**
- Handle `turn/diff/updated` in CodexAdapter → `diff_updated` AgentEvent
- Snapshot the diff content from the event into `~/.local/state/afk/diffs/<turnId>.diff`
- On `turn_complete`, send the most recent `diffRef` as a Telegram file attachment
- Include changed files and stats in the completion message

**Out of scope:** Syntax highlighting. File-change approval gating (Codex makes changes freely in workspace-write mode; we just report them).

**Notes:**
- For v0, send both the raw `.diff` and a lightweight locally generated HTML view. v0.5 can add richer syntax highlighting.
- If a turn produces no diff (e.g. it was a read-only query), don't send an empty attachment. Just the completion message.

---

### Checkpoint 6: Errors and resilience

**Demo:** the maintainer deliberately kills Codex mid-turn. The daemon reports "Codex crashed unexpectedly. Restart with `afk`" to Telegram. They restart; everything works. They turn off Wi-Fi for 30 seconds; the daemon recovers when Wi-Fi returns. Telegram messages sent during the outage are received once polling resumes.

**Scope:**
- Catch Codex subprocess exit; clean up; report to channel
- Telegram long-poll retry with exponential backoff
- Unhandled-rejection and uncaught-exception handlers that log clearly and exit cleanly
- `afk status` shows: Codex running/dead, channel connected/disconnected, current thread, uptime

**Out of scope:** Auto-restart of Codex. Auto-reconnect to a "session" mid-thread (Codex's resume is the user's tool for that).

---

### Checkpoint 7: v0 ship

**Demo:** the maintainer publishes `codeafk@0.1.0` to npm. They install it on a fresh machine via `npm install -g codeafk`, run `afk init`, pair Telegram, run `afk` in a real project, and use it through one real workout session. They return and run `codex resume thr_xyz` and continue the work.

**Scope:**
- README polished with quick-start instructions, screenshots/GIFs of the Telegram flow, and a clear "this is experimental" note
- LICENSE (MIT)
- `package.json` cleanup, proper keywords, repo URL
- CHANGELOG.md
- npm publish

**Out of scope:** Everything else. Ship it.

---

## Things to never do

These are anti-patterns the project must avoid. If a coding agent finds itself tempted to do any of these, stop and ask the user.

- **Do not add a hosted relay server.** v0 has zero hosted infrastructure.
- **Do not add user accounts, OAuth, or sign-in flows.** The bot token is the auth.
- **Do not add a web UI.** No dashboard, no admin panel, no settings page.
- **Do not add analytics, telemetry, or crash reporting.** Local logs only.
- **Do not add LLM calls of your own.** This product does not call any LLM API directly. Codex does the LLM work; we just transport messages.
- **Do not scrape, hook into, or hack the Cursor/VS Code chat panels.** Cursor support comes via SDK/CLI/ACP in a later version.
- **Do not try to detect "is the user at their laptop?" automatically.** Away Mode is explicitly toggled.
- **Do not implement a plugin/extension system.** Adapters are pluggable internally; users do not write plugins.
- **Do not add YAML config, JSON config, or env-var config.** TOML only, one location.
- **Do not vendor dependencies, write a "framework", or abstract over things that have one user.**
- **Do not add a database.** A few JSON/TOML files on disk are enough.

---

## Style and conventions

- TypeScript strict mode. No `any` without a written justification comment.
- Prefer `async/await` over `.then()`.
- Prefer plain functions and modules over classes, except where state genuinely warrants a class (e.g. `CodexAdapter`, `TelegramChannel`).
- Error messages addressed to humans should be specific and actionable. "Failed" is never an error message.
- Don't catch exceptions to swallow them. Catch only where there's a recovery action.
- Logs use structured fields (pino's default). Top-level events have a `module` field for grep-ability.
- No comments that restate the code. Comments explain *why*, not *what*.
- File length: prefer files under 250 lines. If a file is growing past 400, split it.

---

## Communication protocol with the user

When working through these checkpoints, the coding agent should:

- **Confirm checkpoint completion before moving on.** Run the demo. Show the output.
- **Surface uncertainties early.** If the Codex app-server protocol behaves differently than expected, say so, don't paper over it.
- **Propose, don't decide, on anything not specified here.** "I'd like to add `commander` for argument parsing — is that okay?" not "I added commander."
- **Keep commits small and named after the checkpoint.** `checkpoint-2: telegram pairing`, etc.
- **Update CHANGELOG.md as features land.**

If you hit a dead end on a checkpoint and can't figure out why, **stop and explain the problem clearly to the user**, including:
- What you tried
- What you observed
- What you expected
- Your best hypothesis about why

Don't spend hours guessing. The user is around and prefers a 5-minute conversation over a 5-hour blind alley.

## v0 done condition

v0 is done when this E2E flow works on the maintainer's actual laptop and phone:

1. They cloned the repo and ran `pnpm install && pnpm build && npm link`
2. They created a Telegram bot via @BotFather
3. They ran `afk init`, pasted the token, sent a Telegram message to pair
4. They `cd`'d into a real project they are working on
5. They ran `afk`
6. They left the laptop, went to the gym
7. From their phone, they sent a real prompt (something like "look at the failing test in X and propose a fix")
8. They received Codex's response on Telegram
9. They approved a shell command via inline button
10. They received the completion summary with diff attachment
11. They opened the diff in Telegram, reviewed it on their phone
12. They sent a follow-up prompt ("looks good, also do Y")
13. They got another response
14. They came home, ran `afk resume`
15. They ran the printed `codex resume thr_xyz` in their terminal
16. The Codex TUI showed the full conversation history from the gym
17. They continued working in the TUI

If this works, v0 is done. If it doesn't, find the breakpoint and fix it.

Then ship.
