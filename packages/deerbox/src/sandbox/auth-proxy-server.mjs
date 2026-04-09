#!/usr/bin/env node
/**
 * Standalone Node.js auth proxy server.
 *
 * Spawned as a subprocess to avoid Bun's broken HTTP streaming.
 * Communicates with the parent process via stdout (JSON log lines).
 *
 * Usage: node auth-proxy-server.mjs <socketPath> <upstreamsJSON>
 */

import { createServer, request as httpRequest, Agent as HttpAgent } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { TLSSocket } from "node:tls";
import { unlinkSync, appendFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Keep-alive disabled: after long idle periods, kept-alive sockets go stale
// (server/NAT closes them) and reuse attempts fail with ECONNRESET → 502.
// API calls are infrequent and long-running, so TLS handshake overhead is negligible.
const httpsAgent = new HttpsAgent({ keepAlive: false });
const httpAgent = new HttpAgent({ keepAlive: false });

/**
 * Try each credential source in order, return the first OAuth token found.
 * Returns null if no source yields a token.
 */
function resolveTokenFromSources(sources) {
  for (const source of sources) {
    try {
      if (source.type === "agent-token-file") {
        const token = readFileSync(source.path, "utf-8").trim();
        if (token) return token;
      } else if (source.type === "keychain") {
        const raw = execSync(
          `security find-generic-password -s "${source.service}" -w`,
          { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
        if (typeof token === "string" && token) return token;
      } else if (source.type === "file") {
        for (const filePath of source.paths) {
          try {
            const token = JSON.parse(readFileSync(filePath, "utf-8"))?.claudeAiOauth?.accessToken;
            if (typeof token === "string" && token) return token;
          } catch { /* try next path */ }
        }
      }
    } catch { /* try next source */ }
  }
  return null;
}

/** Per-domain in-flight refresh promises — serializes concurrent 401 retries. */
const refreshLocks = new Map();

/**
 * Re-read OAuth credentials for an upstream and update its in-memory headers.
 * If a refresh is already in progress for this domain, waits for it instead
 * of starting a second one.
 */
function refreshToken(upstream) {
  if (refreshLocks.has(upstream.domain)) {
    return refreshLocks.get(upstream.domain);
  }
  const promise = Promise.resolve().then(() => {
    const token = resolveTokenFromSources(upstream.oauthRefresh.sources);
    if (token) {
      upstream.headers[upstream.oauthRefresh.headerName] =
        upstream.oauthRefresh.headerTemplate.replace("${token}", token);
    }
    return token;
  }).finally(() => refreshLocks.delete(upstream.domain));
  refreshLocks.set(upstream.domain, promise);
  return promise;
}

const socketPath = process.argv[2];
const upstreams = JSON.parse(process.argv[3]);
const caCertPath = process.argv[4] || null;
const caKeyPath = process.argv[5] || null;

/** Per-domain TLS cert cache: domain -> { cert, key } PEM strings */
const tlsCertCache = new Map();

/**
 * Generate a TLS certificate for the given domain, signed by the deer CA.
 * Caches results in memory so each domain only generates once per proxy lifetime.
 */
function getTlsCertForDomain(domain) {
  if (tlsCertCache.has(domain)) return tlsCertCache.get(domain);
  if (!caCertPath || !caKeyPath) return null;

  // Guard: only allow safe hostname characters to reach the shell command.
  if (!/^[a-zA-Z0-9._-]+$/.test(domain)) {
    log(`[proxy] rejected unsafe domain for cert generation: ${domain}`);
    return null;
  }

  // Use temp files instead of /dev/stdin piping — openssl's fopen("/dev/stdin")
  // fails with ENXIO when spawned from Node.js execSync with { input }.
  const tmpDir = mkdtempSync(join(tmpdir(), "deer-cert-"));
  const keyPath = join(tmpDir, "key.pem");
  const csrPath = join(tmpDir, "csr.pem");
  const certPath = join(tmpDir, "cert.pem");
  const extPath = join(tmpDir, "ext.cnf");

  try {
    execSync(
      `openssl genrsa -out ${JSON.stringify(keyPath)} 2048 2>/dev/null`,
    );
    writeFileSync(extPath, `subjectAltName=DNS:${domain}\n`);
    execSync(
      `openssl req -new -key ${JSON.stringify(keyPath)} -subj "/CN=${domain}" -out ${JSON.stringify(csrPath)} 2>/dev/null`,
    );
    execSync(
      `openssl x509 -req -in ${JSON.stringify(csrPath)} ` +
      `-CA ${JSON.stringify(caCertPath)} -CAkey ${JSON.stringify(caKeyPath)} ` +
      `-CAcreateserial -days 365 -sha256 ` +
      `-extfile ${JSON.stringify(extPath)} -out ${JSON.stringify(certPath)} 2>/dev/null`,
    );
    const key = readFileSync(keyPath, "utf-8");
    const cert = readFileSync(certPath, "utf-8");
    const entry = { cert, key };
    tlsCertCache.set(domain, entry);
    return entry;
  } catch (err) {
    log(`[proxy] failed to generate TLS cert for ${domain}: ${err.message}`);
    return null;
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
}

const logFilePath = socketPath + ".log";
let stdoutBroken = false;
function log(message) {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${message}`;
  try { appendFileSync(logFilePath, line + "\n"); } catch { /* ignore */ }
  if (stdoutBroken) return;
  try {
    process.stdout.write(JSON.stringify({ log: message }) + "\n");
  } catch {
    // Parent disconnected the pipe (daemonized mode) — stop writing
    stdoutBroken = true;
  }
}

/**
 * Forward a request to an upstream server.
 *
 * @param {object} upstream - Upstream config (domain, target, headers, oauthRefresh)
 * @param {string} path - Request path
 * @param {string} method - HTTP method
 * @param {object} reqHeaders - Original request headers
 * @param {object} res - Client response to write to
 * @param {import("node:stream").Readable|Buffer} bodySource - Request body as a stream (first attempt) or Buffer (401 retry)
 * @param {boolean} isRetry - Whether this is a 401 retry
 */
function forwardToUpstream(upstream, path, method, reqHeaders, res, bodySource, isRetry) {
  const targetUrl = new URL(path, upstream.target);
  const startTime = Date.now();
  const isHttps = targetUrl.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;

  // Start with original request headers, skip hop-by-hop headers,
  // then overlay upstream auth headers and fix host.
  const fwdHeaders = {};
  for (const [key, value] of Object.entries(reqHeaders)) {
    if (key === "host" || key === "connection" || key === "proxy-connection") continue;
    if (value !== undefined) fwdHeaders[key] = value;
  }
  fwdHeaders["host"] = targetUrl.host;
  for (const [k, v] of Object.entries(upstream.headers)) {
    fwdHeaders[k] = v;
  }

  const isBuffer = Buffer.isBuffer(bodySource);

  // On retry, set accurate content-length from the buffered body.
  // On first attempt, pass through the original headers (content-length
  // or transfer-encoding from the client).
  if (isBuffer) {
    delete fwdHeaders["transfer-encoding"];
    if (bodySource.length > 0) {
      fwdHeaders["content-length"] = String(bodySource.length);
    }
  }

  // Collect chunks for potential 401 retry (only on first attempt)
  const bodyChunks = [];
  let bodyBufferPromise;
  if (isBuffer) {
    bodyBufferPromise = Promise.resolve(bodySource);
  } else {
    bodyBufferPromise = new Promise((resolve) => {
      bodySource.on("data", (chunk) => bodyChunks.push(chunk));
      bodySource.on("end", () => resolve(Buffer.concat(bodyChunks)));
    });
  }

  const proxyReq = doRequest(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers: fwdHeaders,
      agent: isHttps ? httpsAgent : httpAgent,
    },
    (proxyRes) => {
      const elapsed = Date.now() - startTime;
      const connType = proxyReq.reusedSocket ? "reused" : "new";

      if (proxyRes.statusCode === 401 && !isRetry && upstream.oauthRefresh) {
        proxyRes.resume(); // drain and discard the 401 body
        // Wait for body to be fully collected, then retry with buffered body
        bodyBufferPromise.then((bodyBuffer) => {
          return refreshToken(upstream).then((token) => {
            if (token) {
              forwardToUpstream(upstream, path, method, reqHeaders, res, bodyBuffer, true);
            } else {
              log(`[proxy] ${method} ${upstream.domain}${path} → 401 (refresh found no token)`);
              if (!res.headersSent) {
                res.writeHead(401, { "content-type": "text/plain" });
                res.end("auth-proxy: upstream 401 - no token found during refresh");
              }
            }
          });
        }).catch((err) => {
          log(`[proxy] ${method} ${upstream.domain}${path} → 401 (refresh error: ${err.message})`);
          if (!res.headersSent) {
            res.writeHead(401, { "content-type": "text/plain" });
            res.end(`auth-proxy: upstream 401 - refresh error: ${err.message}`);
          }
        });
        return;
      }

      log(`[proxy] ${method} ${upstream.domain}${path} → ${proxyRes.statusCode} (${elapsed}ms, ${connType})`);
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  // Disable Nagle's algorithm on upstream TCP connections to reduce
  // streaming latency for small SSE chunks.
  proxyReq.on("socket", (socket) => {
    if (typeof socket.setNoDelay === "function") {
      socket.setNoDelay(true);
    }
  });

  proxyReq.on("error", (err) => {
    const elapsed = Date.now() - startTime;
    log(`[proxy] ${method} ${upstream.domain}${path} → 502 error (${elapsed}ms): ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`auth-proxy: upstream error: ${err.message}`);
    }
  });

  // Stream body directly to upstream (or send buffered body on retry)
  if (isBuffer) {
    proxyReq.end(bodySource);
  } else {
    bodySource.pipe(proxyReq);
  }
}

function handleRequest(req, res) {
  const rawUrl = req.url ?? "/";
  const method = req.method ?? "GET";

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    // Relative URL — this happens for requests arriving through a CONNECT
    // tunnel (TLS-terminated). Resolve the upstream from the Host header.
    const hostHeader = req.headers.host;
    const hostDomain = hostHeader ? hostHeader.split(":")[0] : null;
    const hostUpstream = hostDomain
      ? upstreams.find((u) => u.domain === hostDomain)
      : null;
    const fallbackUpstream = hostUpstream ?? upstreams[0];
    if (fallbackUpstream) {
      if (fallbackUpstream.allowedPaths?.length) {
        const reqPath = rawUrl.split("?")[0];
        const allowed = fallbackUpstream.allowedPaths.some(
          (pattern) => new RegExp(pattern).test(reqPath),
        );
        if (!allowed) {
          log(`[proxy] 403 blocked path ${method} ${fallbackUpstream.domain}${reqPath}`);
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("auth-proxy: path not allowed");
          return;
        }
      }
      forwardToUpstream(fallbackUpstream, rawUrl, method, req.headers, res, req, false);
      return;
    }
    log(`[proxy] 502 invalid URL ${rawUrl}`);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("auth-proxy: invalid request URL");
    return;
  }

  const hostname = parsedUrl.hostname;
  const upstream = upstreams.find((u) => u.domain === hostname);
  if (!upstream) {
    log(`[proxy] 502 no upstream for ${hostname}`);
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`auth-proxy: no upstream for ${hostname}`);
    return;
  }

  if (upstream.allowedPaths?.length) {
    const allowed = upstream.allowedPaths.some((pattern) => new RegExp(pattern).test(parsedUrl.pathname));
    if (!allowed) {
      log(`[proxy] 403 blocked path ${method} ${upstream.domain}${parsedUrl.pathname}`);
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("auth-proxy: path not allowed");
      return;
    }
  }

  const path = parsedUrl.pathname + parsedUrl.search;
  forwardToUpstream(upstream, path, method, req.headers, res, req, false);
}

// Clean up stale socket
try { unlinkSync(socketPath); } catch { /* ignore */ }

const server = createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`auth-proxy: internal error: ${err.message}`);
    }
  }
});

server.on("connect", (req, clientSocket, head) => {
  const [hostname] = (req.url ?? "").split(":");
  if (!hostname) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  const upstream = upstreams.find((u) => u.domain === hostname);
  if (!upstream) {
    log(`[proxy] CONNECT 502 no upstream for ${hostname}`);
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }

  const domainCert = getTlsCertForDomain(hostname);
  if (!domainCert) {
    log(`[proxy] CONNECT 502 no TLS cert for ${hostname}`);
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }

  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  const tlsSocket = new TLSSocket(clientSocket, {
    isServer: true,
    cert: domainCert.cert,
    key: domainCert.key,
    requestCert: false,
  });

  tlsSocket.on("secure", () => {
    server.emit("connection", tlsSocket);
  });

  tlsSocket.on("error", (err) => {
    log(`[proxy] CONNECT TLS error for ${hostname}: ${err.message}`);
    clientSocket.destroy();
  });
});

// Prevent EPIPE crashes when parent disconnects stdout (daemonized mode)
process.stdout.on("error", () => { stdoutBroken = true; });

server.listen(socketPath, () => {
  try {
    process.stdout.write(JSON.stringify({ ready: true }) + "\n");
  } catch {
    stdoutBroken = true;
  }
});

// Graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    process.exit(0);
  });
});
