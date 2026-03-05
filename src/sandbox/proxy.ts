import { connect as netConnect, type Socket as NetSocket } from "node:net";

export interface ProxyOptions {
  allowlist: string[];
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

/** Per-connection state tracking */
const upstreams = new WeakMap<object, NetSocket>();

/**
 * Start a filtering HTTP CONNECT proxy.
 *
 * Only allows CONNECT tunnels to hosts in the allowlist.
 * All other requests (plain HTTP GET, non-allowlisted CONNECT) get 403.
 *
 * Returns a handle with the listening port and a stop function.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const { allowlist } = options;

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(_socket) {},

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

        // Establish upstream TCP connection
        const upstream = netConnect({ host, port }, () => {
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
      },

      drain(_socket) {},

      close(socket) {
        const upstream = upstreams.get(socket);
        if (upstream) {
          upstream.destroy();
          upstreams.delete(socket);
        }
      },

      error(_socket, _error) {},
    },
  });

  return {
    port: server.port,
    stop() {
      server.stop(true);
    },
  };
}
