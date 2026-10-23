// Google sign-in (OAuth 2.0 / OpenID Connect) for desktop apps: system browser + loopback redirect + PKCE.
// Sign-in only requests openid/email/profile. Drive, Gmail and Calendar are separate, optional,
// read-only grants the user connects one at a time. Refresh tokens are handed to the desktop shell,
// which stores them in Windows Credential Manager; they never touch the database.
import crypto from "node:crypto";
import http from "node:http";
import { nowIso } from "../db/database.ts";
import { Secrets } from "../engine/ai.ts";
import type { Brain } from "../engine/brain.ts";
import { truncate } from "../engine/text.ts";
import { MothError } from "../engine/types.ts";
import { upsertIntegration } from "../connections.ts";
import { log } from "../logger.ts";

export const GOOGLE_SCOPES = {
  signin: ["openid", "email", "profile"],
  google_drive: ["https://www.googleapis.com/auth/drive.readonly"],
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  google_calendar: ["https://www.googleapis.com/auth/calendar.readonly"],
} as const;
export type GooglePurpose = keyof typeof GOOGLE_SCOPES;

interface Pending {
  state: string;
  purpose: GooglePurpose;
  verifier: string;
  redirectUri: string;
  server: http.Server;
  status: "waiting" | "done" | "error";
  error?: string;
  result?: { user?: unknown; refresh_token?: string; scopes: string[] };
  created: number;
}

const pending = new Map<string, Pending>();
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function clientConfig(brain: Brain): { clientId: string; clientSecret?: string } {
  const clientId = (brain.settings.get("google.clientId") || process.env.MOTH_GOOGLE_CLIENT_ID || "").trim();
  if (!clientId) throw new MothError("missing_credentials", "Google sign-in needs an OAuth client ID (Desktop app type) from Google Cloud Console. Add it in Settings → Account.");
  return { clientId, clientSecret: Secrets.get("google_client_secret") };
}

const page = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="background:#101014;color:#F5F5F7;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="font-weight:500">${title}</h2><p style="color:#9898A8">${msg}</p></div></body>`;

export async function startGoogleAuth(brain: Brain, purpose: GooglePurpose): Promise<{ state: string; authUrl: string }> {
  const { clientId, clientSecret } = clientConfig(brain);
  for (const [k, p] of pending) if (Date.now() - p.created > 10 * 60_000) (p.server.close(), pending.delete(k));
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const server = http.createServer();
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const p: Pending = { state, purpose, verifier, redirectUri, server, status: "waiting", created: Date.now() };
  pending.set(state, p);
  const timeout = setTimeout(() => {
    if (p.status === "waiting") {
      p.status = "error";
      p.error = "Sign-in timed out";
      server.close();
    }
  }, 10 * 60_000);

  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    if (url.searchParams.get("state") !== state) return void res.writeHead(400, { "content-type": "text/html" }).end(page("Sign-in failed", "The response did not match this sign-in attempt."));
    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    try {
      if (err || !code) throw new Error(err || "No authorization code returned");
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
      });
      const tok = (await tokenRes.json()) as any;
      if (!tokenRes.ok) throw new Error(tok.error_description || tok.error || `token exchange failed (${tokenRes.status})`);
      const scopes = String(tok.scope || "").split(" ").filter(Boolean);
      let user: unknown;
      if (purpose === "signin") {
        const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tok.id_token)}`);
        const info = (await infoRes.json()) as any;
        if (!infoRes.ok || info.aud !== clientId) throw new Error("Google ID token could not be verified");
        if (!["accounts.google.com", "https://accounts.google.com"].includes(info.iss)) throw new Error("Unexpected token issuer");
        const uid = `g_${info.sub}`;
        brain.db.run(
          `INSERT INTO users(id, kind, email, name, picture, google_sub, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture, last_login_at = excluded.last_login_at`,
          [uid, "google", info.email ?? null, info.name ?? null, info.picture ?? null, info.sub, nowIso(), nowIso()],
        );
        brain.settings.set("auth.currentUser", uid);
        user = { id: uid, email: info.email, name: info.name, picture: info.picture };
        brain.store.logActivity({ kind: "auth", source: "google", action: "signed_in", detail: { email: info.email } });
      } else {
        upsertIntegration(brain, purpose, "connected", {}, scopes);
        brain.store.logActivity({ kind: "auth", source: "google", action: `connected_${purpose}`, detail: { scopes } });
      }
      p.result = { user, refresh_token: tok.refresh_token, scopes };
      p.status = "done";
      res.writeHead(200, { "content-type": "text/html" }).end(page("You're signed in", "You can close this tab and return to MOTH."));
    } catch (e) {
      p.status = "error";
      p.error = (e as Error).message;
      log.warn("Google auth failed", p.error);
      brain.store.logActivity({ kind: "auth", source: "google", action: purpose, status: "error", detail: { error: p.error } });
      res.writeHead(400, { "content-type": "text/html" }).end(page("Sign-in failed", truncate(p.error, 200)));
    } finally {
      clearTimeout(timeout);
      setTimeout(() => server.close(), 500);
    }
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES[purpose].join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: purpose === "signin" ? "select_account" : "consent",
    ...(purpose !== "signin" ? { include_granted_scopes: "false" } : {}),
  });
  return { state, authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
}

/** Returns the result once; the refresh token is passed to the desktop shell for secure storage. */
export function googleAuthStatus(state: string): { status: Pending["status"]; error?: string; result?: Pending["result"]; purpose?: GooglePurpose } {
  const p = pending.get(state);
  if (!p) return { status: "error", error: "Unknown or expired sign-in attempt" };
  if (p.status !== "waiting") pending.delete(state);
  return { status: p.status, error: p.error, result: p.result, purpose: p.purpose };
}

export function signOut(brain: Brain): { user: string } {
  const uid = brain.store.userId;
  brain.settings.set("auth.currentUser", "local");
  brain.store.logActivity({ kind: "auth", source: "google", action: "signed_out", detail: { user: uid } });
  return { user: "local" };
}

export function disconnectIntegration(brain: Brain, provider: GooglePurpose): void {
  upsertIntegration(brain, provider, "disconnected", {}, []);
  brain.store.logActivity({ kind: "auth", source: "google", action: `disconnected_${provider}` });
}

async function accessToken(brain: Brain, refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = clientConfig(brain);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const j = (await r.json()) as any;
  if (!r.ok) throw new MothError("auth_failed", j.error_description || j.error || "Could not refresh Google access");
  return j.access_token;
}

async function gget(token: string, url: string): Promise<any> {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const text = await r.text();
  if (!r.ok) throw new MothError("google_api", `Google API ${r.status}: ${truncate(text, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Imports a bounded amount of user-authorised Google data as memories, each with a source reference. */
export async function importFromGoogle(brain: Brain, provider: Exclude<GooglePurpose, "signin">, refreshToken: string, limit = 15): Promise<{ imported: number; updated: number }> {
  const token = await accessToken(brain, refreshToken);
  const ctx = { actor: "user" as const, reason: `Imported from ${provider.replace("_", " ")} (authorised by the user)` };
  let imported = 0;
  let updated = 0;
  const upsert = (ref: string, title: string, content: string, ts: string | null, tags: string[]) => {
    if (!content.trim()) return;
    const existing = brain.db.get<{ id: string; content: string }>("SELECT id, content FROM memories WHERE user_id = ? AND source = ? AND source_ref = ?", [brain.store.userId, provider, ref]);
    if (existing) {
      if (existing.content !== content) {
        brain.store.updateMemory(existing.id, { content: truncate(content, 50_000), title }, ctx, { changeType: "imported", force: true });
        updated++;
      }
    } else {
      brain.store.createMemory({ title, content: truncate(content, 50_000), source: provider, source_ref: ref, source_timestamp: ts, tags, category: "fact" }, ctx);
      imported++;
    }
  };
  if (provider === "google_drive") {
    const list = await gget(token, `https://www.googleapis.com/drive/v3/files?pageSize=${limit}&orderBy=modifiedTime%20desc&q=${encodeURIComponent("mimeType='application/vnd.google-apps.document' and trashed=false")}&fields=files(id,name,modifiedTime,webViewLink)`);
    for (const f of list.files ?? []) {
      const text = await gget(token, `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`);
      upsert(f.webViewLink ?? `drive:${f.id}`, f.name, String(text), f.modifiedTime, ["google-drive"]);
    }
  } else if (provider === "gmail") {
    const list = await gget(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent("is:starred")}`);
    for (const m of list.messages ?? []) {
      const msg = await gget(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
      const h = (n: string) => (msg.payload?.headers ?? []).find((x: any) => x.name === n)?.value ?? "";
      upsert(`gmail:${m.id}`, h("Subject") || "(no subject)", `From: ${h("From")}\nDate: ${h("Date")}\n\n${msg.snippet ?? ""}`, new Date(Number(msg.internalDate)).toISOString(), ["gmail", "starred"]);
    }
  } else if (provider === "google_calendar") {
    const now = new Date().toISOString();
    const max = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const list = await gget(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=${limit}&timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(max)}`);
    for (const e of list.items ?? []) {
      const start = e.start?.dateTime ?? e.start?.date ?? "";
      upsert(e.htmlLink ?? `gcal:${e.id}`, `${e.summary ?? "Event"} (${String(start).slice(0, 16).replace("T", " ")})`, [`When: ${start}`, e.location ? `Where: ${e.location}` : "", e.description ?? ""].filter(Boolean).join("\n"), e.updated ?? null, ["calendar"]);
    }
  }
  upsertIntegration(brain, provider, "connected", { last_import: nowIso(), imported, updated });
  return { imported, updated };
}
