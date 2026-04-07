# Per-task `CLAUDE_CONFIG_DIR` Isolation

**Date:** 2026-04-07
**Status:** Approved

## Goal

Give each deerbox sandbox its own isolated Claude config directory via `CLAUDE_CONFIG_DIR`, so the sandbox never needs broad access to `~/.claude`. The host config is not writable from the sandbox, and only the specific items Claude Code needs are exposed.

## Per-task Config Directory

**Path:** `~/.local/share/deer/tasks/<taskId>/claude-config/`

Created during `prepare()` in `session.ts`, before the sandbox starts. Cleaned up as part of normal task teardown (lives in the task data dir).

### Content

All items sourced from `~/.claude` are **copied** — symlinking is not viable because `~/.claude` is fully denied in the sandbox (SRT uses prefix matching on `denyRead`, so allowing a symlink target inside `~/.claude` would require un-denying the whole tree).

| Source                          | Strategy         | Reason                                                         |
|---------------------------------|------------------|----------------------------------------------------------------|
| `~/.claude/CLAUDE.md`           | Copy             | Source is under `~/.claude` (denied tree)                      |
| `~/.claude/commands/`           | Copy             | Same                                                           |
| `~/.claude/plugins/`            | Copy             | Same                                                           |
| `~/.claude/skills/`             | Copy             | Same                                                           |
| `~/.claude/hooks/`              | Copy             | Same                                                           |
| `~/.claude/settings.json`       | Copy             | Same + Claude Code may write settings back                     |
| `~/.claude/settings.local.json` | Copy             | Same                                                           |
| `~/.claude.json`                | Copy + redact    | May contain `oauthToken` / `apiKey` — strip before copying in |

All other files (history, sessions, cache, debug, etc.) are not pre-populated — Claude Code creates them fresh in the per-task dir as needed.

Items absent from `~/.claude` are skipped silently.

## Session Preparation (`session.ts`)

A new `setupClaudeConfigDir(taskId, home)` function, called in `prepare()` after worktree creation and before sandbox launch:

1. `mkdir` the `claude-config/` dir
2. For CLAUDE.md, settings.json, settings.local.json: copy if source exists
3. For directories (commands/, plugins/, skills/, hooks/): recursive copy if source exists
4. For `~/.claude.json`: read, parse JSON, delete `oauthToken` and `apiKey` fields, write to `claude-config/.claude.json`
5. Add `CLAUDE_CONFIG_DIR=<taskDataDir>/claude-config/` to `sandboxEnvFinal`

## SRT Sandbox Settings (`srt.ts`)

### `buildHomeDenyList`

Remove the `.claude*` exception. `~/.claude` is now denied like all other home entries.

### `requiredPaths`

Remove `resolveSymlinkTargets(claudeDir)` — nothing is symlinked from within `~/.claude` anymore, so there are no external symlink targets to resolve. The per-task `claude-config/` dir is under the task data dir, which is already a required root.

### `allowWrite`

- **Remove:** `~/.claude` (whole dir), `~/.claude.json`
- **Add:** `<taskDataDir>/claude-config/`

### `denyWrite`

- **Add:** `~/.claude`, `~/.claude.json`

Blanket write-denial for the host claude dirs. The old credential-specific `denyWrite` entries (`~/.claude/.credentials.json`, `~/.claude/agent-oauth-token`) are subsumed and can be removed.

### `denyRead` (credentials)

Keep credential denies scoped to the per-task dir, in case Claude Code writes tokens into settings:

- `<claude-config>/.credentials.json`
- `<claude-config>/agent-oauth-token`

## Security Properties After This Change

| Property                                 | Before   | After |
|------------------------------------------|----------|-------|
| Sandbox can read `~/.claude` broadly     | Yes      | No    |
| Sandbox can write to `~/.claude`         | Yes      | No    |
| Sandbox can read `~/.claude.json`        | Yes      | No    |
| Sandbox can write to `~/.claude.json`    | Yes      | No    |
| Host credentials exposed via config dir  | Possible | Redacted |

## Files Changed

- `packages/deerbox/src/session.ts` — add `setupClaudeConfigDir()`, call it in `prepare()`, inject `CLAUDE_CONFIG_DIR` into env
- `packages/deerbox/src/sandbox/srt.ts` — update `buildSrtSettings`: remove `.claude*` exception, update allow/deny lists, remove `resolveSymlinkTargets` call on `~/.claude`
