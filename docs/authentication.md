---
title: Authentication
outline: deep
---

# Authentication

deer uses your Claude credentials to power agents. No separate account or API key is required if you already have Claude Code installed and logged in.

## Credential resolution

Credentials are resolved in priority order. The first match wins:

| Priority | Source | Type |
|----------|--------|------|
| 1 | `CLAUDE_CODE_OAUTH_TOKEN` env var | Subscription |
| 2 | `~/.claude/agent-oauth-token` file | Subscription |
| 3 | macOS Keychain (Claude Code's stored credentials) | Subscription |
| 4 | `~/.claude.json` -- `claudeAiOauth.accessToken` | Subscription |
| 5 | `~/.config/claude/config.json` | Subscription |
| 6 | `~/.claude/.credentials.json` | Subscription |
| 7 | `ANTHROPIC_API_KEY` env var | API key |

## Subscription vs API key

- **Subscription (OAuth) is always preferred** over an API key. If both are available, the subscription is used.
- If you have Claude Code installed and logged in on macOS, deer picks up your subscription automatically -- no extra setup needed.
- API key mode works but is billed separately from your Claude subscription.

## How credentials are used

Credentials **never enter the sandbox**. The host-side auth proxy injects them into API requests transparently.

Inside the sandbox, Claude Code sees `ANTHROPIC_BASE_URL=http://api.anthropic.com` (plain HTTP, no token). Requests flow through the SRT proxy to the host-side auth proxy, which adds the real credentials before forwarding to Anthropic's servers over HTTPS.

See [Network & Auth Proxy](/security/network) for the full request flow diagram.

## GitHub authentication

deer uses the GitHub CLI for all GitHub operations (PR creation, issue lookup, git push/pull):

```sh
gh auth token
```

This token is also proxied through the auth proxy -- the sandbox never sees it directly.

To set up GitHub authentication:

```sh
gh auth login
```

## Token expiry

OAuth tokens are checked for expiry at startup by inspecting the JWT `exp` claim. If the token is expired, deer shows a warning.

To refresh an expired token:

```sh
claude /login
```

This re-authenticates with Anthropic and stores a fresh token that deer will pick up on the next launch.
