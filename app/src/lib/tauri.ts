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
