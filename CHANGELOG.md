# Changelog

## 0.1.2 - 2026-05-14

### Added

- Added multi-channel config support with backward compatibility for legacy Telegram configs.
- Added explicit channel selection with `afk telegram`, `afk discord`, and `--channel`.
- Added `afk init telegram` and `afk init discord` channel-specific setup.
- Added a DM-first Discord channel adapter with approval buttons and diff attachments.

## 0.1.1 - 2026-05-13

### Changed

- AFK now starts Codex app-server with `approval_policy="untrusted"` by default for remote sessions, even if the user's Codex config is less restrictive.
- Added `--accept-agent-config` for users who explicitly want AFK to inherit their Codex approval settings.
- Approval cards now include `Approve & Trust` when Codex supports session-scoped trust.
- AFK now handles basic file-change approval requests instead of rejecting them as unsupported.

## 0.1.0 - 2026-05-13

Initial v0 release.

### Added

- `afk init` for Telegram bot pairing.
- `afk` as the one-command Away Mode start.
- `afk start`, `afk stop`, `afk status`, and `afk resume`.
- Telegram `/sessions` picker for choosing a recent project and Codex thread before starting work.
- macOS sleep prevention via `caffeinate -dimsu` while Away Mode is active.
- Codex app-server adapter for starting and steering turns, receiving messages, handling shell approvals, tracking completion, reading recent session context, and snapshotting diffs.
- Telegram channel adapter with long polling, inline approval buttons, recent-context catch-up, and HTML/raw diff attachments.
- Local state in `~/.local/state/afk`.
- Owner-only config file writes for the Telegram bot token.
- Crash reporting to Telegram when Codex exits unexpectedly.
- Telegram polling retry with backoff.

### Notes

- Codex app-server support is experimental and may require updates as Codex changes.
- v0 is Telegram only and Codex only. Discord, richer diff rendering, richer file-change approvals, and editor extensions are planned after v0.
