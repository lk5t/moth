// MOTH Updater: the official Tauri 2 updater plugin. It downloads the new installer from GitHub Releases, checks its
// signature against the public key built into MOTH (an update with a missing or wrong signature is refused), then
// runs the installer. On Windows MOTH closes while the installer runs and starts again afterwards.
//
// Before installing: open notes are saved, the workspace is saved, imports are paused (they resume after the
// restart), background jobs finish their current step, and the engine makes a backup copy of the database.
import { useSyncExternalStore } from "react";
import { rpc } from "./api";
import { flushAll } from "./docstore";
import { isTauri } from "./api";

export type UpdatePhase = "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "installing" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  current: string | null;
  available: { version: string; date: string | null; notes: string } | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  checkedAt: string | null;
}

let state: UpdateState = { phase: "idle", current: null, available: null, downloaded: 0, total: null, error: null, checkedAt: null };
const listeners = new Set<() => void>();
const set = (p: Partial<UpdateState>) => {
  state = { ...state, ...p };
  for (const l of listeners) l();
};
export const useUpdater = () => useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => state);

let pending: any = null;

function explain(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/signature/i.test(m)) return "The update's signature didn't match MOTH's key, so it was refused (nothing was installed).";
  if (/network|connect|dns|timed? ?out|offline|error sending request/i.test(m)) return "Couldn't reach the update server. Check your internet connection and try again.";
  if (/404|not found|release json|could not fetch a valid release/i.test(m)) return "No update information was found on the server yet.";
  return m;
}

export async function checkForUpdate(opts: { silent?: boolean } = {}): Promise<UpdateState> {
  if (!isTauri()) {
    set({ phase: "error", error: "Updates work in the installed app only." });
    return state;
  }
  if (["downloading", "installing"].includes(state.phase)) return state;
  set({ phase: "checking", error: null });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const { getVersion } = await import("@tauri-apps/api/app");
    const current = await getVersion();
    const u = await check({ timeout: 30_000 });
    const at = new Date().toISOString();
    void rpc("settings.set", { key: "updates.lastCheck", value: at }).catch(() => undefined);
    if (!u) {
      pending = null;
      set({ phase: "none", current, available: null, checkedAt: at });
    } else {
      pending = u;
      set({ phase: "available", current, available: { version: u.version, date: u.date ?? null, notes: u.body ?? "" }, checkedAt: at });
    }
  } catch (e) {
    set({ phase: opts.silent ? "idle" : "error", error: explain(e) });
  }
  return state;
}

/** Downloads (with real progress) and verifies the update, prepares MOTH, then installs. */
export async function installUpdate(): Promise<void> {
  if (!pending) return;
  set({ phase: "downloading", downloaded: 0, total: null, error: null });
  try {
    await pending.download((ev: any) => {
      if (ev.event === "Started") set({ total: ev.data?.contentLength ?? null, downloaded: 0 });
      else if (ev.event === "Progress") set({ downloaded: state.downloaded + (ev.data?.chunkLength ?? 0) });
    });
  } catch (e) {
    set({ phase: "error", error: explain(e) });
    return;
  }
  set({ phase: "installing" });
  try {
    await flushAll();
    await rpc("system.prepareUpdate", { version: state.available?.version });
  } catch (e) {
    void rpc("system.resumeAfterUpdateAttempt").catch(() => undefined);
    set({ phase: "error", error: `MOTH couldn't get ready for the update: ${(e as Error).message}` });
    return;
  }
  try {
    await pending.install(); // Windows: MOTH exits here and the installer restarts it.
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    void rpc("system.resumeAfterUpdateAttempt").catch(() => undefined);
    set({ phase: "error", error: `The installer didn't run: ${explain(e)}` });
  }
}

export function deferUpdate(): void {
  if (state.available) void rpc("settings.set", { key: "updates.deferredVersion", value: state.available.version }).catch(() => undefined);
  set({ phase: "idle" });
}
