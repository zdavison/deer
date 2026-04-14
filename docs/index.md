---
title: Home
---

# 🦌 deer

Run multiple unattended Claude Code agents safely in parallel.

![deer dashboard](assets/demo-dashboard.png)

---

**deer** is a TUI dashboard for launching, monitoring, and managing multiple Claude Code agents at once. Each agent runs in its own sandboxed git worktree with full filesystem and network isolation.

**deerbox** is the standalone CLI that runs a single sandboxed agent. deer uses deerbox under the hood, but you can also use deerbox directly in scripts or when you only need one agent at a time.

## Goals

- **Parallel agents** -- launch as many agents as you want from a single dashboard.
- **Safe `--dangerously-skip-permissions`** -- every agent is sandboxed (filesystem, network, credentials), so unrestricted mode is actually safe.
- **Uses your Claude subscription** -- no separate API key needed. deer picks up your existing Claude Code login automatically.
- **Feels like `claude`** -- attach into any agent's tmux session and interact with it directly, just like the regular CLI.

## How it works

1. Launch `deer` inside a git repo.
2. Type prompts -- each one spins up a new agent in an isolated worktree.
3. Monitor agents from the dashboard, or press Enter to attach into one.
4. When an agent finishes, press `p` to create a PR.

That's it. No config files required, no orchestration layer to learn.

## Using deerbox standalone

If you only need a single agent, you can skip the dashboard entirely:

```sh
deerbox "refactor the auth module to use JWT"
```

deerbox handles worktree creation, sandboxing, and cleanup on its own. When the agent finishes, an interactive menu lets you create a PR, keep the worktree, open a shell, or discard the work.

---

<div class="actions">
  <a href="getting-started/" class="action-link">Get started →</a>
  <a href="https://github.com/zdavison/deer" class="action-link secondary">View on GitHub</a>
</div>
