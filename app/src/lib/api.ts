// Talks to the local MOTH engine (moth-core sidecar) over 127.0.0.1 with a per-launch token.
// In the desktop app the endpoint comes from the Rust shell; in a browser (dev/test) from the URL hash.
export interface Endpoint {
  port: number;
  token: string;
}

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let endpointPromise: Promise<Endpoint> | null = null;

async function resolveEndpoint(): Promise<Endpoint> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    for (let i = 0; i < 300; i++) {
      const e = await invoke<Endpoint | null>("core_endpoint");
      if (e && e.port) return e;
      await sleep(150);
    }
    throw new ApiError("engine_unavailable", "MOTH's memory engine did not start. Check the log in Settings → Data.");
  }
  const hash = new URLSearchParams(location.hash.slice(1));
  let token = hash.get("token");
  try {
    if (token) sessionStorage.setItem("moth.token", token);
    else token = sessionStorage.getItem("moth.token");
  } catch {
    /* storage unavailable */
  }
  if (!token) throw new ApiError("no_token", "Open MOTH from the link printed by moth-core serve.");
  return { port: Number(location.port || 80), token };
}

export function endpoint(): Promise<Endpoint> {
  if (!endpointPromise) endpointPromise = resolveEndpoint().catch((e) => {
    endpointPromise = null;
    throw e;
  });
  return endpointPromise;
}

export function resetEndpoint(): void {
  endpointPromise = null;
}

export async function rpc<T = any>(method: string, params: unknown = {}): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ep = await endpoint();
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${ep.port}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ method, params }),
      });
    } catch {
      // Engine restarting (crash recovery or restore): ask the shell for the new endpoint.
      resetEndpoint();
      await sleep(400 * (attempt + 1));
      continue;
    }
    if (res.status === 401) {
      resetEndpoint();
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body.error ?? "error", body.message ?? `Request failed (${res.status})`);
    return body.result as T;
  }
  throw new ApiError("engine_unavailable", "Can't reach MOTH's memory engine.");
}

export interface ChangeEvent {
  entity: "memory" | "relationship" | "project" | "learning" | "activity" | "review" | "cortex" | "settings" | "transfer" | "project_item" | "handoff" | "finding" | "job" | "permission";
  id: string;
  op: "insert" | "update" | "delete";
}

type Listener = (changes: ChangeEvent[]) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;
const statusListeners = new Set<(c: boolean) => void>();

function setConnected(c: boolean) {
  if (c === connected) return;
  connected = c;
  statusListeners.forEach((l) => l(c));
}

async function openStream(): Promise<void> {
  if (source) return;
  try {
    const ep = await endpoint();
    source = new EventSource(`http://127.0.0.1:${ep.port}/api/events?token=${ep.token}`);
    source.addEventListener("hello", () => setConnected(true));
    source.addEventListener("changes", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      listeners.forEach((l) => l(data.changes));
    });
    source.onerror = () => {
      setConnected(false);
      source?.close();
      source = null;
      resetEndpoint();
      setTimeout(() => void openStream(), 1500);
    };
  } catch {
    setTimeout(() => void openStream(), 1500);
  }
}

export function onChanges(l: Listener): () => void {
  listeners.add(l);
  void openStream();
  return () => listeners.delete(l);
}

export function onConnection(l: (c: boolean) => void): () => void {
  statusListeners.add(l);
  l(connected);
  void openStream();
  return () => statusListeners.delete(l);
}
