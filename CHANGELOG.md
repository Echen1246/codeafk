# Changelog

## 0.1.0 - 2026-05-13

Initial v0 release.

### Added

- `apgr init` for Telegram bot pairing.
- `apgr start`, `apgr stop`, `apgr status`, and `apgr resume`.
- Telegram `/sessions` picker for choosing a recent project and Codex thread before starting work.
- Codex app-server adapter for starting turns, receiving messages, handling shell approvals, tracking completion, and snapshotting diffs.
- Telegram channel adapter with long polling, inline approval buttons, and `.diff` attachments.
- Local state in `~/.local/state/apgr`.
- Owner-only config file writes for the Telegram bot token.
- Crash reporting to Telegram when Codex exits unexpectedly.
- Telegram polling retry with backoff.

### Notes

- Codex app-server support is experimental and may require updates as Codex changes.
- v0 is Telegram only and Codex only. Discord, HTML diffs, file-change approvals, and editor extensions are planned after v0.
