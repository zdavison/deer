---
title: Security
---

# Security

deer runs Claude Code with `--dangerously-skip-permissions`, which means the agent can execute any shell command. The sandbox ensures this is safe by isolating the agent from your system.

This section explains how each isolation layer works:

- **[Sandboxing](./sandboxing)** -- filesystem isolation via Anthropic's Sandbox Runtime (SRT), with dynamic home directory blocking and defense-in-depth deny lists.
- **[Network & Auth Proxy](./network)** -- domain-level network filtering and a host-side MITM proxy that injects credentials without exposing them to the sandbox.
- **[Environment Variables](./environment)** -- clean environment launch, risky variable detection, and environment policy management.
