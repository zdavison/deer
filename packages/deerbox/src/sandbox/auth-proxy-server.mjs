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
import { unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const httpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 60_000 });
const httpAgent = new HttpAgent({ keepAlive: true, keepAliveMsecs: 60_000 });

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

function log(message) {
  process.stdout.write(JSON.stringify({ log: message }) + "\n");
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
    if (upstreams.length > 0) {
      forwardToUpstream(upstreams[0], rawUrl, method, req.headers, res, req, false);
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

server.listen(socketPath, () => {
  process.stdout.write(JSON.stringify({ ready: true }) + "\n");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    process.exit(0);
  });
});
