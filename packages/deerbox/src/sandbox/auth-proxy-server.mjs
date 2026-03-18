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

const httpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 60_000 });
const httpAgent = new HttpAgent({ keepAlive: true, keepAliveMsecs: 60_000 });

const socketPath = process.argv[2];
const upstreams = JSON.parse(process.argv[3]);

function log(message) {
  process.stdout.write(JSON.stringify({ log: message }) + "\n");
}

function forwardToUpstream(upstream, path, req, res) {
  const targetUrl = new URL(path, upstream.target);
  const method = req.method ?? "GET";
  const startTime = Date.now();
  const isHttps = targetUrl.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;

  const fwdHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === "host" || key === "connection" || key === "proxy-connection") continue;
    if (value !== undefined) fwdHeaders[key] = value;
  }
  fwdHeaders["host"] = targetUrl.host;
  for (const [k, v] of Object.entries(upstream.headers)) {
    fwdHeaders[k] = v;
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
      log(`[proxy] ${method} ${upstream.domain}${path} → ${proxyRes.statusCode} (${elapsed}ms, ${connType})`);
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    const elapsed = Date.now() - startTime;
    log(`[proxy] ${method} ${upstream.domain}${path} → 502 error (${elapsed}ms): ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`auth-proxy: upstream error: ${err.message}`);
    }
  });

  req.pipe(proxyReq);
}

function handleRequest(req, res) {
  const rawUrl = req.url ?? "/";

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    if (upstreams.length > 0) {
      forwardToUpstream(upstreams[0], rawUrl, req, res);
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

  const path = parsedUrl.pathname + parsedUrl.search;
  forwardToUpstream(upstream, path, req, res);
}

// Clean up stale socket
try { unlinkSync(socketPath); } catch { /* ignore */ }

const server = createServer(handleRequest);

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
