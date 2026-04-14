---
title: Your First Agent (deerbox)
outline: deep
---

# Your First Agent (deerbox)

## Run deerbox

Navigate to any git repository and run deerbox with a prompt:

```sh
cd your-project
deerbox "Add input validation to the signup form"
```

deerbox creates a sandboxed git worktree and launches Claude Code inside it. You're automatically attached to the tmux session, so you can watch the agent work in real time.

## Watch the agent work

Claude Code runs with full autonomy inside the sandbox. It can read and write files in the worktree, install dependencies, and run commands -- all isolated from your main checkout.

You don't need to do anything. Just watch, or detach with **Ctrl+b**, **d** and come back later.

## The post-session menu

When Claude finishes (or you stop it), deerbox presents an interactive menu:

| Key | Action |
|-----|--------|
| **p** | Create a pull request |
| **k** | Keep the worktree (default) |
| **s** | Open a shell in the worktree |
| **d** | Discard the worktree and all changes |

Press **p** to push the branch and open a PR. deerbox generates the branch name, title, and description automatically.

## Useful flags

| Flag | Description |
|------|-------------|
| `--model <model>` | Use a specific Claude model (e.g. `--model opus`) |
| `--from <branch>` | Branch from a specific branch instead of the default |
| `--keep` | Keep the worktree after the session ends (skip the menu) |

```sh
# Use Opus and branch from a feature branch
deerbox --model opus --from feature/auth "Add rate limiting to the login endpoint"
```

Run `deerbox --help` for the full list of options.
