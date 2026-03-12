/**
 * Host-side authenticating MITM proxy.
 *
 * Keeps sensitive credentials (OAuth tokens, API keys) on the host and out of
 * the sandbox. Spawns a standalone Node.js subprocess that listens on a Unix
 * socket, receiving proxy-style HTTP requests forwarded by SRT's built-in
 * proxy for matching domains.
 *
 * We use a real Node.js process (not Bun) because Bun's node:http/node:https
 * polyfills break on long-lived streaming connections (SSE).
 *
 * Flow:
 * 1. Sandbox sets ANTHROPIC_BASE_URL=http://api.anthropic.com (HTTP, not HTTPS)
 * 2. Claude Code sends HTTP request → SRT proxy
 * 3. SRT proxy checks domain allowlist → matches mitmProxy config
 * 4. SRT forwards proxy-style request to our Unix socket
 * 5. Node.js proxy injects real auth headers and makes HTTPS request to upstream
 * 6. Response flows back through the chain
 *
 * Designed to be extensible: each upstream is a { domain, target, headers } pair,
 * so adding new APIs is just a config change.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import authProxySource from "./auth-proxy-server.mjs" with { type: "text" };

export interface ProxyUpstream {
  /** Domain to match (e.g. "api.anthropic.com") */
  domain: string;
  /** Target origin including protocol (e.g. "https://api.anthropic.com") */
  target: string;
  /** Headers to inject into every proxied request */
  headers: Record<string, string>;
}

export interface AuthProxy {
  /** Unix socket path the proxy is listening on */
  socketPath: string;
  /** Domains this proxy handles (for SRT mitmProxy config) */
  domains: string[];
  /** Shut down the proxy server */
  close: () => Promise<void>;
}

/**
 * Materialize the auth proxy server script to disk so Node.js can run it.
 *
 * In dev (bun run dev) the .mjs file is already on disk, but inside a compiled
 * Bun binary __dirname points to the virtual /$bunfs/ filesystem which Node
 * cannot access. We use Bun's `import … with { type: "text" }` to embed the
 * source at compile time, then write it to the deer data dir on first use.
 */
function ensureServerScript(): string {
  const dataDir = join(process.env.HOME ?? "/root", ".local", "share", "deer");
  const scriptPath = join(dataDir, "auth-proxy-server.mjs");
  // Always overwrite so the cached copy stays in sync with the compiled binary.
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(scriptPath, authProxySource, "utf-8");
  return scriptPath;
}

/**
 * Start the authenticating MITM proxy as a Node.js subprocess.
 *
 * Spawns auth-proxy-server.mjs under real Node.js to get correct HTTP
 * streaming behavior. The subprocess communicates via JSON lines on stdout.
 */
export async function startAuthProxy(
  socketPath: string,
  upstreams: ProxyUpstream[],
  onLog?: (message: string) => void,
  onTokenRefresh?: (domain: string) => Promise<Record<string, string> | null>,
): Promise<AuthProxy> {
  const serverScript = ensureServerScript();

  const child = spawn("node", [serverScript, socketPath, JSON.stringify(upstreams)], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Forward stderr for debugging
  child.stderr?.on("data", (data: Buffer) => {
    onLog?.(`[proxy:stderr] ${data.toString().trim()}`);
  });

  // Wait for the "ready" signal from the subprocess
  await new Promise<void>((resolve, reject) => {
    const onExit = (code: number | null) => {
      reject(new Error(`auth-proxy subprocess exited with code ${code} before ready`));
    };
    child.once("exit", onExit);

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.ready) {
          child.removeListener("exit", onExit);
          // Continue reading messages after ready: logs and token refresh requests.
          rl.on("line", (logLine: string) => {
            try {
              const msg = JSON.parse(logLine);
              if (msg.log) {
                onLog?.(msg.log);
              } else if (msg.type === "refresh_request") {
                const respond = (headers: Record<string, string> | null) => {
                  child.stdin!.write(
                    JSON.stringify({ type: "refresh_response", requestId: msg.requestId, headers }) + "\n",
                  );
                };
                if (onTokenRefresh) {
                  onTokenRefresh(msg.domain).then(respond).catch(() => respond(null));
                } else {
                  respond(null);
                }
              }
            } catch { /* ignore malformed */ }
          });
          resolve();
        } else if (msg.log) {
          onLog?.(msg.log);
        }
      } catch { /* ignore malformed */ }
    });

    // Timeout
    setTimeout(() => reject(new Error("auth-proxy subprocess did not become ready in 10s")), 10000);
  });

  return {
    socketPath,
    domains: upstreams.map((u) => u.domain),
    async close() {
      if (!child.killed) {
        child.kill("SIGTERM");
        // Wait for exit with timeout
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 3000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    },
  };
}
