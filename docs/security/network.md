---
title: Network & Auth Proxy
outline: deep
---

# Network & Auth Proxy

## Domain allowlist

All outbound network traffic goes through SRT's HTTP proxy. Only domains on the allowlist are reachable -- everything else is blocked.

The built-in allowlist covers what Claude Code needs to function:

```
api.anthropic.com
claude.ai
statsig.anthropic.com
sentry.io
registry.npmjs.org
github.com
api.github.com
```

You can extend it per-repo in `deer.toml`:

```toml
[network]
allowlist_extra = ["npm.pkg.github.com", "pypi.org"]
```

Or replace it entirely in your global `~/.config/deer/config.toml`.

---

## The auth proxy (MITM)

The key security property: **credentials never enter the sandbox.**

Instead, deer runs a host-side authenticating proxy that intercepts requests to credentialed domains and injects the real auth headers transparently.

```
┌─────────────────────────────────────────────────────────┐
│  Sandbox                                                 │
│                                                         │
│  Claude Code ──HTTP (no token)──> SRT Proxy             │
│  (no credentials)                 (domain filter)       │
│                                                         │
└───────────────────────────────────┼─────────────────────┘
                                    │ forwarded via Unix socket
                              ┌─────v─────────────────────┐
                              │  Auth Proxy (host process) │
                              │  Injects real credentials: │
                              │  Authorization: Bearer ••• │
                              └─────┼─────────────────────┘
                                    │ HTTPS + real token
                              ┌─────v─────────────────────┐
                              │  api.anthropic.com         │
                              └───────────────────────────┘
```

### Step-by-step flow

1. The sandbox sets `ANTHROPIC_BASE_URL=http://api.anthropic.com` (plain HTTP, no token).
2. Claude Code sends API requests without auth headers -- it has no credentials.
3. The SRT proxy receives the request and checks `api.anthropic.com` against the domain allowlist -- it matches.
4. Because the domain is in the MITM config, SRT forwards the request to the auth proxy's Unix socket instead of making the request directly.
5. The auth proxy (running on the host, outside the sandbox) reads the real OAuth token from the host environment.
6. It injects the `Authorization` header and makes the real HTTPS request to `api.anthropic.com`.
7. The response flows back through the chain to Claude Code.

---

## Unix socket security

The Unix socket is the only channel between the sandbox and the auth proxy. The sandbox can make HTTP requests through it, but it cannot read the token value -- the socket only speaks HTTP. There is no mechanism for the sandboxed process to extract credentials from the proxy.

---

## GitHub proxy

GitHub API and git operations are also proxied through the auth proxy:

- **`api.github.com`** -- only `/repos/` and `/graphql` paths are allowed
- **`github.com`** -- only git smart HTTP paths are allowed (`info/refs`, `git-upload-pack`, `git-receive-pack`)

The real GitHub token is injected by the auth proxy, just like the Anthropic token. The agent never sees the token.

---

## TLS MITM

For HTTPS upstreams, the auth proxy terminates TLS using per-domain certificates:

- Certificates are signed by a deer CA cert at `~/.local/share/deer/tls/deer-ca.crt`
- The CA cert is injected into the sandbox via `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, and `SSL_CERT_FILE`
- The CA cert is generated once and persists across sessions

This allows the proxy to inspect and modify HTTPS traffic (to inject credentials) while maintaining a valid TLS chain from the sandbox's perspective.

---

## OAuth refresh

The auth proxy transparently handles `401` responses by refreshing the OAuth token and retrying the request. This means long-running agents do not fail when their token expires mid-session.
