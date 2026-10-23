// Local API for the desktop UI: JSON-RPC over HTTP + Server-Sent Events for live changes.
// Bound to 127.0.0.1 only, protected by a random per-launch token, with Host/Origin checks.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { MothError } from "../engine/types.ts";
import { log } from "../logger.ts";
import { rpcMethods, type Controller } from "./rpc.ts";

const ALLOWED_ORIGINS = [/^tauri:\/\/localhost$/, /^https?:\/\/tauri\.localhost$/, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/];
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };

export interface ApiServer {
  port: number;
  token: string;
  close(): Promise<void>;
}

export async function startApi(c: Controller, opts: { port?: number; token?: string; staticDir?: string }): Promise<ApiServer> {
  const token = opts.token ?? crypto.randomBytes(32).toString("hex");
  const methods = rpcMethods(c);
  const clients = new Set<http.ServerResponse>();
  const tokenOk = (t: string | null | undefined) => {
    if (!t) return false;
    const a = Buffer.from(t);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const host = String(req.headers.host ?? "");
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return void res.writeHead(403).end("Forbidden host");
    const origin = req.headers.origin;
    if (origin) {
      if (!ALLOWED_ORIGINS.some((re) => re.test(origin))) return void res.writeHead(403).end("Forbidden origin");
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    if (url.pathname === "/api/health") return void json(res, 200, { ok: true });

    if (url.pathname === "/api/rpc" && req.method === "POST") {
      const auth = String(req.headers.authorization ?? "");
      if (!tokenOk(auth.startsWith("Bearer ") ? auth.slice(7) : null)) return void json(res, 401, { error: "unauthorized" });
      let body: any;
      try {
        body = JSON.parse(await readBody(req, 5_000_000));
      } catch {
        return void json(res, 400, { error: "invalid_json", message: "Request body must be JSON" });
      }
      const fn = methods[body?.method];
      if (!fn) return void json(res, 404, { error: "unknown_method", message: `Unknown method ${body?.method}` });
      const started = Date.now();
      try {
        const result = await fn(body.params ?? {});
        if (Date.now() - started > 1500) log.warn(`slow rpc ${body.method} ${Date.now() - started}ms`);
        return void json(res, 200, { result: result ?? null });
      } catch (e) {
        const err = e as MothError;
        if (!(e instanceof MothError)) log.error(`rpc ${body.method} failed`, e);
        return void json(res, e instanceof MothError ? 400 : 500, { error: err.code ?? "internal_error", message: err.message });
      }
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      if (!tokenOk(url.searchParams.get("token"))) return void res.writeHead(401).end();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ cursor: Number(c.brain().db.value("SELECT MAX(id) FROM db_changes") ?? 0) })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (opts.staticDir && req.method === "GET") return void serveStatic(opts.staticDir, url.pathname, res);
    res.writeHead(404).end();
  });

  // Change feed → SSE. One cheap indexed query per tick; every process's writes show up here.
  let cursor = Number(c.brain().db.value("SELECT MAX(id) FROM db_changes") ?? 0);
  const poll = setInterval(() => {
    if (!clients.size) {
      cursor = Number(c.brain().db.value("SELECT MAX(id) FROM db_changes") ?? cursor);
      return;
    }
    try {
      const ch = c.brain().changesSince(cursor, 500);
      if (!ch.changes.length) return;
      cursor = ch.cursor;
      const data = `event: changes\ndata: ${JSON.stringify({ cursor, changes: ch.changes.map((x) => ({ entity: x.entity, id: x.entity_id, op: x.op })) })}\n\n`;
      for (const r of clients) r.write(data);
    } catch (e) {
      log.warn("change poll failed", e);
    }
  }, 600);
  const ping = setInterval(() => {
    for (const r of clients) r.write(`: ping\n\n`);
  }, 15000);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    token,
    close: () =>
      new Promise((r) => {
        clearInterval(poll);
        clearInterval(ping);
        for (const cl of clients) cl.end();
        server.close(() => r());
      }),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(dir: string, pathname: string, res: http.ServerResponse): void {
  const root = path.resolve(dir);
  let file = path.resolve(root, "." + decodeURIComponent(pathname));
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
  if (!fs.existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}
