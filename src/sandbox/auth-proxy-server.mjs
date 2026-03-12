#!/usr/bin/env node
/**
 * Standalone Node.js auth proxy server.
 *
 * Spawned as a subprocess to avoid Bun's broken HTTP streaming.
 * Communicates with the parent process via stdout (JSON log lines).
 *
 * Usage: node auth-proxy-server.mjs <socketPath> <upstreamsJSON>
 *
 * IPC protocol (all messages are newline-delimited JSON):
 *   stdout → host:  { log: "..." }
 *                   { ready: true }
 *                   { type: "refresh_request", domain: "...", requestId: "..." }
 *   stdin  → server: { type: "refresh_response", requestId: "...", headers: {...}|null }
 */

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const socketPath = process.argv[2];
const upstreams = JSON.parse(process.argv[3]);

/** Pending token refresh callbacks keyed by requestId. */
const pendingRefreshes = new Map();

function log(message) {
  process.stdout.write(JSON.stringify({ log: message }) + "\n");
}

// Listen for refresh_response messages from the host on stdin.
const stdinRl = createInterface({ input: process.stdin });
stdinRl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type === "refresh_response") {
      const pending = pendingRefreshes.get(msg.requestId);
      if (pending) {
        pendingRefreshes.delete(msg.requestId);
        pending(msg.headers ?? null);
      }
    }
  } catch { /* ignore malformed */ }
});

/**
 * Ask the host to refresh credentials for a domain.
 * Returns fresh headers, or null if no refresh is available or it times out.
 */
function requestTokenRefresh(domain) {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const timeout = setTimeout(() => {
      pendingRefreshes.delete(requestId);
      resolve(null);
    }, 10000);
    pendingRefreshes.set(requestId, (headers) => {
      clearTimeout(timeout);
      resolve(headers);
    });
    process.stdout.write(JSON.stringify({ type: "refresh_request", domain, requestId }) + "\n");
  });
}

/** Collect all chunks from a readable stream into a single Buffer. */
function collectBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Send one request to an upstream server.
 * Returns a Promise that resolves with the IncomingMessage (response stream).
 */
function makeUpstreamRequest(upstream, path, method, reqHeaders, body, overrideHeaders) {
  const targetUrl = new URL(path, upstream.target);
  const isHttps = targetUrl.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;

  const fwdHeaders = {};
  for (const [key, value] of Object.entries(reqHeaders)) {
    if (key === "host" || key === "connection" || key === "proxy-connection") continue;
    if (value !== undefined) fwdHeaders[key] = value;
  }
  fwdHeaders["host"] = targetUrl.host;
  for (const [k, v] of Object.entries(overrideHeaders ?? upstream.headers)) {
    fwdHeaders[k] = v;
  }

  return new Promise((resolve, reject) => {
    const proxyReq = doRequest(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method,
        headers: fwdHeaders,
      },
      resolve,
    );
    proxyReq.on("error", reject);
    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
}

async function handleRequest(req, res) {
  const rawUrl = req.url ?? "/";
  const method = req.method ?? "GET";
  const startTime = Date.now();

  let upstream;
  let path;

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    if (upstreams.length > 0) {
      upstream = upstreams[0];
      path = rawUrl;
    } else {
      log(`[proxy] 502 invalid URL ${rawUrl}`);
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("auth-proxy: invalid request URL");
      return;
    }
  }

  if (!upstream) {
    const hostname = parsedUrl.hostname;
    upstream = upstreams.find((u) => u.domain === hostname);
    if (!upstream) {
      log(`[proxy] 502 no upstream for ${hostname}`);
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`auth-proxy: no upstream for ${hostname}`);
      return;
    }
    path = parsedUrl.pathname + parsedUrl.search;
  }

  // Buffer the request body so we can replay it on a retry after 401.
  let body;
  try {
    body = await collectBody(req);
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`auth-proxy: failed to read request body: ${err.message}`);
    return;
  }

  let proxyRes;
  try {
    proxyRes = await makeUpstreamRequest(upstream, path, method, req.headers, body, null);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    log(`[proxy] ${method} ${upstream.domain}${path} → 502 error (${elapsed}ms): ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`auth-proxy: upstream error: ${err.message}`);
    }
    return;
  }

  // On 401: drain the error body, ask the host for fresh headers, retry once.
  if (proxyRes.statusCode === 401) {
    const body401 = await collectBody(proxyRes);
    const freshHeaders = await requestTokenRefresh(upstream.domain);

    if (freshHeaders) {
      // Update the upstream's cached headers so future requests use them too.
      Object.assign(upstream.headers, freshHeaders);
      try {
        proxyRes = await makeUpstreamRequest(upstream, path, method, req.headers, body, freshHeaders);
      } catch (err) {
        const elapsed = Date.now() - startTime;
        log(`[proxy] ${method} ${upstream.domain}${path} → 502 error after token refresh (${elapsed}ms): ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`auth-proxy: upstream error after token refresh: ${err.message}`);
        }
        return;
      }
    } else {
      // No refresh available — pass the original 401 through.
      const elapsed = Date.now() - startTime;
      log(`[proxy] ${method} ${upstream.domain}${path} → 401 (no token refresh available) (${elapsed}ms)`);
      res.writeHead(401, proxyRes.headers);
      res.end(body401);
      return;
    }
  }

  const elapsed = Date.now() - startTime;
  log(`[proxy] ${method} ${upstream.domain}${path} → ${proxyRes.statusCode} (${elapsed}ms)`);
  res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
  proxyRes.pipe(res);
}

// Clean up stale socket
try { unlinkSync(socketPath); } catch { /* ignore */ }

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    log(`[proxy] unhandled error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`auth-proxy: internal error: ${err.message}`);
    }
  });
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
