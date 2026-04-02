# OAuth Token Refresh in the Auth Proxy

**Date:** 2026-04-02  
**Status:** Approved

## Problem

OAuth tokens injected by the MITM auth proxy can expire mid-session (estimated lifetime: ≤1 hour). The proxy currently bakes credentials as static header values at startup via `process.argv[3]` — there is no mechanism to refresh them. When the token expires, all API calls from Claude inside the sandbox fail with 401.

## Goals

- Transparent retry: Claude never sees a 401 caused by token expiry
- Self-contained: the proxy handles credential refresh without host-side IPC or file polling
- Scope: OAuth tokens only — API keys do not expire and are unchanged

## Non-goals

- Proactive / scheduled refresh
- Refreshing non-Anthropic upstreams (e.g. GitHub)
- Handling 401s caused by reasons other than token expiry

## Design

### Principle

The auth proxy is already the credential authority. Giving it the ability to re-resolve credentials on demand is architecturally natural and requires no new IPC, sockets, or host-side watchers.

### Files changed

| File | Change |
|------|--------|
| `packages/deerbox/src/sandbox/auth-proxy.ts` | Add `oauthRefresh` field to `ProxyUpstream` type |
| `packages/deerbox/src/proxy.ts` | Populate `oauthRefresh` for Anthropic OAuth upstreams |
| `packages/deerbox/src/sandbox/auth-proxy-server.mjs` | Buffer request bodies; retry on 401; resolve credentials from sources |

### Data model

`ProxyUpstream` gains one optional field:

```typescript
oauthRefresh?: {
  sources: CredentialSource[];  // ordered, first match wins
  headerName: string;           // e.g. "authorization"
  headerTemplate: string;       // e.g. "Bearer ${token}"
}

type CredentialSource =
  | { type: "agent-token-file"; path: string }
  | { type: "keychain"; service: string }        // macOS only
  | { type: "file"; paths: string[] }
```

Static upstreams (e.g. GitHub) receive no `oauthRefresh` — behaviour is unchanged.

### `proxy.ts` — populating `oauthRefresh`

`resolveProxyUpstreams()` already knows the winning credential type. When it is OAuth, it adds `oauthRefresh` to the Anthropic upstream:

```typescript
oauthRefresh: {
  sources: [
    { type: "agent-token-file", path: join(homeDir, ".claude", "agent-oauth-token") },
    ...(process.platform === "darwin"
      ? [{ type: "keychain", service: "Claude Code-credentials" }]
      : []),
    { type: "file", paths: [
        join(homeDir, ".claude.json"),
        join(homeDir, ".config", "claude", "config.json"),
        join(homeDir, ".claude", ".credentials.json"),
    ]},
  ],
  headerName: "authorization",
  headerTemplate: "Bearer ${token}",
}
```

Source order mirrors `resolveCredentials()` in `packages/shared/src/credentials.ts`.

### `auth-proxy-server.mjs` — request buffering and 401 retry

**Request body buffering:** Before forwarding, all request body chunks are collected into a `Buffer`. Claude's API request bodies are small JSON payloads (a few KB), so memory impact is negligible.

**On 401 from upstream:**

1. Check whether the upstream has `oauthRefresh`. If not, pass the 401 through unchanged.
2. Acquire a per-domain refresh lock (a `Promise` stored in a `Map`). If a refresh is already in progress for this domain, wait for it to complete and use the already-updated headers rather than triggering a redundant second refresh.
3. Re-resolve the token from sources in order:
   - `agent-token-file`: `fs.readFileSync(path, "utf-8").trim()`
   - `keychain` (macOS): `child_process.execSync("security find-generic-password -s <service> -w")` → parse JSON → `.claudeAiOauth.accessToken`
   - `file`: `JSON.parse(fs.readFileSync(path))?.claudeAiOauth?.accessToken` for each path in order
4. Update the in-memory `upstream.headers[headerName]` with the new value.
5. Retry the request exactly once using the buffered body and updated headers.
6. Return the retry response to the client regardless of status — no further retries.

**Concurrency:** The per-domain lock ensures that N simultaneous requests hitting 401 at the same time trigger exactly one credential refresh. All waiters use the refreshed headers.

### Token resolution in the proxy

Mirrors `resolveCredentials()` but implemented in plain Node.js (no Bun APIs):
- File reads: `fs.readFileSync` + `JSON.parse`
- Keychain: `child_process.execSync` (synchronous is fine — this is an exceptional path)
- If no source yields a token, the 401 is passed through to the client

## Error handling

| Scenario | Behaviour |
|----------|-----------|
| Token refresh succeeds, retry succeeds | Client receives the successful response |
| Token refresh succeeds, retry still 401 | 401 passed through to client |
| Token refresh fails (no token found) | Original 401 passed through to client |
| Upstream error on retry | 502 returned to client |

## Testing

- Unit: mock upstream that returns 401 on first call, 200 on second — verify transparent retry
- Unit: two concurrent requests hitting 401 — verify single refresh, both succeed
- Unit: no `oauthRefresh` on upstream — verify 401 passed through unchanged
- Unit: all credential sources exhausted — verify 401 passed through unchanged
- Integration: full session with a token that expires mid-run (manual / staging only)
