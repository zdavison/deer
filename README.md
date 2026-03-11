# deer

`deer` is what I consider the bare minimum tool for running multiple `claude` instances.
If you want to parallelize `claude`, but don't like the complexity of agent orchestrators like `multiclaude` and `claude-squad`, `deer` may be for you.

---

## How it works

[High-level explanation: you give deer a prompt, it spins up a sandboxed Claude Code agent in a git worktree, the agent does the work, and deer opens a PR]

---

## Requirements

- [Bun](https://bun.sh) — runtime
- [Claude Code](https://claude.ai/code) (`claude` CLI) — the agent
- [GitHub CLI](https://cli.github.com) (`gh`) — authenticated (`gh auth login`)
- [tmux](https://github.com/tmux/tmux) — session management
- **macOS**: `sandbox-exec` (ships with macOS)
- **Linux**: `bubblewrap` (`bwrap`) — for process sandboxing

---

## Installation

```sh
npx @zdavison/deer install
```

Or install manually via npm/bun/pnpm.

> The installer downloads a prebuilt binary for your platform to `~/.local/bin/deer`.
> If that directory is not in your `PATH`, add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile.

### Supported platforms

| OS    | Arch  |
|-------|-------|
| macOS | x64, arm64 |
| Linux | x64, arm64 |

---

## Authentication

deer uses your Claude credentials to power the agent. It checks for credentials in this order:

1. `CLAUDE_CODE_OAUTH_TOKEN` environment variable
2. `~/.claude/agent-oauth-token` file (plain text token)
3. macOS Keychain (automatically extracted from Claude Code's stored credentials)
4. `ANTHROPIC_API_KEY` environment variable (fallback — API key)

If you have Claude Code installed and logged in, deer will use your subscription automatically on macOS with no extra setup.

---

## Usage

```sh
# Run from inside a git repo
cd your-project
deer
```

[Screenshot or demo GIF]

### Dashboard

The TUI dashboard shows all running and completed agents, their status, recent log lines, and PR links. A prompt input at the bottom lets you launch new agents.

#### Keyboard shortcuts

**Input mode** (default — prompt bar is active):

| Key | Action |
|-----|--------|
| `Enter` | Submit prompt and launch agent |
| `↑` / `↓` | Navigate prompt history |
| `Tab` | Switch focus to agent list |

**Agent list mode** (press `Tab` from input to enter):

| Key | Action |
|-----|--------|
| `Tab` | Switch focus back to input |
| `j` / `↓` | Select next agent |
| `k` / `↑` | Select previous agent |
| `/` | Fuzzy-search agents |
| `Enter` | Attach to agent's tmux session |
| `x` | Kill running agent |
| `r` | Retry (re-run agent from scratch) |
| `p` | Create PR (or open PR if one exists) |
| `u` | Update existing PR |
| `s` | Open a shell in the agent's worktree |
| `l` | Toggle log detail panel |
| `c` | Copy logs to clipboard (when log panel open) |
| `v` | Toggle verbose log mode (when log panel open) |
| `Backspace` | Delete agent entry |
| `q` | Quit (confirms if agents are still running) |

**Search mode** (press `/` from agent list):

| Key | Action |
|-----|--------|
| `j` / `↓` | Next match |
| `k` / `↑` | Previous match |
| `Enter` | Select highlighted match |
| `Esc` | Cancel search |

> Actions that require confirmation (kill, delete with uncommitted work, retry while running) prompt `(y/n)` before executing.

### Attaching to a running agent

Each task runs in a named tmux session. You can attach directly to watch the agent in real time:

```sh
tmux attach -t <session-name>
```

Press `Ctrl+b d` to detach without stopping the agent.

---

## Configuration

Configuration is layered. Later sources override earlier ones:

1. Built-in defaults
2. `~/.config/deer/config.toml` — global config
3. `deer.toml` in your repo root — repo-local config
4. CLI flags

### Global config (`~/.config/deer/config.toml`)

```toml
[defaults]
base_branch = "main"       # default base branch for PRs
timeout_ms = 1800000       # agent timeout in ms (default: 30 minutes)
setup_command = ""         # command to run inside the worktree before the agent starts

[network]
# Replaces the built-in allowlist entirely (see repo-local allowlist_extra to extend it)
allowlist = [
  "api.anthropic.com",
  "registry.npmjs.org",
  # ...
]

[sandbox]
runtime = "srt"            # only "srt" is supported
env_passthrough = []       # host env var names to forward into the sandbox
```

### Repo-local config (`deer.toml`)

Place this in your repo root — it is safe to commit.

```toml
# Override the base branch for this repo
base_branch = "master"

# Run a setup command inside the worktree before the agent starts
setup_command = "pnpm install"

# Extend the network allowlist (merged with global allowlist)
[network]
allowlist_extra = ["npm.pkg.github.com"]

# Forward additional host env vars into the sandbox
[sandbox]
env_passthrough_extra = ["NODE_ENV", "MY_VAR"]

# Inject extra credentials via the host-side auth proxy.
# The sandbox never sees the real token — the proxy injects it as an auth header.
# [[sandbox.proxy_credentials_extra]]
# domain = "your-registry.example.com"
# target = "https://your-registry.example.com"
# [sandbox.proxy_credentials_extra.hostEnv]
# key = "MY_REGISTRY_TOKEN"
# [sandbox.proxy_credentials_extra.headerTemplate]
# authorization = "Bearer ${value}"
# [sandbox.proxy_credentials_extra.sandboxEnv]
# key = "NPM_CONFIG_REGISTRY"
# value = "http://your-registry.example.com"
```

See `deer.toml.example` for a full annotated example.

---

## Security model

deer runs each agent in an isolated sandbox using the [Anthropic Sandbox Runtime (SRT)](https://github.com/anthropic-ai/sandbox-runtime):

- **Filesystem**: the agent can only write to its git worktree; the rest of the filesystem is read-only or inaccessible
- **Network**: outbound traffic is filtered through a domain allowlist; only explicitly permitted domains are reachable
- **Credentials**: API keys and OAuth tokens never enter the sandbox — a host-side MITM proxy intercepts requests to credentialed domains and injects auth headers transparently
- **Environment**: only explicitly listed env vars are forwarded; host secrets are not leaked via the process environment

---

## How PRs are created

[Describe the flow: worktree creation, agent runs on a branch, deer finalizes by pushing the branch and opening a PR via `gh`]

---

## Contributing

[TBD — how to build from source, run tests, submit PRs]

```sh
bun install
bun test
bun run dev
```

---

## License

[TBD]
