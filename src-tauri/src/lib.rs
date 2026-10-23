//! MOTH desktop shell.
//!
//! The Rust side is deliberately thin: it owns the native window, the tray icon, autostart,
//! notifications and Windows Credential Manager, and it supervises the `moth-core` sidecar
//! (the memory engine + MCP server). The sidecar is restarted automatically if it crashes.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const KEYRING_SERVICE: &str = "MOTH";
const ENGINE_SECRETS: [&str; 3] = ["anthropic_api_key", "embeddings_api_key", "google_client_secret"];

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Endpoint {
    port: u16,
    token: String,
}

#[derive(Default)]
struct Core {
    endpoint: Mutex<Option<Endpoint>>,
    child: Mutex<Option<CommandChild>>,
    started: Mutex<Option<Instant>>,
    restarts: AtomicU32,
    quitting: AtomicBool,
    keep_in_tray: AtomicBool,
}

fn secret_name_allowed(name: &str) -> bool {
    ENGINE_SECRETS.contains(&name)
        || (name.starts_with("google_refresh_") && name.len() < 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

fn keyring_get(name: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, name).ok()?.get_password().ok()
}

fn spawn_core(app: &AppHandle) {
    let core = app.state::<Core>();
    let command = match app.shell().sidecar("moth-core") {
        Ok(c) => c.args(["serve"]),
        Err(e) => {
            log::error!("moth-core sidecar missing: {e}");
            return;
        }
    };
    let (mut rx, mut child) = match command.spawn() {
        Ok(v) => v,
        Err(e) => {
            log::error!("could not start moth-core: {e}");
            let _ = app.emit("engine-failed", e.to_string());
            return;
        }
    };
    // Hand the engine its secrets from Windows Credential Manager (never written to disk by MOTH).
    let mut values = serde_json::Map::new();
    for name in ENGINE_SECRETS {
        if let Some(v) = keyring_get(name) {
            values.insert(name.to_string(), serde_json::Value::String(v));
        }
    }
    let line = format!("{}\n", serde_json::json!({ "type": "secrets", "values": values }));
    if let Err(e) = child.write(line.as_bytes()) {
        log::warn!("could not pass secrets to moth-core: {e}");
    }
    *core.child.lock().unwrap() = Some(child);
    *core.started.lock().unwrap() = Some(Instant::now());

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    for line in text.lines() {
                        if let Some(rest) = line.trim().strip_prefix("MOTH_READY ") {
                            match serde_json::from_str::<Endpoint>(rest) {
                                Ok(ep) => {
                                    log::info!("memory engine ready on port {}", ep.port);
                                    *handle.state::<Core>().endpoint.lock().unwrap() = Some(ep.clone());
                                    let _ = handle.emit("engine-ready", ep);
                                }
                                Err(e) => log::error!("bad ready line from moth-core: {e}"),
                            }
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => log::info!("core: {}", String::from_utf8_lossy(&bytes).trim_end()),
                CommandEvent::Error(e) => log::error!("core error: {e}"),
                CommandEvent::Terminated(status) => {
                    log::warn!("moth-core exited: {:?}", status.code);
                    let core = handle.state::<Core>();
                    *core.endpoint.lock().unwrap() = None;
                    *core.child.lock().unwrap() = None;
                    if core.quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    // Crash recovery: restart with backoff; give up after repeated fast failures.
                    let uptime = core.started.lock().unwrap().map(|s| s.elapsed()).unwrap_or_default();
                    if uptime > Duration::from_secs(60) {
                        core.restarts.store(0, Ordering::SeqCst);
                    }
                    let n = core.restarts.fetch_add(1, Ordering::SeqCst) + 1;
                    if n > 6 {
                        log::error!("moth-core keeps failing; not restarting again");
                        let _ = handle.emit("engine-failed", "The memory engine stopped repeatedly. See the logs.");
                        break;
                    }
                    let h = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(400 * n as u64));
                        spawn_core(&h);
                    });
                    break;
                }
                _ => {}
            }
        }
    });
}

fn stop_core(app: &AppHandle) {
    let core = app.state::<Core>();
    core.quitting.store(true, Ordering::SeqCst);
    let child = core.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.write(b"{\"type\":\"shutdown\"}\n");
        std::thread::sleep(Duration::from_millis(300));
        let _ = child.kill();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn core_endpoint(state: State<'_, Core>) -> Option<Endpoint> {
    state.endpoint.lock().unwrap().clone()
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    if !secret_name_allowed(&name) {
        return Err("This secret name is not allowed".into());
    }
    keyring::Entry::new(KEYRING_SERVICE, &name)
        .and_then(|e| e.set_password(&value))
        .map_err(|e| e.to_string())
}

/// Only Google refresh tokens can be read back by the UI; API keys stay write-only.
#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    if !name.starts_with("google_refresh_") || !secret_name_allowed(&name) {
        return Err("This secret can't be read from the interface".into());
    }
    Ok(keyring_get(&name))
}

#[tauri::command]
fn secret_delete(name: String) -> Result<(), String> {
    if !secret_name_allowed(&name) {
        return Err("This secret name is not allowed".into());
    }
    match keyring::Entry::new(KEYRING_SERVICE, &name).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn restart_engine(app: AppHandle) {
    let core = app.state::<Core>();
    core.restarts.store(0, Ordering::SeqCst);
    let child = core.child.lock().unwrap().take();
    match child {
        // Killing triggers the Terminated handler, which restarts the engine.
        Some(c) => {
            let _ = c.kill();
        }
        None => spawn_core(&app),
    }
}

#[tauri::command]
fn set_keep_in_tray(enabled: bool, state: State<'_, Core>) {
    state.keep_in_tray.store(enabled, Ordering::SeqCst);
}

#[derive(Serialize)]
struct ShellInfo {
    version: String,
    log_dir: String,
}

#[tauri::command]
fn shell_info(app: AppHandle) -> ShellInfo {
    ShellInfo {
        version: app.package_info().version.to_string(),
        log_dir: app.path().app_log_dir().map(|p| p.display().to_string()).unwrap_or_default(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .manage(Core::default())
        .invoke_handler(tauri::generate_handler![core_endpoint, secret_set, secret_get, secret_delete, restart_engine, set_keep_in_tray, shell_info])
        .setup(|app| {
            app.state::<Core>().keep_in_tray.store(true, Ordering::SeqCst);

            let open = MenuItem::with_id(app, "open", "Open MOTH", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Restart memory engine", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit MOTH", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &restart, &sep, &quit])?;
            let mut tray = TrayIconBuilder::with_id("moth").tooltip("MOTH").menu(&menu).show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id().as_ref() {
                "open" => show_main(app),
                "restart" => restart_engine(app.clone()),
                "quit" => {
                    stop_core(app);
                    app.exit(0);
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show_main(tray.app_handle());
                }
            })
            .build(app)?;

            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            spawn_core(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let core = window.state::<Core>();
                if core.keep_in_tray.load(Ordering::SeqCst) && !core.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while starting MOTH")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_core(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_names_are_restricted() {
        assert!(secret_name_allowed("anthropic_api_key"));
        assert!(secret_name_allowed("google_refresh_gmail"));
        assert!(!secret_name_allowed("google_refresh_../x"));
        assert!(!secret_name_allowed("random"));
    }
}
