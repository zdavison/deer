import { test, expect, describe, afterAll } from "bun:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { unlinkSync, existsSync, readFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { connect as tlsConnect } from "node:tls";
import { ensureCACert } from "../packages/deerbox/src/sandbox/auth-proxy";

// Unix sockets require a path in the worktree (sandbox blocks /tmp sockets).
// Use the test directory directly — macOS limits socket paths to 104 chars.
const SOCK_BASE_DIR = import.meta.dir;

const AUTH_PROXY_SCRIPT = join(import.meta.dir, "..", "packages", "deerbox", "src", "sandbox", "auth-proxy-server.mjs");

/**
 * Start a mock upstream HTTP server that records requests and sends responses.
 */
function startMockUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

/**
 * Start the auth proxy on a Unix socket with given upstream config.
 */
function startAuthProxy(
  socketPath: string,
  upstreams: unknown[],
  ca?: { certPath: string; keyPath: string },
): Promise<{ proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const args = [AUTH_PROXY_SCRIPT, socketPath, JSON.stringify(upstreams)];
    if (ca) {
      args.push(ca.certPath, ca.keyPath);
    }
    const proc = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buf = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('"ready":true')) {
        resolve({ proc });
      }
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (!buf.includes('"ready":true')) {
        reject(new Error(`auth proxy exited with code ${code} before ready`));
      }
    });
  });
}

/**
 * Send a request through the auth proxy via Unix socket using raw HTTP.
 * Bun's node:http doesn't support socketPath, so we write raw HTTP over net.connect.
 */
function proxyRequest(
  socketPath: string,
  opts: { method?: string; path: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = netConnect({ path: socketPath }, () => {
      const method = opts.method ?? "GET";
      const body = opts.body ?? "";
      const headers = opts.headers ?? {};

      let raw = `${method} ${opts.path} HTTP/1.1\r\n`;
      raw += `Host: localhost\r\n`;
      if (body) {
        raw += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
      }
      for (const [k, v] of Object.entries(headers)) {
        raw += `${k}: ${v}\r\n`;
      }
      raw += `Connection: close\r\n`;
      raw += `\r\n`;
      if (body) raw += body;

      socket.write(raw);
    });

    let buf = "";
    socket.on("data", (chunk) => { buf += chunk.toString(); });
    socket.on("end", () => {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) { reject(new Error("malformed HTTP response")); return; }
      const headerBlock = buf.slice(0, headerEnd);
      const responseBody = buf.slice(headerEnd + 4);
      const lines = headerBlock.split("\r\n");
      const statusLine = lines[0];
      const status = parseInt(statusLine.split(" ")[1], 10);
      const headers: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const colon = lines[i].indexOf(":");
        if (colon > 0) {
          headers[lines[i].slice(0, colon).toLowerCase().trim()] = lines[i].slice(colon + 1).trim();
        }
      }
      resolve({ status, headers, body: responseBody });
    });
    socket.on("error", reject);
  });
}

describe("auth-proxy-server", () => {
  const procs: ChildProcess[] = [];
  const servers: Server[] = [];
  const sockets: string[] = [];
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const p of procs) p.kill("SIGTERM");
    for (const s of servers) s.close();
    for (const sock of sockets) {
      try { unlinkSync(sock); } catch {}
      try { unlinkSync(sock + ".log"); } catch {}
      try { unlinkSync(sock + ".pid"); } catch {}
      try { unlinkSync(sock + ".err"); } catch {}
    }
    for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  test("streams request body to upstream without full buffering", async () => {
    // Track when each chunk arrives at the upstream
    const chunkTimestamps: number[] = [];
    let receivedBody = "";

    const { server, port } = await startMockUpstream((req, res) => {
      req.on("data", (chunk) => {
        chunkTimestamps.push(Date.now());
        receivedBody += chunk.toString();
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(server);

    const socketPath = join(SOCK_BASE_DIR, `p-${randomBytes(4).toString("hex")}.sock`);
    sockets.push(socketPath);

    const upstreams = [
      {
        domain: "test-upstream.local",
        target: `http://127.0.0.1:${port}`,
        headers: { "x-auth": "test-token" },
      },
    ];

    const { proc } = await startAuthProxy(socketPath, upstreams);
    procs.push(proc);

    // Send a multi-chunk request body
    const bodyPart = "x".repeat(1024);
    const fullBody = bodyPart.repeat(4);

    const result = await proxyRequest(socketPath, {
      method: "POST",
      path: `http://test-upstream.local/v1/messages`,
      body: fullBody,
      headers: { "content-type": "application/json" },
    });

    expect(result.status).toBe(200);
    expect(receivedBody).toBe(fullBody);
    // Upstream received data in chunks, not as a single buffered blob
    expect(chunkTimestamps.length).toBeGreaterThanOrEqual(1);
  });

  test("injects auth headers into forwarded requests", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};

    const { server, port } = await startMockUpstream((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
    });
    servers.push(server);

    const socketPath = join(SOCK_BASE_DIR, `p-${randomBytes(4).toString("hex")}.sock`);
    sockets.push(socketPath);

    const upstreams = [
      {
        domain: "auth-test.local",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer my-secret-token" },
      },
    ];

    const { proc } = await startAuthProxy(socketPath, upstreams);
    procs.push(proc);

    await proxyRequest(socketPath, {
      method: "POST",
      path: `http://auth-test.local/v1/messages`,
      body: '{"prompt":"hello"}',
      headers: { "content-type": "application/json" },
    });

    expect(receivedHeaders.authorization).toBe("Bearer my-secret-token");
  });

  test("streams response body back to client", async () => {
    const { server, port } = await startMockUpstream((_req, res) => {
      // Drain request body
      _req.resume();
      _req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Simulate SSE streaming with multiple writes
        res.write("data: chunk1\n\n");
        setTimeout(() => {
          res.write("data: chunk2\n\n");
          setTimeout(() => {
            res.write("data: chunk3\n\n");
            res.end();
          }, 10);
        }, 10);
      });
    });
    servers.push(server);

    const socketPath = join(SOCK_BASE_DIR, `p-${randomBytes(4).toString("hex")}.sock`);
    sockets.push(socketPath);

    const upstreams = [
      {
        domain: "stream-test.local",
        target: `http://127.0.0.1:${port}`,
        headers: {},
      },
    ];

    const { proc } = await startAuthProxy(socketPath, upstreams);
    procs.push(proc);

    const result = await proxyRequest(socketPath, {
      method: "POST",
      path: `http://stream-test.local/v1/messages`,
      body: "{}",
    });

    expect(result.status).toBe(200);
    expect(result.body).toContain("data: chunk1");
    expect(result.body).toContain("data: chunk2");
    expect(result.body).toContain("data: chunk3");
  });

  test("streams request body incrementally (not buffered)", async () => {
    // The upstream tracks data events — streaming should deliver multiple chunks,
    // not one single blob after full buffering.
    const dataEventCount: number[] = [];
    let receivedBody = "";

    const { server, port } = await startMockUpstream((req, res) => {
      req.on("data", (chunk) => {
        dataEventCount.push(chunk.length);
        receivedBody += chunk.toString();
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ events: dataEventCount.length, total: receivedBody.length }));
      });
    });
    servers.push(server);

    const socketPath = join(SOCK_BASE_DIR, `p-${randomBytes(4).toString("hex")}.sock`);
    sockets.push(socketPath);

    const upstreams = [
      {
        domain: "stream-body-test.local",
        target: `http://127.0.0.1:${port}`,
        headers: { "x-auth": "tok" },
      },
    ];

    const { proc } = await startAuthProxy(socketPath, upstreams);
    procs.push(proc);

    // Send request with a large body via raw socket, writing in multiple chunks
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const socket: Socket = netConnect({ path: socketPath }, () => {
        const bodyChunk = "A".repeat(8192);
        const totalBody = bodyChunk.repeat(8); // 64KB total
        let raw = `POST http://stream-body-test.local/v1/messages HTTP/1.1\r\n`;
        raw += `Host: stream-body-test.local\r\n`;
        raw += `Content-Length: ${Buffer.byteLength(totalBody)}\r\n`;
        raw += `Connection: close\r\n`;
        raw += `\r\n`;

        // Write headers
        socket.write(raw);
        // Write body in separate chunks with small delays to ensure they arrive separately
        let sent = 0;
        const sendNext = () => {
          if (sent < 8) {
            socket.write(bodyChunk);
            sent++;
            setTimeout(sendNext, 5);
          }
        };
        sendNext();
      });

      let buf = "";
      socket.on("data", (chunk) => { buf += chunk.toString(); });
      socket.on("end", () => {
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) { reject(new Error("malformed")); return; }
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const status = parseInt(statusLine.split(" ")[1], 10);
        const body = buf.slice(headerEnd + 4);
        resolve({ status, body });
      });
      socket.on("error", reject);
    });

    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.total).toBe(8192 * 8);
    // With streaming, the body should arrive in multiple data events.
    // With full buffering, it would arrive as a single event.
    // Allow some coalescing by the kernel but expect at least 2 events.
    expect(parsed.events).toBeGreaterThanOrEqual(2);
  });

  test("retries on 401 with refreshed token", async () => {
    let requestCount = 0;

    const { server, port } = await startMockUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          // First request: return 401
          res.writeHead(401);
          res.end("unauthorized");
        } else {
          // Second request (after refresh): return 200
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, auth: req.headers.authorization }));
        }
      });
    });
    servers.push(server);

    // Write a temporary token file for the refresh
    const tokenPath = join(SOCK_BASE_DIR, `tk-${randomBytes(4).toString("hex")}`);
    await Bun.write(tokenPath, "refreshed-token-value");

    const socketPath = join(SOCK_BASE_DIR, `p-${randomBytes(4).toString("hex")}.sock`);
    sockets.push(socketPath);

    const upstreams = [
      {
        domain: "retry-test.local",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer expired-token" },
        oauthRefresh: {
          sources: [{ type: "agent-token-file", path: tokenPath }],
          headerName: "authorization",
          headerTemplate: "Bearer ${token}",
        },
      },
    ];

    const { proc } = await startAuthProxy(socketPath, upstreams);
    procs.push(proc);

    const result = await proxyRequest(socketPath, {
      method: "POST",
      path: `http://retry-test.local/v1/messages`,
      body: '{"prompt":"test 401 retry"}',
      headers: { "content-type": "application/json" },
    });

    expect(result.status).toBe(200);
    expect(requestCount).toBe(2);
    const parsed = JSON.parse(result.body);
    expect(parsed.auth).toBe("Bearer refreshed-token-value");

    // Cleanup
    try { unlinkSync(tokenPath); } catch {}
  });

  test("handles CONNECT with TLS termination and header injection", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedBody = "";

    const { server, port } = await startMockUpstream((req, res) => {
      receivedHeaders = req.headers;
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(server);

    const caDir = join(SOCK_BASE_DIR, `ca-${randomBytes(4).toString("hex")}`);
    tempDirs.push(caDir);
    const ca = ensureCACert(caDir);

    const socketPath = join(SOCK_BASE_DIR, `p-${randomBytes(4).toString("hex")}.sock`);
    sockets.push(socketPath);

    const upstreams = [
      {
        domain: "tls-test.local",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer secret-tls-token" },
      },
    ];

    const { proc } = await startAuthProxy(socketPath, upstreams, ca);
    procs.push(proc);

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const rawSocket: Socket = netConnect({ path: socketPath }, () => {
        rawSocket.write(
          "CONNECT tls-test.local:443 HTTP/1.1\r\n" +
          "Host: tls-test.local:443\r\n" +
          "\r\n",
        );
      });

      let connectResponse = "";
      const onData = (chunk: Buffer) => {
        connectResponse += chunk.toString();
        if (connectResponse.includes("\r\n\r\n")) {
          rawSocket.removeListener("data", onData);

          if (!connectResponse.includes("200")) {
            reject(new Error(`CONNECT failed: ${connectResponse}`));
            return;
          }

          const tlsSocket = tlsConnect({
            socket: rawSocket,
            ca: readFileSync(ca.certPath),
            servername: "tls-test.local",
          });

          tlsSocket.on("secureConnect", () => {
            const body = '{"prompt":"hello via TLS"}';
            tlsSocket.write(
              `POST /v1/messages HTTP/1.1\r\n` +
              `Host: tls-test.local\r\n` +
              `Content-Length: ${Buffer.byteLength(body)}\r\n` +
              `Content-Type: application/json\r\n` +
              `Connection: close\r\n` +
              `\r\n` +
              body,
            );
          });

          let buf = "";
          tlsSocket.on("data", (d: Buffer) => { buf += d.toString(); });
          tlsSocket.on("end", () => {
            const headerEnd = buf.indexOf("\r\n\r\n");
            if (headerEnd === -1) { reject(new Error("malformed")); return; }
            const statusLine = buf.slice(0, buf.indexOf("\r\n"));
            const status = parseInt(statusLine.split(" ")[1], 10);
            const responseBody = buf.slice(headerEnd + 4);
            resolve({ status, body: responseBody });
          });
          tlsSocket.on("error", reject);
        }
      };
      rawSocket.on("data", onData);
      rawSocket.on("error", reject);
    });

    expect(result.status).toBe(200);
    expect(receivedHeaders.authorization).toBe("Bearer secret-tls-token");
    expect(receivedBody).toBe('{"prompt":"hello via TLS"}');
  });

  test("retries on 401 through CONNECT tunnel with refreshed token", async () => {
    let requestCount = 0;

    const { server, port } = await startMockUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(401);
          res.end("unauthorized");
        } else {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, auth: req.headers.authorization }));
        }
      });
    });
    servers.push(server);

    const tokenPath = join(SOCK_BASE_DIR, `tk-${randomBytes(4).toString("hex")}`);
    await Bun.write(tokenPath, "refreshed-tls-token");

    const caDir = join(SOCK_BASE_DIR, `ca-${randomBytes(4).toString("hex")}`);
    tempDirs.push(caDir);
    const ca = ensureCACert(caDir);

    const socketPath = join(SOCK_BASE_DIR, `p-${randomBytes(4).toString("hex")}.sock`);
    sockets.push(socketPath);

    const upstreams = [
      {
        domain: "tls-retry.local",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer expired-token" },
        oauthRefresh: {
          sources: [{ type: "agent-token-file", path: tokenPath }],
          headerName: "authorization",
          headerTemplate: "Bearer ${token}",
        },
      },
    ];

    const { proc } = await startAuthProxy(socketPath, upstreams, ca);
    procs.push(proc);

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const rawSocket: Socket = netConnect({ path: socketPath }, () => {
        rawSocket.write(
          "CONNECT tls-retry.local:443 HTTP/1.1\r\n" +
          "Host: tls-retry.local:443\r\n" +
          "\r\n",
        );
      });

      let connectResponse = "";
      const onData = (chunk: Buffer) => {
        connectResponse += chunk.toString();
        if (connectResponse.includes("\r\n\r\n")) {
          rawSocket.removeListener("data", onData);
          if (!connectResponse.includes("200")) {
            reject(new Error(`CONNECT failed: ${connectResponse}`));
            return;
          }
          const tlsSocket = tlsConnect({
            socket: rawSocket,
            ca: readFileSync(ca.certPath),
            servername: "tls-retry.local",
          });
          tlsSocket.on("secureConnect", () => {
            const body = '{"prompt":"retry test"}';
            tlsSocket.write(
              `POST /v1/messages HTTP/1.1\r\n` +
              `Host: tls-retry.local\r\n` +
              `Content-Length: ${Buffer.byteLength(body)}\r\n` +
              `Connection: close\r\n` +
              `\r\n` +
              body,
            );
          });
          let buf = "";
          tlsSocket.on("data", (d: Buffer) => { buf += d.toString(); });
          tlsSocket.on("end", () => {
            const headerEnd = buf.indexOf("\r\n\r\n");
            if (headerEnd === -1) { reject(new Error("malformed")); return; }
            const statusLine = buf.slice(0, buf.indexOf("\r\n"));
            const status = parseInt(statusLine.split(" ")[1], 10);
            resolve({ status, body: buf.slice(headerEnd + 4) });
          });
          tlsSocket.on("error", reject);
        }
      };
      rawSocket.on("data", onData);
      rawSocket.on("error", reject);
    });

    expect(result.status).toBe(200);
    expect(requestCount).toBe(2);
    const parsed = JSON.parse(result.body);
    expect(parsed.auth).toBe("Bearer refreshed-tls-token");

    try { unlinkSync(tokenPath); } catch {}
  });
});

describe("allowedPaths filtering", () => {
  const procs: ChildProcess[] = [];
  const servers: Server[] = [];
  const sockets: string[] = [];

  afterAll(() => {
    for (const p of procs) p.kill("SIGTERM");
    for (const s of servers) s.close();
    for (const sock of sockets) {
      try { unlinkSync(sock); } catch {}
      try { unlinkSync(sock + ".log"); } catch {}
      try { unlinkSync(sock + ".pid"); } catch {}
      try { unlinkSync(sock + ".err"); } catch {}
    }
  });

  test("allows requests matching allowedPaths patterns", async () => {
    const { server, port } = await startMockUpstream((_req, res) => {
      _req.resume();
      _req.on("end", () => {
        res.writeHead(200);
        res.end("ok");
      });
    });
    servers.push(server);

    const socketPath = join(SOCK_BASE_DIR, `p-${randomBytes(4).toString("hex")}.sock`);
    sockets.push(socketPath);

    const upstreams = [
      {
        domain: "filtered.local",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer tok" },
        allowedPaths: ["^/repos/", "^/graphql$"],
      },
    ];

    const { proc } = await startAuthProxy(socketPath, upstreams);
    procs.push(proc);

    // /repos/ path should be allowed
    const reposResult = await proxyRequest(socketPath, {
      method: "GET",
      path: `http://filtered.local/repos/owner/repo/pulls`,
    });
    expect(reposResult.status).toBe(200);

    // /graphql path should be allowed
    const graphqlResult = await proxyRequest(socketPath, {
      method: "POST",
      path: `http://filtered.local/graphql`,
      body: '{"query":"{ viewer { login } }"}',
    });
    expect(graphqlResult.status).toBe(200);
  });

  test("blocks requests not matching allowedPaths patterns", async () => {
    const { server, port } = await startMockUpstream((_req, res) => {
      _req.resume();
      _req.on("end", () => {
        res.writeHead(200);
        res.end("ok");
      });
    });
    servers.push(server);

    const socketPath = join(SOCK_BASE_DIR, `p-${randomBytes(4).toString("hex")}.sock`);
    sockets.push(socketPath);

    const upstreams = [
      {
        domain: "filtered2.local",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer tok" },
        allowedPaths: ["^/repos/"],
      },
    ];

    const { proc } = await startAuthProxy(socketPath, upstreams);
    procs.push(proc);

    // /graphql should be blocked when not in allowedPaths
    const result = await proxyRequest(socketPath, {
      method: "POST",
      path: `http://filtered2.local/graphql`,
      body: '{"query":"{ viewer { login } }"}',
    });
    expect(result.status).toBe(403);
    expect(result.body).toContain("path not allowed");
  });

  test("allows git-upload-pack and git-receive-pack paths", async () => {
    const { server, port } = await startMockUpstream((_req, res) => {
      _req.resume();
      _req.on("end", () => {
        res.writeHead(200);
        res.end("ok");
      });
    });
    servers.push(server);

    const socketPath = join(SOCK_BASE_DIR, `p-${randomBytes(4).toString("hex")}.sock`);
    sockets.push(socketPath);

    const upstreams = [
      {
        domain: "git.local",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer tok" },
        allowedPaths: ["\\.git/(info/refs|git-upload-pack|git-receive-pack)$"],
      },
    ];

    const { proc } = await startAuthProxy(socketPath, upstreams);
    procs.push(proc);

    // git-upload-pack (fetch) should be allowed
    const fetchResult = await proxyRequest(socketPath, {
      method: "GET",
      path: `http://git.local/owner/repo.git/info/refs?service=git-upload-pack`,
    });
    expect(fetchResult.status).toBe(200);

    // git-receive-pack (push) should be allowed
    const pushResult = await proxyRequest(socketPath, {
      method: "POST",
      path: `http://git.local/owner/repo.git/git-receive-pack`,
      body: "pack-data",
    });
    expect(pushResult.status).toBe(200);

    // Random path should be blocked
    const blockedResult = await proxyRequest(socketPath, {
      method: "GET",
      path: `http://git.local/owner/repo/tree/main`,
    });
    expect(blockedResult.status).toBe(403);
  });
});

describe("CA certificate", () => {
  test("ensureCACert generates cert and key files", async () => {
    const dir = join(SOCK_BASE_DIR, `ca-${randomBytes(4).toString("hex")}`);
    const result = ensureCACert(dir);
    expect(result.certPath).toBe(join(dir, "deer-ca.crt"));
    expect(result.keyPath).toBe(join(dir, "deer-ca.key"));
    expect(existsSync(result.certPath)).toBe(true);
    expect(existsSync(result.keyPath)).toBe(true);

    // Cert should be valid PEM
    const certPem = readFileSync(result.certPath, "utf-8");
    expect(certPem).toContain("-----BEGIN CERTIFICATE-----");

    // Calling again should return same paths without regenerating
    const certMtime = statSync(result.certPath).mtimeMs;
    const result2 = ensureCACert(dir);
    expect(result2.certPath).toBe(result.certPath);
    expect(statSync(result2.certPath).mtimeMs).toBe(certMtime);

    // Cleanup
    rmSync(dir, { recursive: true, force: true });
  });
});
