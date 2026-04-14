---
title: Sandboxing
outline: deep
---

# Sandboxing

## Sandbox Runtime (SRT)

Each deer agent runs inside an isolated sandbox powered by [Anthropic's Sandbox Runtime (SRT)](https://github.com/anthropic-ai/sandbox-runtime). SRT handles cross-platform isolation automatically:

- **macOS** -- `sandbox-exec` with dynamic [Seatbelt](https://www.chromium.org/developers/design-documents/sandbox/osx-sandboxing-design/) profiles
- **Linux** -- [bubblewrap](https://github.com/containers/bubblewrap) (bwrap) with mount namespaces + seccomp

The sandbox gives agents enough access to do real work -- read source code, install dependencies, run tests, commit changes -- while protecting the rest of your system.

---

## Filesystem isolation

The agent gets a strictly scoped view of the filesystem. Only a few locations are writable:

| Path | Access |
|------|--------|
| `~/.local/share/deer/tasks/<taskId>/worktree/` | Read + Write (the agent's git worktree) |
| Per-task Claude config dir | Read + Write |
| `/tmp` | Read + Write |
| Main repo `.git/` directory | Read-only (needed for worktree operations) |
| System binaries and libraries | Read-only |
| `~/.claude*` config files | Read-only |
| Everything else in `$HOME` | Denied |

---

## Dynamic home directory blocking

At sandbox launch, deer enumerates every entry under `$HOME` and denies read access to all of them except:

1. Entries beginning with `.claude` (Claude Code config)
2. Entries that are ancestors of a required path (the worktree, the repo `.git` dir, deer's data dir)

This is done dynamically, so any new dotfiles or credential directories you add (`.ssh`, `.aws`, `.config`, `.docker`, `.npmrc`, etc.) are automatically blocked. No explicit deny list is needed -- anything not allowlisted is blocked.

```
$HOME/
├── .claude/              readable (Claude config)
├── .local/share/deer/    readable (deer data)
│   └── tasks/<id>/
│       └── worktree/     writable
├── .ssh/                 denied
├── .aws/                 denied
├── .config/              denied
└── Documents/            denied
```

---

## Explicit deny list (defense in depth)

Even if a path would be allowed by the dynamic scan, certain sensitive locations are always denied:

- `/etc/shadow`, `/etc/sudoers`, `/root`
- `~/.ssh`, `~/.aws`, `~/.kube`
- Password manager directories (keyrings, pass)
- Other users' home directories
- Sibling repo task directories (prevents cross-agent access)

This defense-in-depth approach means that even a bug in the dynamic scan logic cannot expose these paths.

---

## PTY access

The sandbox is configured with `allowPty: true`. This is required for Claude Code's terminal UI -- without it, Claude cannot render its interactive interface.
