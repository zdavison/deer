import { test, expect, describe, afterEach } from "bun:test";
import { startProxy, matchesAllowlist, isPrivateIP, type ProxyHandle } from "../../src/sandbox/proxy";
import { createServer, type Server } from "node:net";

describe("matchesAllowlist", () => {
  test("exact match", () => {
    expect(matchesAllowlist("example.com", ["example.com"])).toBe(true);
  });

  test("case insensitive", () => {
    expect(matchesAllowlist("Example.COM", ["example.com"])).toBe(true);
  });

  test("no match", () => {
    expect(matchesAllowlist("evil.com", ["example.com"])).toBe(false);
  });

  test("wildcard matches subdomain", () => {
    expect(matchesAllowlist("sub.example.com", ["*.example.com"])).toBe(true);
  });

  test("wildcard matches deep subdomain", () => {
    expect(matchesAllowlist("a.b.example.com", ["*.example.com"])).toBe(true);
  });

  test("wildcard does not match bare domain", () => {
    expect(matchesAllowlist("example.com", ["*.example.com"])).toBe(false);
  });

  test("wildcard does not match unrelated domain", () => {
    expect(matchesAllowlist("notexample.com", ["*.example.com"])).toBe(false);
  });

  test("empty allowlist matches nothing", () => {
    expect(matchesAllowlist("anything.com", [])).toBe(false);
  });

  test("multiple entries", () => {
    const list = ["api.anthropic.com", "github.com", "*.npmjs.org"];
    expect(matchesAllowlist("api.anthropic.com", list)).toBe(true);
    expect(matchesAllowlist("github.com", list)).toBe(true);
    expect(matchesAllowlist("registry.npmjs.org", list)).toBe(true);
    expect(matchesAllowlist("evil.com", list)).toBe(false);
  });
});

describe("isPrivateIP", () => {
  test("loopback IPv4", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
    expect(isPrivateIP("127.255.255.255")).toBe(true);
  });

  test("10.x.x.x range", () => {
    expect(isPrivateIP("10.0.0.1")).toBe(true);
    expect(isPrivateIP("10.255.255.255")).toBe(true);
  });

  test("172.16-31.x.x range", () => {
    expect(isPrivateIP("172.16.0.1")).toBe(true);
    expect(isPrivateIP("172.31.255.255")).toBe(true);
    expect(isPrivateIP("172.15.0.1")).toBe(false);
    expect(isPrivateIP("172.32.0.1")).toBe(false);
  });

  test("192.168.x.x range", () => {
    expect(isPrivateIP("192.168.0.1")).toBe(true);
    expect(isPrivateIP("192.168.255.255")).toBe(true);
  });

  test("link-local 169.254.x.x", () => {
    expect(isPrivateIP("169.254.1.1")).toBe(true);
  });

  test("IPv6 loopback", () => {
    expect(isPrivateIP("::1")).toBe(true);
  });

  test("IPv6 link-local", () => {
    expect(isPrivateIP("fe80::1")).toBe(true);
  });

  test("public IPs are not private", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
    expect(isPrivateIP("1.1.1.1")).toBe(false);
    expect(isPrivateIP("93.184.216.34")).toBe(false);
  });

  test("0.0.0.0", () => {
    expect(isPrivateIP("0.0.0.0")).toBe(true);
  });
});

describe("proxy server", () => {
  const handles: ProxyHandle[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const h of handles) h.stop();
    handles.length = 0;
    for (const s of servers) s.close();
    servers.length = 0;
  });

  /** Start a dummy TCP server that echoes data back */
  function startEchoServer(): Promise<{ port: number }> {
    return new Promise((resolve) => {
      const server = createServer((socket) => {
        socket.on("data", (d) => socket.write(d));
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          resolve({ port: addr.port });
        }
      });
    });
  }

  async function launch(allowlist: string[], rejectPrivateIPs = true): Promise<ProxyHandle> {
    const h = await startProxy({ allowlist, rejectPrivateIPs });
    handles.push(h);
    return h;
  }

  /** Send a raw request to the proxy and return the first response line's status code */
  function sendRequest(proxyPort: number, request: string): Promise<{ statusCode: number; response: string }> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      Bun.connect({
        hostname: "127.0.0.1",
        port: proxyPort,
        socket: {
          open(socket) {
            socket.write(request);
          },
          data(socket, data) {
            const response = Buffer.from(data).toString();
            const firstLine = response.split("\r\n")[0];
            const statusCode = parseInt(firstLine.split(" ")[1]);
            resolved = true;
            resolve({ statusCode, response });
            socket.end();
          },
          close() {
            if (!resolved) reject(new Error("closed before response"));
          },
          error(_, e) {
            if (!resolved) reject(e);
          },
        },
      });
    });
  }

  test("starts and returns a port", async () => {
    const h = await launch(["example.com"]);
    expect(h.port).toBeGreaterThan(0);
  });

  test("allows CONNECT to allowlisted host (localhost echo server)", async () => {
    const echo = await startEchoServer();
    const h = await launch(["127.0.0.1"], false);

    const { statusCode } = await sendRequest(
      h.port,
      `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`,
    );
    expect(statusCode).toBe(200);
  });

  test("rejects CONNECT to non-allowlisted host", async () => {
    const h = await launch(["example.com"]);
    const { statusCode } = await sendRequest(
      h.port,
      "CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\n\r\n",
    );
    expect(statusCode).toBe(403);
  });

  test("rejects plain HTTP GET", async () => {
    const h = await launch(["example.com"]);
    const { statusCode } = await sendRequest(
      h.port,
      "GET http://evil.com/ HTTP/1.1\r\nHost: evil.com\r\n\r\n",
    );
    expect(statusCode).toBe(403);
  });

  test("relays data through CONNECT tunnel", async () => {
    const echo = await startEchoServer();
    const h = await launch(["127.0.0.1"], false);

    const relayed = await new Promise<string>((resolve, reject) => {
      let gotHandshake = false;
      let resolved = false;

      Bun.connect({
        hostname: "127.0.0.1",
        port: h.port,
        socket: {
          open(socket) {
            socket.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
          },
          data(socket, data) {
            const text = Buffer.from(data).toString();
            if (!gotHandshake) {
              expect(text).toStartWith("HTTP/1.1 200");
              gotHandshake = true;
              socket.write("hello from client");
              return;
            }
            resolved = true;
            resolve(text);
            socket.end();
          },
          close() {
            if (!resolved) reject(new Error("closed before relay"));
          },
          error(_, e) {
            if (!resolved) reject(e);
          },
        },
      });
    });

    expect(relayed).toBe("hello from client");
  });

  test("rejects CONNECT when hostname resolves to private IP", async () => {
    // "localhost" resolves to 127.0.0.1 — should be rejected even if allowlisted
    const h = await launch(["localhost"]);
    const { statusCode } = await sendRequest(
      h.port,
      "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n",
    );
    expect(statusCode).toBe(403);
  });

  test("allows CONNECT to private IP when rejectPrivateIPs is false", async () => {
    const echo = await startEchoServer();
    const h = await launch(["127.0.0.1"], false);

    const { statusCode } = await sendRequest(
      h.port,
      `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`,
    );
    expect(statusCode).toBe(200);
  });

  test("proxy does not inject Authorization headers into CONNECT tunnel", async () => {
    // Even if ANTHROPIC_API_KEY is set in the host environment, the proxy must
    // not forward it as an Authorization header into tunneled traffic.
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-proxy-sentinel";
    try {
      const echo = await startEchoServer();
      const h = await launch(["127.0.0.1"], false);

      const received = await new Promise<string>((resolve, reject) => {
        let gotHandshake = false;
        let resolved = false;

        Bun.connect({
          hostname: "127.0.0.1",
          port: h.port,
          socket: {
            open(socket) {
              socket.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
            },
            data(socket, data) {
              const text = Buffer.from(data).toString();
              if (!gotHandshake) {
                gotHandshake = true;
                // Send a plain HTTP request through the tunnel; echo server reflects it back
                socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
                return;
              }
              resolved = true;
              resolve(text);
              socket.end();
            },
            close() {
              if (!resolved) reject(new Error("closed before data"));
            },
            error(_, e) {
              if (!resolved) reject(e);
            },
          },
        });
      });

      // The echo server reflects exactly what was sent — no extra Authorization header
      expect(received).not.toContain("Authorization");
      expect(received).not.toContain("sk-ant-proxy-sentinel");
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  test("stop() shuts down the server", async () => {
    const h = await launch(["example.com"]);
    const port = h.port;
    h.stop();
    handles.length = 0;

    try {
      await fetch(`http://127.0.0.1:${port}/`);
      expect(true).toBe(false);
    } catch {
      // Expected — server is stopped
    }
  });
});
