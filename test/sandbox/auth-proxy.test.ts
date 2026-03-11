import { test, expect, describe, afterEach } from "bun:test";
import { startAuthProxy, type ProxyUpstream } from "../../src/sandbox/auth-proxy";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    const d = await mkdtemp(join(tmpdir(), "deer-proxy-test-"));
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

  test("close() removes socket file", async () => {
    const dir = await makeTmpDir();
    const socketPath = join(dir, "auth.sock");

    const proxy = await startAuthProxy(socketPath, []);
    await proxy.close();

    // Socket file should be cleaned up
    const exists = await Bun.file(socketPath).exists();
    expect(exists).toBe(false);
  });
});
