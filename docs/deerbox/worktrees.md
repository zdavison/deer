---
title: Worktrees
outline: deep
---

# Worktrees

Each agent gets its own git worktree -- a separate checkout of the repository. The worktree is the only writable directory inside the sandbox.

## Location

All worktrees live under the deer data directory:

```
~/.local/share/deer/tasks/<repoSlug>/<taskId>/worktree/
```

Where `<repoSlug>` is a filesystem-safe version of the repo name (e.g. `org-repo`) and `<taskId>` is a unique identifier for the task.

## New worktree (default)

When you run deerbox without `--from` or `--continue`, a new worktree is created:

```sh
git worktree add -b deer/<taskId> <path> <baseBranch>
```

This creates a new branch `deer/<taskId>` based on the configured base branch (usually `main` or `master`).

## Checkout existing branch (`--from`)

The `--from` flag checks out an existing branch without creating a new one:

```sh
deerbox --from feature/my-branch "Continue the work"
```

If the branch exists only on the remote, deerbox fetches it first. This is useful for:

- Continuing work on an existing feature branch
- Working on a branch from a pull request
- Picking up where another agent left off

The `--from` flag also accepts PR URLs, issue URLs, and GitHub Actions URLs. deerbox resolves these to the appropriate branch automatically.

## Resume session (`--continue`)

The `--continue` flag reuses the most recent session's worktree and branch for the current repo:

```sh
deerbox --continue
```

No new worktree or branch is created. The agent picks up exactly where the previous session left off, with all file changes intact.

## Cleanup

Worktrees are cleaned up in several ways:

- **PR creation or discard:** When you create a PR or discard changes from the post-session menu, the worktree is removed with `git worktree remove <path> --force`.
- **Branch deletion:** Branches prefixed with `deer/` are deleted along with the worktree. User branches (from `--from`) are never deleted.
- **Keep:** Choosing "keep" from the post-session menu leaves the worktree in place for later use with `--continue`.

## Pruning

Dangling worktrees from crashed or interrupted sessions can accumulate over time. deerbox provides two pruning modes:

### Normal prune

```sh
deerbox prune
```

Removes worktrees and task directories only for tasks that have no live tmux session and no live auth proxy. Safe to run at any time -- it will not touch active sessions.

Normal pruning also runs automatically (and silently) every time you start an interactive deerbox session.

### Force prune

```sh
deerbox prune --force
```

Kills all deer tmux sessions and auth proxy processes, then wipes the entire `~/.local/share/deer/tasks/` directory and removes all associated git worktrees and branches. Use this when things get stuck or you want a clean slate.
