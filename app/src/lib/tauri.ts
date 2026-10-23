// Thin wrappers around the desktop shell. Every function degrades gracefully in a plain browser.
import { isTauri, rpc } from "./api";

export async function windowAction(action: "minimize" | "toggleMaximize" | "close"): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if (action === "minimize") await w.minimize();
  else if (action === "toggleMaximize") await w.toggleMaximize();
  else await w.close();
}

export async function isMaximized(): Promise<boolean> {
  if (!isTauri()) return false;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().isMaximized();
}

/** Stores a secret in Windows Credential Manager (desktop) and hands it to the running engine. */
export async function saveSecret(name: string, value: string | null): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(value ? "secret_set" : "secret_delete", value ? { name, value } : { name });
  }
  await rpc("secrets.set", { name, value });
}

export async function readSecret(name: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("secret_get", { name });
}

export async function notify(title: string, body: string): Promise<void> {
  try {
    if (isTauri()) {
      const n = await import("@tauri-apps/plugin-notification");
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === "granted";
      if (ok) n.sendNotification({ title, body });
    } else if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch {
    /* notifications are best-effort */
  }
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  if (!isTauri()) return false;
  const a = await import("@tauri-apps/plugin-autostart");
  if (enabled) await a.enable();
  else await a.disable();
  return a.isEnabled();
}

export async function getAutostart(): Promise<boolean> {
  if (!isTauri()) return false;
  const a = await import("@tauri-apps/plugin-autostart");
  return a.isEnabled();
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const o = await import("@tauri-apps/plugin-opener");
    await o.openUrl(url);
  } else window.open(url, "_blank", "noopener");
}

export async function revealPath(path: string): Promise<void> {
  if (isTauri()) {
    const o = await import("@tauri-apps/plugin-opener");
    await o.revealItemInDir(path);
  }
}

/** Folder picker; returns null when cancelled or unavailable (the UI then shows a text field). */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const d = await import("@tauri-apps/plugin-dialog");
  const r = await d.open({ directory: true, multiple: false });
  return typeof r === "string" ? r : null;
}

export async function restartEngine(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_engine");
}

export async function shellInfo(): Promise<{ version: string; log_dir: string } | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("shell_info");
}

/** Keyring only (no engine copy) — used for Google refresh tokens. In a browser it keeps them in memory. */
const memoryVault = new Map<string, string>();
export async function keyringSet(name: string, value: string | null): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(value ? "secret_set" : "secret_delete", value ? { name, value } : { name });
  } else if (value) memoryVault.set(name, value);
  else memoryVault.delete(name);
}
export async function keyringGet(name: string): Promise<string | null> {
  if (isTauri()) return readSecret(name);
  return memoryVault.get(name) ?? null;
}

export async function setKeepInTray(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_keep_in_tray", { enabled });
}

async function invokeShell<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Opens the small Quick Capture window (desktop) — in a browser the main window shows it inline instead. */
export async function openQuickCapture(): Promise<void> {
  if (isTauri()) await invokeShell("open_capture");
  else window.dispatchEvent(new CustomEvent("moth-capture"));
}
export const hideQuickCapture = () => invokeShell("hide_capture");
export const openInMain = (page: string) => invokeShell("open_in_main", { page });
export const trayRefresh = () => invokeShell("tray_refresh");
export const quitApp = () => invokeShell("quit_app");
/** Registers the global Quick Capture shortcut; null removes it. Returns an error message if it couldn't be used. */
export async function setCaptureShortcut(shortcut: string | null): Promise<string | null> {
  try {
    await invokeShell("set_capture_shortcut", { shortcut });
    return null;
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

/** Listens to events from the desktop shell (navigate, capture-open, hidden-to-tray, system-state). */
export function onShellEvent<T = unknown>(name: string, cb: (payload: T) => void): () => void {
  if (!isTauri()) return () => undefined;
  let off: (() => void) | null = null;
  let cancelled = false;
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<T>(name, (e) => cb(e.payload)).then((u) => {
      if (cancelled) u();
      else off = u;
    }),
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

export async function currentWindowLabel(): Promise<string> {
  if (!isTauri()) return "main";
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().label;
}

/** File picker for imports (Markdown, text, JSON). */
export async function pickFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  const d = await import("@tauri-apps/plugin-dialog");
  const r = await d.open({ multiple: true, directory: false, filters: [{ name: "Notes", extensions: ["md", "markdown", "txt", "json"] }] });
  return Array.isArray(r) ? r.map(String) : typeof r === "string" ? [r] : [];
}
