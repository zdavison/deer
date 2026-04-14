---
title: Data Layout
outline: deep
---

# Data Layout

## Main data directory

All deer runtime data lives under `~/.local/share/deer/` by default. Override with the `$DEER_DATA_DIR` environment variable.

```
~/.local/share/deer/
├── deer.db                              # SQLite — all task state
├── tls/
│   └── deer-ca.crt                      # TLS CA certificate for MITM proxy
├── env-policy.json                      # Environment variable policy
├── prompt-history.json                  # TUI prompt input history
├── tasks/
│   └── <repoSlug>/
│       └── <taskId>/
│           ├── worktree/                # Git worktree (sandbox writable dir)
│           ├── claude-config/           # Per-task copy of ~/.claude
│           │   ├── CLAUDE.md
│           │   ├── settings.json
│           │   └── ...
│           ├── srt-settings.json        # SRT sandbox configuration
│           ├── gitconfig                # Minimal git config
│           ├── proxy.sock               # Unix socket (auth proxy)
│           └── proxy.sock.pid           # Auth proxy PID
└── node_modules/                        # SRT binary (for compiled binary installs)
```

Each task gets its own directory under `tasks/<repoSlug>/<taskId>/`. The `repoSlug` is derived from the repository path to group tasks by repo. The `taskId` is a unique identifier generated at task creation time (e.g. `deer_abc123`).

## SQLite database

The `deer.db` file is the single source of truth for all task state. It uses a single `tasks` table:

| Column | Type | Description |
|--------|------|-------------|
| `task_id` | TEXT PK | Unique task identifier (e.g. `deer_abc123`) |
| `repo_path` | TEXT | Absolute path to the repository |
| `repo_hash` | TEXT | SHA256 hash prefix (first 16 chars) for grouping |
| `prompt` | TEXT | User's task description |
| `base_branch` | TEXT | Branch the worktree was based on |
| `branch` | TEXT | Current branch name |
| `worktree_path` | TEXT | Absolute path to the git worktree |
| `model` | TEXT | Claude model used |
| `status` | TEXT | Agent status (setup, running, failed, cancelled, interrupted, pr_failed) |
| `pr_url` | TEXT | GitHub PR URL (if created) |
| `pr_state` | TEXT | PR state: open, merged, closed, or null |
| `final_branch` | TEXT | Final branch name (after PR rename) |
| `cost` | REAL | Cumulative API cost (pay-as-you-go only) |
| `error` | TEXT | Error message on failure |
| `last_activity` | TEXT | Last log line from tmux pane |
| `elapsed` | INTEGER | Elapsed seconds (pauses while idle) |
| `idle` | INTEGER | Whether agent is idle (0/1) |
| `created_at` | INTEGER | Creation timestamp (ms) |
| `finished_at` | INTEGER | Completion timestamp (ms) |
| `poller_pid` | INTEGER | PID of the process polling this task |

The database uses **WAL mode** (Write-Ahead Logging) for concurrent access. This allows multiple deer instances to read and write to the same database without locking conflicts.

The `poller_pid` column is used for cross-instance coordination. When a deer instance starts polling a task, it writes its own PID. Other instances check whether that PID is still alive before claiming the task.

## Config files

Configuration is loaded from two locations:

```
~/.config/deer/
└── config.toml              # Global config (applies to all repos)

<repo>/
└── deer.toml                # Repo-local config (safe to commit)
```

The global config lives under `~/.config/deer/`. The repo-local config is a `deer.toml` file in the repository root. See [Configuration](/configuration/) for the full field reference and merging rules.
