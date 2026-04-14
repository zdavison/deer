---
title: Your First Agent (deer)
outline: deep
---

# Your First Agent (deer)

## Launch the dashboard

Navigate to any git repository and start deer:

```sh
cd your-project
deer
```

The dashboard appears with a prompt bar at the bottom.

## Send a prompt

Type a prompt describing the work you want done and press **Enter**:

```
Add input validation to the signup form
```

deer creates a sandboxed worktree and launches a Claude Code agent. You'll see it appear in the agent list with status **setup**, then transition to **running**.

## Switch to the agent list

Press **Tab** to move focus from the prompt bar to the agent list. Your new agent should be highlighted.

## Attach to the agent

Press **Enter** to attach to the agent's tmux session. You'll see Claude Code working in real time, just like the regular CLI.

To detach and return to the dashboard, press **Ctrl+b**, then **d**.

## Wait for the agent to finish

Back in the dashboard, watch the agent's status. When it completes its work, the status changes to **idle**.

## Create a PR

With the idle agent selected, press **p**. deer generates a branch name, PR title, and description, then pushes and opens a pull request. The PR URL appears in the agent's row.

## Quit

Press **q** to exit. If any agents are still running, deer asks you to confirm before quitting.
