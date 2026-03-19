---
nav_exclude: true
---

# Privileged Daemon for Deerbox Sandboxed Agents

Sandboxed deerbox agents can't perform privileged host operations (opening PRs, pushing branches) because they run inside an SRT sandbox with no host secrets. Today, PR creation happens *after* the agent session ends, driven by the TUI's finalize flow (`src/git/finalize.ts`). The agent itself can never open a PR mid-session, iterate on review feedback, or perform other GitHub operations interactively.

This plan introduces a **host-side privileged daemon** with a **shimmed `gh` CLI** inside the sandbox, so agents can run `gh pr create`, `gh pr view`, etc. exactly as they would on a normal machine — the shim transparently proxies commands to the daemon which executes the real `gh` with real credentials.

## Current Architecture

```
┌─────────────────────────────────────┐
│  SRT Sandbox                        │
│                                     │
│  Claude Code (--dangerously-skip-   │
│   permissions)                      │
│                                     │
│  Can: read/write worktree, git      │
│       commit, run tests             │
│  Cannot: push, open PRs, access     │
│          host secrets               │
└──────────────┬──────────────────────┘
               │ HTTP via Unix socket
┌──────────────▼──────────────────────┐
│  Auth Proxy (auth-proxy-server.mjs) │
│                                     │
│  Injects credentials into HTTP      │
│  requests to allowlisted domains    │
│  (api.anthropic.com, github.com)    │
└─────────────────────────────────────┘
```

PR creation currently happens entirely on the host side in `src/git/finalize.ts`, which:
1. Stages/commits changes
2. Spawns a separate `claude -p` to generate PR metadata
3. Renames the branch
4. Pushes via `git push`
5. Creates the PR via `gh pr create`

This only runs when the TUI triggers finalization — the agent has no say in timing or content.

## Proposed Architecture

```
┌───────────────────────────────────────────┐
│  SRT Sandbox                              │
│                                           │
│  Claude Code                              │
│    │                                      │
│    ├─ "gh pr create --title ..."          │
│    │                                      │
│    ▼                                      │
│  gh shim (first on PATH)                  │
│    │  Serializes argv + stdin + cwd       │
│    │  to JSON, sends over Unix socket     │
│    │                                      │
└────┼──────────────────────────────────────┘
     │ Unix socket
┌────▼──────────────────────────────────────┐
│  deer-daemon (host-side)                  │
│                                           │
│  Receives gh command request              │
│  Validates taskId + allowlisted subcommand│
│  Executes real `gh` with real credentials │
│  Returns stdout/stderr/exit code          │
└───────────────────────────────────────────┘
```

### Why a `gh` shim?

We evaluated three approaches:

| Approach | Discovery | Agent awareness | New components |
|----------|-----------|-----------------|----------------|
| **MCP tools** (`create_pull_request`, etc.) | Auto via `.mcp.json` | None — sees native tools | Daemon + MCP bridge + `.mcp.json` cleanup |
| **Custom CLI + Skill** (`deer pr create`) | Via CLAUDE.md or Skill | Must learn new tool | Daemon + CLI script + skill definition |
| **`gh` shim** | Zero — already on PATH | **None** — thinks `gh` is real | Daemon + shim script |

The `gh` shim wins because:

1. **Zero discovery cost.** Claude Code already knows `gh`. It will run `gh pr create`, `gh pr view --comments`, `gh pr checks`, etc. without any prompting, instructions, or tool definitions.

2. **Zero new abstractions.** No MCP bridge, no `.mcp.json`, no custom CLI, no skills, no CLAUDE.md instructions. The agent doesn't know it's sandboxed.

3. **Full `gh` surface for free.** We don't have to anticipate which operations the agent needs. `gh pr create`, `gh issue list`, `gh run view` — they all work if we allow them. New `gh` features work automatically.

4. **Battle-tested interface.** The `gh` CLI's argument format and output are stable and well-understood by Claude. A custom tool would need its own schema that Claude has to learn.

### What about `git push`?

The same pattern extends to `git`. A `git` shim that intercepts `push` (and passes everything else through to the real sandboxed `git`) would let agents push branches without the auth proxy needing to handle git smart HTTP.

However, `git push` currently works through the auth proxy's GitHub upstream with path filtering. We can keep that for now and only shim `gh`. If the auth proxy approach proves problematic for git push, we can add a git shim later.

## Design

### Component 1: `deer-daemon` (host-side process)

A long-running process that listens on a Unix socket, receives serialized CLI commands from shims, executes them on the host, and returns results.

**Location**: `packages/deerbox/src/daemon/`

**Lifecycle**:
- Started by `session.prepare()` if not already running (check PID file + socket liveness)
- **One daemon per deer data directory** (not per-task) — shared across all active agent sessions
- PID file at `~/.local/share/deer/deer-daemon.pid`
- Socket at `~/.local/share/deer/deer-daemon.sock`
- Graceful shutdown on SIGTERM; auto-exits after configurable idle timeout (e.g. 30 minutes with no connections)

**Protocol**: Newline-delimited JSON over Unix socket (one connection per command, request-response).

Request:
```json
{
  "taskId": "abc123",
  "command": "gh",
  "args": ["pr", "create", "--title", "Fix login bug", "--body", "..."],
  "cwd": "/path/to/worktree",
  "stdin": null
}
```

Response:
```json
{
  "exitCode": 0,
  "stdout": "https://github.com/org/repo/pull/42\n",
  "stderr": ""
}
```

**Security model**:
- **Task scoping**: Each request includes a `taskId`. The daemon validates that the taskId corresponds to a known active session and that `cwd` is within that session's worktree. A compromised agent cannot operate on other agents' worktrees.
- **Command allowlisting**: Only specific commands are proxied (initially just `gh`). Within `gh`, subcommands are allowlisted (see below).
- **No credential leakage**: The daemon executes `gh` with the host's credentials but never sends credentials to the sandbox. The shim only sees stdout/stderr/exit code.

**`gh` subcommand allowlist** (Phase 1):
```
gh pr create
gh pr view
gh pr edit
gh pr checks
gh pr close
gh pr reopen
gh pr comment
gh pr list
gh pr diff
gh pr ready
gh issue view
gh issue list
gh issue comment
gh run list
gh run view
```

Anything not on the allowlist returns exit code 1 with stderr `"deer-daemon: gh subcommand not allowed: <subcommand>"`. The allowlist is configurable via `deer.toml`.

### Component 2: `gh` shim (in-sandbox)

A small script placed early on `PATH` inside the sandbox. When Claude Code runs `gh pr create ...`, it hits the shim instead of the real `gh` (which isn't authenticated inside the sandbox anyway).

**Location**: Materialized to `~/.local/share/deer/tasks/<taskId>/bin/gh` at session prepare time.

**Implementation** (conceptual):
```sh
#!/bin/sh
# deer gh shim — proxies gh commands to deer-daemon
# Reads DEER_DAEMON_SOCK and DEER_TASK_ID from environment

exec node /path/to/gh-shim.mjs "$@"
```

The actual shim is a small Node.js script (same materialization pattern as `auth-proxy-server.mjs`) that:
1. Connects to the Unix socket at `$DEER_DAEMON_SOCK`
2. Sends `{ taskId, command: "gh", args: process.argv.slice(2), cwd: process.cwd(), stdin }` as JSON
3. Reads the response
4. Writes stdout/stderr to the appropriate streams
5. Exits with the returned exit code

From Claude Code's perspective, the shim behaves identically to the real `gh` — same argv, same stdout/stderr, same exit codes.

**PATH injection**: Prepend `~/.local/share/deer/tasks/<taskId>/bin` to PATH in the sandbox env. This ensures the shim is found before any system `gh`.

### Component 3: Integration with session.prepare()

Modifications to `packages/deerbox/src/session.ts`:

1. **Start daemon**: Call `ensureDaemonRunning()` before sandbox launch
2. **Materialize shim**: Write the `gh` shim script to `<taskDir>/bin/gh`, make executable
3. **Inject env vars**: Add `DEER_DAEMON_SOCK` and `DEER_TASK_ID` to sandbox env
4. **Prepend PATH**: Add `<taskDir>/bin` to the front of PATH
5. **Socket access**: Add the daemon socket directory to `allowUnixSockets` in SRT config (it may already be covered by the auth proxy's socket directory)

### Component 4: TUI state integration

When the daemon executes `gh pr create` on behalf of an agent:
- Parse the PR URL from `gh`'s stdout
- Update the SQLite database with the PR URL and branch name for that taskId
- The TUI picks this up via its existing polling mechanism (`useAgentSync`)
- The agent card shows the PR link in real-time

This means the TUI knows about the PR even though the agent created it, not the finalize flow.

## Implementation Plan

### Step 1: Daemon server

Create `packages/deerbox/src/daemon/server.ts`:
- Unix socket server using Node.js `net` module
- Per-connection: read JSON request, validate, execute, return JSON response
- Command routing with allowlist enforcement
- TaskId validation against known sessions
- PID file management
- Idle timeout auto-shutdown

Create `packages/deerbox/src/daemon/server.mjs` (materialized standalone script, like auth-proxy-server.mjs):
- Standalone Node.js server (same pattern as auth proxy)
- Takes socket path + config as argv
- Logs to stdout as JSON lines

### Step 2: Daemon lifecycle management

Create `packages/deerbox/src/daemon/lifecycle.ts`:
- `ensureDaemonRunning()`: Check PID file + socket liveness → start if needed
- `stopDaemon()`: Send SIGTERM
- `registerTask(taskId, worktreePath)`: Tell daemon about a new active session
- `unregisterTask(taskId)`: Session ended

### Step 3: `gh` shim

Create `packages/deerbox/src/daemon/gh-shim.mjs` (inline source, materialized at runtime):
- Connect to Unix socket
- Serialize argv/cwd/stdin to JSON
- Write request, read response
- Pipe stdout/stderr, exit with code
- Must handle large outputs (streaming) and stdin piping

### Step 4: Wire into session.prepare()

Modify `packages/deerbox/src/session.ts`:
- Call `ensureDaemonRunning()` + `registerTask()`
- Materialize shim to `<taskDir>/bin/gh`
- Add `DEER_DAEMON_SOCK`, `DEER_TASK_ID` to sandbox env
- Prepend `<taskDir>/bin` to PATH
- Add socket directory to `allowUnixSockets`

### Step 5: TUI integration

Modify daemon to emit state updates when PR-related commands succeed:
- On `gh pr create` success → parse PR URL, write to SQLite
- On `gh pr edit` success → update PR metadata in SQLite
- Existing TUI polling picks up the changes

### Step 6: Update finalize flow

Modify `src/git/finalize.ts`:
- If a PR already exists (agent created one via the shim), skip PR creation
- Still offer "update PR" as a finalize action
- Keep finalize as a fallback for agents that never open a PR themselves

## Open Questions

1. **Streaming for large outputs.** `gh pr diff` on a large PR can produce megabytes of output. The simple request-response JSON protocol may need buffering or streaming for these cases. Start simple (buffer full response), optimize later if needed.

2. **Stdin forwarding.** Some `gh` commands read from stdin (e.g. `gh pr create --body-file -`). The shim needs to read stdin and include it in the request. This is straightforward but needs to handle binary content and large inputs.

3. **Should we shim `git push` too?** Currently `git push` works through the auth proxy. If we shim it, we can remove the GitHub upstreams from the auth proxy entirely, simplifying the proxy to only handle Anthropic API credentials. Recommendation: keep auth proxy for git push initially, consider consolidating later.

4. **Daemon config hot-reload.** If the user changes `deer.toml` (e.g. adding allowed `gh` subcommands), the daemon should pick up changes without restart. Could watch the config file or accept a SIGHUP to reload.

5. **Should the daemon be shared across repos?** Currently scoped to one deer data directory. If the user runs deer in multiple repos simultaneously, each gets its own daemon. This is simpler but means more processes. For now, one daemon per data dir is fine.

6. **Subcommand allowlist granularity.** `gh pr create` is safe, but `gh repo delete` is dangerous. The allowlist should be conservative by default. Should we also filter flags? E.g., block `--force` on certain commands. Recommendation: start with subcommand-level allowlisting only, add flag filtering if needed.

7. **What about the auth proxy's GitHub upstreams?** The auth proxy currently allows `^/repos/` paths on `api.github.com` and git push paths on `github.com`. With the `gh` shim handling all GitHub CLI operations, we could tighten or remove the `api.github.com` upstream. However, some tools inside the sandbox might make direct HTTP calls to the GitHub API (e.g. `curl`). Keep the auth proxy GitHub upstream for now, but it becomes less critical.
