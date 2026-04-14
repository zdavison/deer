---
title: Dashboard
outline: deep
---

# Dashboard

## UI layout

The deer dashboard is a full-screen terminal UI built with Ink/React. From top to bottom:

- **Header** -- title bar showing the repo name and preflight status (green when all checks pass).
- **Agent list** -- scrollable list of all agents. The selected agent is highlighted. Each row shows the agent's status, elapsed time, and prompt summary.
- **Context chip bar** -- appears above the prompt input when context chips are attached (see [Context System](context-system)).
- **Prompt input** -- multi-line text input with bracket-paste support and history navigation.
- **Shortcuts bar** -- contextual bar at the bottom showing available keyboard shortcuts for the current mode.
- **Log detail panel** -- toggleable side panel showing the selected agent's tmux output. Open it with `l`.

---

## Keyboard shortcuts

The dashboard has three input modes. Available shortcuts change depending on which mode is active.

### Input mode (default)

The prompt input has focus. Type your prompt and submit it to launch an agent.

| Key | Action |
|-----|--------|
| Enter | Submit prompt and launch a new agent |
| Up / Down | Navigate prompt history |
| Tab | Switch focus to the agent list |
| @ | Open the context picker |

### Agent list mode

Press Tab from input mode to switch focus to the agent list.

| Key | Action |
|-----|--------|
| Tab | Back to input mode |
| j / Down | Select next agent |
| k / Up | Select previous agent |
| / | Start fuzzy search |
| Enter | Attach to the selected agent's tmux session |
| x | Kill agent |
| r | Retry agent |
| p | Create PR (or open existing PR in browser) |
| u | Update existing PR |
| s | Open shell in the agent's worktree |
| l | Toggle log detail panel |
| c | Copy logs to clipboard (when log panel is open) |
| v | Toggle verbose logs (when log panel is open) |
| Backspace | Delete agent entry |
| q | Quit deer |

Destructive actions -- kill, delete with uncommitted work, retry while running -- prompt for `y/n` confirmation before proceeding.

### Search mode

Press `/` from agent list mode to start a fuzzy search over agents.

| Key | Action |
|-----|--------|
| j / Down | Next match |
| k / Up | Previous match |
| Enter | Select match and return to agent list mode |
| Esc | Cancel search |

---

## Attaching to agents

Press Enter on a selected agent to attach to its tmux session. This drops you into the same terminal Claude Code is running in -- you can watch output in real time or interact with Claude directly.

To detach and return to the deer dashboard, press `Ctrl+b`, then `d` (the standard tmux detach sequence).

![tmux status bar](../assets/deer-status-bar.png)

The tmux status bar at the bottom of the session shows the agent's task ID and branch name.
