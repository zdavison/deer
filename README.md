# deer

> Unattended coding agent.

[Short description — what deer is and what problem it solves]

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
npx @zdavison/deer
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

[Description of the TUI dashboard — task list, log viewer, keyboard shortcuts]

#### Keyboard shortcuts

| Key | Action |
|-----|--------|
| [TBD] | Submit prompt |
| [TBD] | Cancel task |
| [TBD] | View task logs |
| [TBD] | ... |

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
setup_command = ""         # command to run before the agent starts

[network]
allowlist = [...]          # domains the sandbox can reach (replaces default list)

[sandbox]
runtime = "srt"
env_passthrough = []       # host env vars to forward into the sandbox
```

### Repo-local config (`deer.toml`)

Place this in your repo root — it is safe to commit.

```toml
# Override the base branch for this repo
base_branch = "master"

# Run a setup command before the agent starts (e.g. install dependencies)
setup_command = "pnpm install"

# Allow additional domains (merged with the global allowlist)
[network]
allowlist_extra = ["npm.pkg.github.com"]

# Forward additional env vars into the sandbox
[sandbox]
env_passthrough_extra = ["NODE_ENV"]

# Inject extra credentials via the auth proxy
# [[sandbox.proxy_credentials_extra]]
# ...
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
