import { test, expect, describe, afterEach, afterAll } from "bun:test";
import { startAuthProxy } from "../../packages/deerbox/src/index";
import type { ProxyUpstream } from "../../packages/deerbox/src/index";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

// Use worktree-relative dirs so Unix sockets work in sandboxed environments.
// Also set DEER_DATA_DIR so auth-proxy can write its server script.
const testDataDir = mkdtempSync(join(import.meta.dir, "../../.test-proxy-data-"));
process.env.DEER_DATA_DIR = testDataDir;

afterAll(() => {
  delete process.env.DEER_DATA_DIR;
  try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
});

describe("auth-proxy (Unix socket MITM)", () => {
  const cleanups: (() => Promise<void>)[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const fn of cleanups) await fn();
    cleanups.length = 0;
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(import.meta.dir, "../../.test-sock-"));
    tmpDirs.push(d);
    return d;
  }

  /** Start a mock upstream HTTP server that echoes request headers as JSON. */
  function startMockUpstream(): Promise<{ port: number; server: Server }> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: req.url, headers: req.headers }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
        resolve({ port: addr.port, server });
      });
    });
  }

  /** Send a proxy-style HTTP request to a Unix socket (like SRT does). */
  function proxyRequest(
    socketPath: string,
    fullUrl: string,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const host = new URL(fullUrl).host;
      const socket = connect(socketPath, () => {
        socket.write(
          `GET ${fullUrl} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
        );
      });
      let data = "";
      socket.on("data", (c) => (data += c));
      socket.on("end", () => {
        const [head, ...bodyParts] = data.split("\r\n\r\n");
        const statusLine = head.split("\r\n")[0];
        const status = parseInt(statusLine.split(" ")[1], 10);
        const bodyStr = bodyParts.join("\r\n\r\n");
        try {
          resolve({ status, body: JSON.parse(bodyStr) });
        } catch {
          resolve({ status, body: bodyStr });
        }
      });
      socket.on("error", reject);
    });
  }

  test("injects auth headers and proxies to upstream via Unix socket", async () => {
    const dir = await makeTmpDir();
    const mock = await startMockUpstream();
    const socketPath = join(dir, "auth.sock");

    const upstream: ProxyUpstream = {
      domain: "api.example.com",
      target: `http://127.0.0.1:${mock.port}`,
      headers: { "x-api-key": "secret-token-123" },
    };

    const proxy = await startAuthProxy(socketPath, [upstream]);
    cleanups.push(() => proxy.close());

    const { status, body } = await proxyRequest(
      socketPath,
      "http://api.example.com/v1/messages",
    );

    expect(status).toBe(200);
    expect(body.path).toBe("/v1/messages");
    expect(body.headers["x-api-key"]).toBe("secret-token-123");
  });

  test("returns 502 for unmatched domain", async () => {
    const dir = await makeTmpDir();
    const socketPath = join(dir, "auth.sock");

    const proxy = await startAuthProxy(socketPath, []);
    cleanups.push(() => proxy.close());

    const { status } = await proxyRequest(
      socketPath,
      "http://unknown.example.com/path",
    );
    expect(status).toBe(502);
  });

  test("multiple upstreams route by domain", async () => {
    const dir = await makeTmpDir();
    const mock1 = await startMockUpstream();
    const mock2 = await startMockUpstream();
    const socketPath = join(dir, "auth.sock");

    const proxy = await startAuthProxy(socketPath, [
      {
        domain: "api-a.example.com",
        target: `http://127.0.0.1:${mock1.port}`,
        headers: { authorization: "Bearer token-a" },
      },
      {
        domain: "api-b.example.com",
        target: `http://127.0.0.1:${mock2.port}`,
        headers: { authorization: "Bearer token-b" },
      },
    ]);
    cleanups.push(() => proxy.close());

    const resA = await proxyRequest(socketPath, "http://api-a.example.com/hello");
    expect(resA.body.path).toBe("/hello");
    expect(resA.body.headers.authorization).toBe("Bearer token-a");

    const resB = await proxyRequest(socketPath, "http://api-b.example.com/world");
    expect(resB.body.path).toBe("/world");
    expect(resB.body.headers.authorization).toBe("Bearer token-b");
  });

  test("reports correct domains", async () => {
    const dir = await makeTmpDir();
    const socketPath = join(dir, "auth.sock");

    const proxy = await startAuthProxy(socketPath, [
      { domain: "a.com", target: "https://a.com", headers: {} },
      { domain: "b.com", target: "https://b.com", headers: {} },
    ]);
    cleanups.push(() => proxy.close());

    expect(proxy.domains).toEqual(["a.com", "b.com"]);
    expect(proxy.socketPath).toBe(socketPath);
  });

  test("allowedPaths blocks disallowed paths with 403", async () => {
    const dir = await makeTmpDir();
    const mock = await startMockUpstream();
    const socketPath = join(dir, "auth.sock");

    const proxy = await startAuthProxy(socketPath, [
      {
        domain: "api.example.com",
        target: `http://127.0.0.1:${mock.port}`,
        headers: { authorization: "Bearer token" },
        allowedPaths: ["^/repos/"],
      },
    ]);
    cleanups.push(() => proxy.close());

    const allowed = await proxyRequest(socketPath, "http://api.example.com/repos/owner/repo/pulls");
    expect(allowed.status).toBe(200);

    const blocked = await proxyRequest(socketPath, "http://api.example.com/user");
    expect(blocked.status).toBe(403);

    const blockedRoot = await proxyRequest(socketPath, "http://api.example.com/orgs/something");
    expect(blockedRoot.status).toBe(403);
  });

  test("allowedPaths allows matching suffix patterns", async () => {
    const dir = await makeTmpDir();
    const mock = await startMockUpstream();
    const socketPath = join(dir, "auth.sock");

    const proxy = await startAuthProxy(socketPath, [
      {
        domain: "github.com",
        target: `http://127.0.0.1:${mock.port}`,
        headers: { authorization: "Bearer token" },
        allowedPaths: ["\\.git/(info/refs|git-receive-pack)$"],
      },
    ]);
    cleanups.push(() => proxy.close());

    const push = await proxyRequest(socketPath, "http://github.com/owner/repo.git/git-receive-pack");
    expect(push.status).toBe(200);

    const refs = await proxyRequest(socketPath, "http://github.com/owner/repo.git/info/refs");
    expect(refs.status).toBe(200);

    const blocked = await proxyRequest(socketPath, "http://github.com/owner/repo");
    expect(blocked.status).toBe(403);
  });

  test("close() removes socket file", async () => {
    const dir = await makeTmpDir();
    const socketPath = join(dir, "auth.sock");

    const proxy = await startAuthProxy(socketPath, []);
    await proxy.close();

    // Socket file should be cleaned up
    const exists = await Bun.file(socketPath).exists();
    expect(exists).toBe(false);
  });

  /** Send a POST request with a body through the proxy. */
  function proxyPost(
    socketPath: string,
    fullUrl: string,
    body: string,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const host = new URL(fullUrl).host;
      const bodyBuf = Buffer.from(body, "utf-8");
      const socket = connect(socketPath, () => {
        socket.write(
          `POST ${fullUrl} HTTP/1.1\r\n` +
            `Host: ${host}\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${bodyBuf.length}\r\n` +
            `Connection: close\r\n\r\n`,
        );
        socket.write(bodyBuf);
      });
      let data = "";
      socket.on("data", (c) => (data += c));
      socket.on("end", () => {
        const [head, ...bodyParts] = data.split("\r\n\r\n");
        const statusLine = head.split("\r\n")[0];
        const status = parseInt(statusLine.split(" ")[1], 10);
        const bodyStr = bodyParts.join("\r\n\r\n");
        try {
          resolve({ status, body: JSON.parse(bodyStr) });
        } catch {
          resolve({ status, body: bodyStr });
        }
      });
      socket.on("error", reject);
    });
  }

  test("retries transparently on 401 using oauthRefresh agent-token-file", async () => {
    const dir = await makeTmpDir();
    const tokenFile = join(dir, "oauth-token");
    await Bun.write(tokenFile, "new-token-xyz");

    let callCount = 0;
    const { port } = await new Promise<{ port: number }>((resolve) => {
      const s = createServer((req, res) => {
        callCount++;
        if (callCount === 1) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("Unauthorized");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ path: req.url, headers: req.headers }));
        }
      });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as { port: number };
        cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
        resolve({ port: addr.port });
      });
    });

    const socketPath = join(dir, "auth.sock");
    const upstream: ProxyUpstream = {
      domain: "api.example.com",
      target: `http://127.0.0.1:${port}`,
      headers: { authorization: "Bearer old-token" },
      oauthRefresh: {
        sources: [{ type: "agent-token-file", path: tokenFile }],
        headerName: "authorization",
        headerTemplate: "Bearer ${token}",
      },
    };

    const proxy = await startAuthProxy(socketPath, [upstream]);
    cleanups.push(() => proxy.close());

    const result = await proxyPost(socketPath, "http://api.example.com/v1/messages", '{"model":"claude"}');

    expect(result.status).toBe(200);
    expect(result.body.headers.authorization).toBe("Bearer new-token-xyz");
    expect(callCount).toBe(2);
  });

  test("passes 401 through when upstream has no oauthRefresh", async () => {
    const dir = await makeTmpDir();
    const socketPath = join(dir, "auth.sock");

    const { port } = await new Promise<{ port: number }>((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("Unauthorized");
      });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as { port: number };
        cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
        resolve({ port: addr.port });
      });
    });

    const proxy = await startAuthProxy(socketPath, [
      {
        domain: "api.example.com",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer token" },
        // no oauthRefresh
      },
    ]);
    cleanups.push(() => proxy.close());

    const result = await proxyRequest(socketPath, "http://api.example.com/v1/messages");
    expect(result.status).toBe(401);
  });

  test("passes 401 through when all oauthRefresh sources fail", async () => {
    const dir = await makeTmpDir();
    const socketPath = join(dir, "auth.sock");

    const { port } = await new Promise<{ port: number }>((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("Unauthorized");
      });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as { port: number };
        cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
        resolve({ port: addr.port });
      });
    });

    const proxy = await startAuthProxy(socketPath, [
      {
        domain: "api.example.com",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer token" },
        oauthRefresh: {
          sources: [{ type: "agent-token-file", path: join(dir, "nonexistent-token") }],
          headerName: "authorization",
          headerTemplate: "Bearer ${token}",
        },
      },
    ]);
    cleanups.push(() => proxy.close());

    const result = await proxyRequest(socketPath, "http://api.example.com/v1/messages");
    expect(result.status).toBe(401);
  });

  test("concurrent 401s trigger only one token refresh", async () => {
    const dir = await makeTmpDir();
    const tokenFile = join(dir, "oauth-token");
    await Bun.write(tokenFile, "refreshed-token");

    const { port } = await new Promise<{ port: number }>((resolve) => {
      const s = createServer((req, res) => {
        const auth = req.headers["authorization"] ?? "";
        if (auth.includes("old-token")) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("Unauthorized");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ path: req.url, headers: req.headers }));
        }
      });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as { port: number };
        cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
        resolve({ port: addr.port });
      });
    });

    const socketPath = join(dir, "auth.sock");
    const proxy = await startAuthProxy(socketPath, [
      {
        domain: "api.example.com",
        target: `http://127.0.0.1:${port}`,
        headers: { authorization: "Bearer old-token" },
        oauthRefresh: {
          sources: [{ type: "agent-token-file", path: tokenFile }],
          headerName: "authorization",
          headerTemplate: "Bearer ${token}",
        },
      },
    ]);
    cleanups.push(() => proxy.close());

    // Fire two requests concurrently
    const [r1, r2] = await Promise.all([
      proxyPost(socketPath, "http://api.example.com/v1/messages", "{}"),
      proxyPost(socketPath, "http://api.example.com/v1/messages", "{}"),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.headers.authorization).toBe("Bearer refreshed-token");
    expect(r2.body.headers.authorization).toBe("Bearer refreshed-token");
  });
});
