---
title: Environment Variables
outline: deep
---

# Environment Variables

## Clean environment

The sandbox is launched with `env -i` -- a completely empty environment. Only an explicit allowlist of variables reaches the sandbox:

- `PATH`, `HOME`, `TERM` -- system essentials
- Variables listed in `env_passthrough` / `env_passthrough_extra` in your config

Host secrets (`AWS_SECRET_ACCESS_KEY`, `DATABASE_URL`, etc.) are never visible to the agent via `/proc/self/environ` or inherited env.

---

## Risk detection

On first run, deerbox scans your shell environment for risky variables. A variable is considered risky if its name matches any of these patterns:

- `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`
- `CREDENTIAL`, `OAUTH`, `PRIVATE_KEY`

The following categories are excluded from risk detection:

- **Known safe variables** -- `PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LANG`, and other standard system variables
- **Proxy-managed variables** -- variables like `ANTHROPIC_API_KEY` that are handled by the auth proxy rather than passed through the environment

---

## Environment policy

Risk detection results are stored as a persistent policy at:

```
~/.local/share/deer/env-policy.json
```

The policy contains two lists:

- **`blocked`** -- variables that are never forwarded into the sandbox
- **`approved`** -- variables that you have explicitly allowed

Review and manage the policy with:

```sh
deerbox env    # or: deer env
```

The policy is consulted on every agent launch. If new risky variables appear in your environment, deerbox will prompt you to classify them.

---

## Best practice

Prefer `proxy_credentials` over `env_passthrough` for secrets. The auth proxy keeps secrets on the host and injects them at the HTTP level -- the agent never sees the raw token value.

Use `env_passthrough` for non-sensitive configuration like `NODE_ENV` or `CI` -- variables that influence tool behavior but do not contain secrets.
