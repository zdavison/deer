---
title: Agent Lifecycle
outline: deep
---

# Agent Lifecycle

Every agent launched from the dashboard follows a state machine that governs what it is doing and what actions you can take on it.

## States

| State | Description |
|-------|-------------|
| `setup` | Preparing the sandbox -- creating the worktree, detecting the ecosystem, starting the auth proxy. |
| `running` | Claude Code is executing inside the sandbox. |
| `teardown` | Agent has finished and deer is cleaning up. |
| `failed` | An error occurred. Terminal state. |
| `cancelled` | You killed the agent. Terminal state. |
| `interrupted` | deer exited while the agent was still running. Resumable. |
| `pr_failed` | PR creation failed. You can retry. |

## State transitions

```
setup --> running --> teardown --> (idle)
  |          |           |
  v          v           v
failed     failed      failed
  |          |
  v          v
cancelled  cancelled
             |
             v
         interrupted (resumable)
```

Agents move left-to-right through the happy path. Any state can transition to `failed` if an error occurs. Running agents can be cancelled by the user or interrupted if deer exits.

## Available actions per state

Not every action is available in every state. The shortcuts bar at the bottom of the dashboard reflects this.

| State | Available actions |
|-------|-------------------|
| `setup` | kill, delete |
| `running` | attach, kill, shell, delete, retry |
| `teardown` | shell, delete |
| `failed` | retry, shell, delete |
| `cancelled` | retry, shell, delete |
| `interrupted` | create PR, retry, shell, delete |
| `pr_failed` | attach, create PR, shell, delete, retry |

## Idle detection

When Claude Code finishes its work inside the sandbox, the tmux pane output stops changing. deer polls the pane content periodically and compares it against the previous snapshot. When the output has not changed for a threshold number of consecutive polls, the agent is marked as idle.

Idle agents appear ready for PR creation. The elapsed time counter pauses while an agent is idle, so the displayed duration reflects active working time only.

## Resuming interrupted agents

If deer exits while agents are still running in tmux, those tmux sessions continue in the background -- the sandboxed Claude Code processes are not affected.

When you re-launch deer in the same repo:

1. deer reads agent state from the SQLite database (`~/.local/share/deer/deer.db`).
2. It checks for live tmux sessions matching known task IDs.
3. Any agent whose tmux session is still alive is reconnected and resumed with its full state.

This means you can safely close deer, reboot your terminal, or even switch to a different terminal emulator without losing running agents.
