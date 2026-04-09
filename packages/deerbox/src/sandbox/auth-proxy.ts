/**
 * Host-side authenticating MITM proxy.
 *
 * Spawns a standalone Node.js subprocess on a Unix socket. SRT routes
 * matching domains through the socket; the proxy injects real auth headers
 * and forwards to the upstream over HTTPS.
 *
 * Supports daemonized mode where the proxy survives the parent process exit
 * (used by `deerbox prepare` so deer can manage the proxy lifecycle).
 */

import { spawn, execSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, openSync, unlinkSync, readFileSync, chmodSync, renameSync } from "node:fs";
import { createInterface } from "node:readline";

import authProxySource from "./auth-proxy-server.mjs" with { type: "text" };

export type CredentialSource =
  | { type: "agent-token-file"; path: string }
  | { type: "keychain"; service: string }
  | { type: "file"; paths: string[] };

export interface OAuthRefresh {
  /** Ordered credential sources — first match wins */
  sources: CredentialSource[];
  /** Header name to inject (e.g. "authorization") */
  headerName: string;
  /** Template with `${token}` placeholder (e.g. "Bearer ${token}") */
  headerTemplate: string;
}

export interface ProxyUpstream {
  /** Domain to match (e.g. "api.anthropic.com") */
  domain: string;
  /** Target origin including protocol (e.g. "https://api.anthropic.com") */
  target: string;
  /** Headers to inject into every proxied request */
  headers: Record<string, string>;
  /**
   * Regex patterns matched against the request path (without query string).
   * If set, only paths matching at least one pattern are proxied; others get 403.
   * If omitted or empty, all paths are allowed.
   * @example ["^/repos/"] — only allow paths starting with /repos/
   * @example ["\\.git/(info/refs|git-receive-pack)$"] — only git push paths
   */
  allowedPaths?: string[];
  /**
   * If present, enables transparent 401 retry with token refresh.
   * Only set for OAuth-authenticated upstreams (not API key upstreams).
   */
  oauthRefresh?: OAuthRefresh;
}

export interface AuthProxy {
  /** Unix socket path the proxy is listening on */
  socketPath: string;
  /** Domains this proxy handles (for SRT mitmProxy config) */
  domains: string[];
  /** PID of the proxy process */
  pid: number;
  /** Shut down the proxy server */
  close: () => Promise<void>;
}

/**
 * Materialize the auth proxy server script to disk so Node.js can run it.
 */
function ensureServerScript(): string {
  const dir = process.env.DEER_DATA_DIR ?? join(process.env.HOME ?? "/root", ".local", "share", "deer");
  const scriptPath = join(dir, "auth-proxy-server.mjs");

  mkdirSync(dir, { recursive: true });
  writeFileSync(scriptPath, authProxySource, "utf-8");

  return scriptPath;
}

export interface CACert {
  certPath: string;
  keyPath: string;
}

/**
 * Ensure a deer CA certificate exists for TLS MITM proxying.
 * Generates a self-signed CA cert and key using system openssl if they
 * don't already exist. The CA cert is injected into the sandbox so
 * sandboxed processes trust the proxy's per-domain certificates.
 *
 * @param dir - Directory to store the CA cert and key (e.g. deer data dir)
 */
export function ensureCACert(dir: string): CACert {
  const certPath = join(dir, "deer-ca.crt");
  const keyPath = join(dir, "deer-ca.key");

  if (existsSync(certPath) && existsSync(keyPath)) {
    return { certPath, keyPath };
  }

  mkdirSync(dir, { recursive: true });

  const tmpKeyPath = `${keyPath}.tmp`;
  const tmpCertPath = `${certPath}.tmp`;

  execSync(
    `openssl req -x509 -new -nodes -newkey rsa:2048 ` +
    `-keyout ${JSON.stringify(tmpKeyPath)} ` +
    `-sha256 -days 3650 ` +
    `-out ${JSON.stringify(tmpCertPath)} ` +
    `-subj "/CN=Deer Auth Proxy CA"`,
    { stdio: "ignore" },
  );

  chmodSync(tmpKeyPath, 0o600);
  renameSync(tmpKeyPath, keyPath);
  renameSync(tmpCertPath, certPath);

  return { certPath, keyPath };
}

/**
 * Start the authenticating MITM proxy as a Node.js subprocess.
 *
 * @param daemonize - If true, detach the process so it survives parent exit.
 *   A PID file is written at `<socketPath>.pid`. The caller is responsible
 *   for killing the process later.
 */
export async function startAuthProxy(
  socketPath: string,
  upstreams: ProxyUpstream[],
  onLog?: (message: string) => void,
  daemonize = false,
  caCert?: CACert,
): Promise<AuthProxy> {
  const serverScript = ensureServerScript();
  const pidFilePath = `${socketPath}.pid`;

  if (daemonize) {
    // Daemonized mode: no pipes — poll for the socket file to appear.
    // Stderr goes to a temp file so we can report errors if the child crashes.
    const errFile = `${socketPath}.err`;
    const errFd = openSync(errFile, "w");
    const devNull = openSync("/dev/null", "w");
    const child = spawn("node", [
      serverScript,
      socketPath,
      JSON.stringify(upstreams),
      ...(caCert ? [caCert.certPath, caCert.keyPath] : []),
    ], {
      stdio: ["ignore", devNull, errFd],
      detached: true,
    });

    const pid = child.pid!;
    writeFileSync(pidFilePath, String(pid));
    child.unref();

    // Poll for the socket to appear (the server creates it when ready)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (existsSync(socketPath)) {
        try { unlinkSync(errFile); } catch { /* ignore */ }
        return {
          socketPath,
          domains: upstreams.map((u) => u.domain),
          pid,
          async close() {
            try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
          },
        };
      }
      // Check if process died early
      try { process.kill(pid, 0); } catch {
        let detail = "";
        try { detail = readFileSync(errFile, "utf-8").trim(); } catch { /* ignore */ }
        try { unlinkSync(errFile); } catch { /* ignore */ }
        throw new Error(`auth-proxy subprocess exited before ready${detail ? `: ${detail}` : ""}`);
      }
    }
    try { unlinkSync(errFile); } catch { /* ignore */ }
    throw new Error("auth-proxy subprocess did not create socket in 10s");
  }

  // Non-daemonized mode: use pipes for log forwarding
  const child = spawn("node", [
    serverScript,
    socketPath,
    JSON.stringify(upstreams),
    ...(caCert ? [caCert.certPath, caCert.keyPath] : []),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

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
          rl.on("line", (logLine: string) => {
            try {
              const logMsg = JSON.parse(logLine);
              if (logMsg.log) onLog?.(logMsg.log);
            } catch { /* ignore malformed */ }
          });
          resolve();
        } else if (msg.log) {
          onLog?.(msg.log);
        }
      } catch { /* ignore malformed */ }
    });

    setTimeout(() => reject(new Error("auth-proxy subprocess did not become ready in 10s")), 10000);
  });

  return {
    socketPath,
    domains: upstreams.map((u) => u.domain),
    pid: child.pid!,
    async close() {
      if (!child.killed) {
        child.kill("SIGTERM");
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

/**
 * Kill an auth proxy by PID (for cleanup after daemonized start).
 */
export function killAuthProxy(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already dead
  }
}
