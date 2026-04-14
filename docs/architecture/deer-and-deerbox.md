---
title: How deer Uses deerbox
outline: deep
---

# How deer Uses deerbox

## Subprocess model

deer invokes deerbox as a child process. They do **not** share memory or state.

- Communication is one-way: deer calls deerbox subcommands, deerbox returns JSON to stdout.
- deer handles all TUI rendering, state management, and tmux orchestration.
- deerbox has no knowledge of Ink, React, or the dashboard -- it is a pure CLI tool.

## The JSON contract

deer calls these deerbox subcommands:

| Command | Purpose | Returns |
|---------|---------|---------|
| `deerbox preflight` | Check dependencies and credentials | `{ ok, errors, warnings, credentialType }` |
| `deerbox config --repo-path <path>` | Load merged config | Full config object |
| `deerbox prepare --repo-path <path> --base-branch <branch> [...]` | Prepare sandbox session | `{ taskId, worktreePath, branch, command, authProxyPid }` |
| `deerbox destroy --task-id <id> --repo-path <path>` | Clean up resources | (void) |

All structured output goes to **stdout** as JSON. Diagnostic messages go to stderr. deer parses stdout with `JSON.parse()` and ignores stderr during normal operation.

## Agent launch sequence

From deer's perspective, launching an agent follows this sequence:

1. **Prepare** -- Call `deerbox prepare` with the repo path, base branch, prompt, model, and config overrides. deerbox creates a worktree, detects the ecosystem, writes sandbox configs, starts the auth proxy, and returns a `PrepareResult` containing a command array and metadata.
2. **Launch tmux** -- Create a tmux session named `deer-<taskId>` running the command from the prepare result.
3. **Poll** -- Start polling the tmux pane for output. Extract the last line of activity and check for idle patterns.
4. **Update state** -- Write status, elapsed time, last activity, and cost to the SQLite database on each poll tick.
5. **Mark idle** -- When the agent finishes (idle detection heuristics match), mark the task as idle in the database.
6. **User action** -- On user action (create PR, retry, delete, etc.), call shared git utilities or `deerbox destroy` as needed.

## Why a subprocess model?

**Clean separation.** deerbox can evolve its internal implementation -- change how worktrees are set up, switch sandbox runtimes, add new ecosystems -- without any changes to the TUI code.

**Standalone usage.** deerbox is fully usable on its own, without any TUI. Users who want a single agent in a script can call `deerbox` directly and get the same sandboxing guarantees.

**Crash isolation.** If deerbox fails during preparation (bad config, missing dependencies, git errors), deer catches the error and displays it in the dashboard. The TUI process is unaffected.

**Testability.** Each component is testable in isolation. deerbox tests do not need to render any UI. TUI tests can mock the deerbox subprocess output.
