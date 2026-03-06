import { connect as netConnect, type Socket as NetSocket } from "node:net";
import { resolve as dnsResolve } from "node:dns/promises";

export interface ProxyOptions {
  allowlist: string[];
  /**
   * Reject connections to RFC1918/loopback addresses after DNS resolution.
   * Prevents DNS rebinding attacks where an allowlisted hostname resolves
   * to an internal IP.
   * @default true
   */
  rejectPrivateIPs?: boolean;
  /**
   * Specific port to bind on. Defaults to 0 (OS-assigned ephemeral port).
   * Use this to restore a proxy on the same port after a process restart.
   * @default 0
   */
  port?: number;
}

export interface ProxyHandle {
  port: number;
  stop: () => void;
}

/**
 * Check if a hostname matches an allowlist entry.
 * Supports exact matches and wildcard subdomain patterns (e.g. "*.example.com").
 */
export function matchesAllowlist(hostname: string, allowlist: string[]): boolean {
  const lower = hostname.toLowerCase();
  for (const entry of allowlist) {
    const pattern = entry.toLowerCase();
    if (pattern === lower) return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (lower.endsWith(suffix) && lower.length > suffix.length) return true;
    }
  }
  return false;
}

/**
 * Check if an IP address is in a private/reserved range (RFC1918, loopback, link-local).
 */
export function isPrivateIP(ip: string): boolean {
  // IPv6
  if (ip === "::1") return true;
  if (ip.toLowerCase().startsWith("fe80:")) return true;

  // IPv4
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);

  if (a === 0) return true;       // 0.0.0.0/8
  if (a === 10) return true;      // 10.0.0.0/8
  if (a === 127) return true;     // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16

  return false;
}

/** Per-connection upstream socket tracking */
const upstreams = new WeakMap<object, NetSocket>();

/**
 * Start a filtering HTTP CONNECT proxy.
 *
 * Only allows CONNECT tunnels to hosts in the allowlist.
 * All other requests (plain HTTP GET, non-allowlisted CONNECT) get 403.
 * Resolves DNS before connecting and rejects private IPs to prevent
 * DNS rebinding attacks.
 *
 * Returns a handle with the listening port and a stop function.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const { allowlist, rejectPrivateIPs = true } = options;

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    socket: {
      open() {},

      data(socket, rawData) {
        // If this connection already has an upstream, relay data to it
        const existing = upstreams.get(socket);
        if (existing) {
          existing.write(Buffer.from(rawData));
          return;
        }

        // First data on this connection — parse the HTTP request line
        const data = Buffer.from(rawData).toString();
        const firstLine = data.split("\r\n")[0];
        const parts = firstLine.split(" ");
        const method = parts[0];
        const target = parts[1] ?? "";

        if (method !== "CONNECT") {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.end();
          return;
        }

        // Parse host:port from CONNECT target
        const colonIdx = target.lastIndexOf(":");
        const host = colonIdx > 0 ? target.slice(0, colonIdx) : target;
        const port = colonIdx > 0 ? parseInt(target.slice(colonIdx + 1)) : 443;

        if (!matchesAllowlist(host, allowlist)) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.end();
          return;
        }

        const connectToUpstream = (connectHost: string) => {
          const upstream = netConnect({ host: connectHost, port }, () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            upstreams.set(socket, upstream);
          });

          upstream.on("data", (chunk: Buffer) => {
            socket.write(chunk);
          });

          upstream.on("end", () => {
            socket.end();
          });

          upstream.on("error", () => {
            socket.end();
          });
        };

        if (rejectPrivateIPs) {
          dnsResolve(host).then((addresses) => {
            if (addresses.length === 0 || addresses.some(isPrivateIP)) {
              socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
              socket.end();
              return;
            }
            connectToUpstream(addresses[0]);
          }).catch(() => {
            socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
            socket.end();
          });
        } else {
          connectToUpstream(host);
        }
      },

      drain() {},

      close(socket) {
        const upstream = upstreams.get(socket);
        if (upstream) {
          upstream.destroy();
          upstreams.delete(socket);
        }
      },

      error() {},
    },
  });

  return {
    port: server.port,
    stop() {
      server.stop(true);
    },
  };
}
