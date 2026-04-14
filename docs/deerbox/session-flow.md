---
title: Session Flow
outline: deep
---

# Session Flow

This page walks through what happens when you run a command like:

```sh
deerbox "Fix the bug in the login handler"
```

## 1. Configuration

deerbox loads and merges configuration from all sources, with later sources overriding earlier ones:

1. Built-in defaults
2. `~/.config/deer/config.toml` (global)
3. `deer.toml` in the repo root (repo-local)
4. CLI flags

See [Configuration](/configuration/) for the full field reference.

## 2. Worktree creation

A fresh git worktree gives the agent an isolated copy of the repo.

- **Default:** Creates branch `deer/<taskId>` from the base branch. The worktree lives at `~/.local/share/deer/tasks/<repoSlug>/<taskId>/worktree/`.
- **With `--from`:** Checks out an existing branch (no new branch created). Fetches from origin if the branch is remote-only.
- **With `--continue`:** Reuses the previous session's worktree and branch. No new worktree or branch created.

See [Worktrees](worktrees) for more detail.

## 3. Ecosystem detection

deerbox scans the repo for lockfiles (`uv.lock`, `pnpm-lock.yaml`, `package-lock.json`, `go.mod`, `bun.lockb`) and applies strategies for each detected ecosystem:

- Read-only cache mounts to avoid re-downloading packages
- Dependency prepopulation (e.g. copying `node_modules` from the host repo)
- Environment variables for cache directories

See [Ecosystems](ecosystems) for the full list and strategies.

## 4. Setup command

If `setup_command` is configured (in `deer.toml` or global config), deerbox runs it inside the worktree before launching the agent. This is typically used for dependency installation:

```toml
setup_command = "pnpm install"
```

## 5. Git configuration

deerbox writes a minimal `.gitconfig` into the task directory that:

- Disables the host `~/.gitconfig` (prevents leaking host-specific settings)
- Rewrites SSH remotes to HTTPS (so git traffic routes through the HTTP auth proxy)
- Sets the git user to `deer-agent`

## 6. Claude config directory

deerbox creates a per-task copy of `~/.claude` at `<taskDir>/claude-config/`. This copy includes:

- `CLAUDE.md` and settings files
- Commands, hooks, plugins, and skills

OAuth tokens and API keys are stripped from the copied config. The sandbox uses `CLAUDE_CONFIG_DIR` to point at this isolated copy.

## 7. Auth proxy

A host-side MITM proxy starts on a Unix socket. The proxy:

- Maps credentials to upstream domains (`api.anthropic.com`, `github.com`, etc.)
- Intercepts outbound HTTP requests from the sandbox
- Injects real auth headers before forwarding to the upstream over HTTPS

The sandbox never sees actual credentials. It only has HTTP URLs that route through the SRT proxy to the MITM proxy to the real HTTPS upstream.

## 8. Sandbox launch

deerbox generates SRT settings (filesystem rules, network allowlist, MITM config) and builds the launch command:

```
srt -s <settings.json> -c "claude --dangerously-skip-permissions --model <model> <prompt>"
```

- In **interactive mode**, this command runs inside a new tmux session. You are attached automatically.
- In **prepare mode** (`deerbox prepare`), the command array is returned as JSON for the caller to launch.

## 9. Post-session menu (interactive only)

When Claude exits, deerbox presents an interactive menu:

| Key | Action |
|-----|--------|
| **p** | Create a pull request |
| **k** | Keep the worktree (default) |
| **s** | Open a shell in the worktree |
| **m** | Merge the branch into the base branch |
| **d** | Discard the worktree and all changes |

Pressing **p** pushes the branch and creates a GitHub PR with an auto-generated title and description.
