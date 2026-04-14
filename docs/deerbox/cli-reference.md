---
title: CLI Reference
outline: deep
---

# CLI Reference

## Interactive mode (default)

```
deerbox [prompt] [options]
```

Runs Claude Code interactively in a sandboxed worktree. If no prompt is given, Claude starts in interactive mode.

| Flag | Description |
|------|-------------|
| `-m, --model <model>` | Claude model to use (default: sonnet) |
| `-b, --base-branch <branch>` | Branch to base the worktree on |
| `-f, --from <source>` | Start from a branch, PR URL, GitHub issue URL, or GitHub Actions URL |
| `-k, --keep` | Keep worktree after Claude exits |
| `-c, --continue` | Resume the most recent session for this repo |

**Examples:**

```sh
# Simple prompt
deerbox "Add input validation to the signup form"

# Use Opus, branch from a feature branch
deerbox --model opus --from feature/auth "Add rate limiting"

# Start from a GitHub PR
deerbox --from https://github.com/org/repo/pull/42 "Fix the failing tests"

# Resume the last session
deerbox --continue
```

---

## Subcommands

### `deerbox prepare`

Prepare a session without launching it. Outputs JSON to stdout. Used by the deer TUI to set up sessions before launching them in tmux.

| Flag | Description |
|------|-------------|
| `--repo-path <path>` | Repository path (required) |
| `--base-branch <branch>` | Base branch (required) |
| `--prompt <prompt>` | Task prompt |
| `--model <model>` | Claude model |
| `--task-id <id>` | Pre-generated task ID |
| `--config-json <json>` | Config override as JSON |
| `--continue-task-id <id>` | Resume session task ID |
| `--continue-worktree <path>` | Resume session worktree path |
| `--continue-branch <branch>` | Resume session branch |

**Output:**

```json
{
  "taskId": "abc123",
  "worktreePath": "/home/user/.local/share/deer/tasks/org-repo/abc123/worktree",
  "branch": "deer/abc123",
  "command": ["srt", "-s", "settings.json", "-c", "claude ..."],
  "authProxyPid": 12345
}
```

---

### `deerbox destroy`

Clean up a task's resources (worktree, task directory, auth proxy).

| Flag | Description |
|------|-------------|
| `--task-id <id>` | Task ID (required) |
| `--repo-path <path>` | Repository path (required) |

---

### `deerbox prune`

Remove dangling worktrees and task directories.

| Flag | Description |
|------|-------------|
| `--force` | Kill all deer processes, tmux sessions, and wipe all task data |

**Normal mode** only removes tasks with no live tmux session and no live auth proxy. Safe to run at any time.

**Force mode** kills everything and wipes `~/.local/share/deer/tasks/`. Use when things get stuck.

---

### `deerbox preflight`

Run dependency and credential checks. Outputs JSON to stdout.

**Output:**

```json
{
  "ok": true,
  "errors": [],
  "warnings": ["tmux version 3.2 detected, 3.3+ recommended"],
  "credentialType": "oauth"
}
```

Checks for: SRT (or bwrap on Linux), tmux, Claude CLI, GitHub CLI, and valid credentials.

---

### `deerbox config`

Dump the merged configuration for a repository. Outputs JSON to stdout.

| Flag | Description |
|------|-------------|
| `--repo-path <path>` | Repository path (required) |

Useful for debugging which config values are active after merging defaults, global config, and repo-local config.

---

### `deerbox env`

Review and update the environment variable policy. Opens an interactive prompt to approve or deny host environment variables that the sandbox has requested access to.

---

## Global flags

| Flag | Description |
|------|-------------|
| `-h, --help` | Show help |
| `-v, --version` | Show version |
