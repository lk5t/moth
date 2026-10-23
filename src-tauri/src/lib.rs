//! MOTH desktop shell.
//!
//! The Rust side is deliberately thin: it owns the native windows (main + Quick Capture), the tray icon and
//! its menu, the global Quick Capture shortcut, autostart, notifications and Windows Credential Manager, and it
//! supervises the `moth-core` sidecar (memory engine + local API). It also reports Windows idle time and power
//! state to the engine so background reflection can wait until the PC is idle and respect battery saver.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
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
    exited: AtomicBool,
    keep_in_tray: AtomicBool,
}

#[derive(Default)]
struct TrayItems {
    learning: Mutex<Option<MenuItem<Wry>>>,
    privacy: Mutex<Option<CheckMenuItem<Wry>>>,
    capture: Mutex<Option<MenuItem<Wry>>>,
    shortcut: Mutex<Option<String>>,
}

fn secret_name_allowed(name: &str) -> bool {
    ENGINE_SECRETS.contains(&name)
        || (name.starts_with("google_refresh_") && name.len() < 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

fn keyring_get(name: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, name).ok()?.get_password().ok()
}

/// Minimal HTTP/1.1 client for the engine's local API (127.0.0.1 only, per-launch token).
fn core_rpc(app: &AppHandle, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let ep = app.state::<Core>().endpoint.lock().unwrap().clone().ok_or("The memory engine is not running")?;
    let body = serde_json::json!({ "method": method, "params": params }).to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", ep.port)).map_err(|e| e.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
    let req = format!(
        "POST /api/rpc HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        ep.port,
        ep.token,
        body.len(),
        body
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut resp = String::new();
    stream.read_to_string(&mut resp).map_err(|e| e.to_string())?;
    let json = resp.split("\r\n\r\n").nth(1).ok_or("Empty response from the memory engine")?;
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
        return Err(msg.to_string());
    }
    Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null))
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
    core.exited.store(false, Ordering::SeqCst);
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
                                    let h = handle.clone();
                                    std::thread::spawn(move || refresh_tray(&h));
                                }
                                Err(e) => log::error!("bad ready line from moth-core: {e}"),
                            }
                        } else if let Some(rest) = line.trim().strip_prefix("MOTH_STOPPED ") {
                            log::info!("memory engine stopped cleanly: {rest}");
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
                    core.exited.store(true, Ordering::SeqCst);
                    if core.quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    // Crash recovery: restart with backoff; give up after repeated fast failures.
                    // Only one engine is ever supervised at a time (the old child is gone at this point).
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

/// Asks the engine to stop cleanly (finish or re-queue the current job, unload the model, checkpoint and close
/// the database), waits for it, and only force-stops it if it does not exit in time.
fn stop_core(app: &AppHandle) {
    let core = app.state::<Core>();
    core.quitting.store(true, Ordering::SeqCst);
    let child = core.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.write(b"{\"type\":\"shutdown\"}\n");
        let deadline = Instant::now() + Duration::from_secs(15);
        while !core.exited.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        if !core.exited.load(Ordering::SeqCst) {
            log::warn!("memory engine did not stop in time; forcing it");
            let _ = child.kill();
        }
    }
}

fn quit_completely(app: &AppHandle) {
    for label in ["main", "capture"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
    let _ = app.global_shortcut().unregister_all();
    let h = app.clone();
    std::thread::spawn(move || {
        stop_core(&h);
        h.exit(0);
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn navigate(app: &AppHandle, page: &str) {
    show_main(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("navigate", page.to_string());
    }
}

/// The small Quick Capture window: created on first use, then shown/hidden. It never steals focus by itself;
/// it only appears when the user presses the shortcut or picks it from the tray.
fn show_capture(app: &AppHandle) {
    let w = match app.get_webview_window("capture") {
        Some(w) => w,
        None => match WebviewWindowBuilder::new(app, "capture", WebviewUrl::App("index.html#capture".into()))
            .title("MOTH Quick Capture")
            .inner_size(560.0, 330.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .center()
            .visible(false)
            .build()
        {
            Ok(w) => w,
            Err(e) => {
                log::error!("could not open Quick Capture: {e}");
                return;
            }
        },
    };
    let _ = w.center();
    let _ = w.show();
    let _ = w.set_focus();
    let _ = w.emit("capture-open", ());
}

/// Updates the tray labels from the engine's real state (learning paused, Privacy Mode).
fn refresh_tray(app: &AppHandle) {
    let state = match core_rpc(app, "system.state", serde_json::json!({})) {
        Ok(v) => v,
        Err(_) => return,
    };
    let paused = state.get("learning_paused").and_then(|v| v.as_bool()).unwrap_or(false);
    let privacy = state.get("privacy").and_then(|v| v.as_bool()).unwrap_or(false);
    let items = app.state::<TrayItems>();
    if let Some(item) = items.learning.lock().unwrap().as_ref() {
        let _ = item.set_text(if paused { "Resume Learning" } else { "Pause Learning" });
    }
    if let Some(item) = items.privacy.lock().unwrap().as_ref() {
        let _ = item.set_checked(privacy);
    }
    if let Some(tray) = app.tray_by_id("moth") {
        let tip = if privacy {
            "MOTH — Privacy Mode (not learning)"
        } else if paused {
            "MOTH — learning paused"
        } else {
            "MOTH — running"
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    let _ = app.emit("system-state", state);
}

fn tray_toggle(app: &AppHandle, what: &str) {
    let h = app.clone();
    let what = what.to_string();
    std::thread::spawn(move || {
        let state = core_rpc(&h, "system.state", serde_json::json!({})).unwrap_or_default();
        let r = if what == "learning" {
            let paused = state.get("learning_paused").and_then(|v| v.as_bool()).unwrap_or(false);
            core_rpc(&h, "automation.pause", serde_json::json!({ "paused": !paused }))
        } else {
            let on = state.get("privacy").and_then(|v| v.as_bool()).unwrap_or(false);
            core_rpc(&h, "privacy.set", serde_json::json!({ "on": !on }))
        };
        if let Err(e) = r {
            log::warn!("tray action failed: {e}");
        }
        refresh_tray(&h);
    });
}

// ------------------------------------------------------------------ Windows idle time & power state
#[cfg(windows)]
fn system_snapshot() -> serde_json::Value {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut idle: Option<u64> = None;
    unsafe {
        let mut lii = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut lii) != 0 {
            idle = Some((GetTickCount().wrapping_sub(lii.dwTime) / 1000) as u64);
        }
    }
    let mut on_battery: Option<bool> = None;
    let mut saver: Option<bool> = None;
    unsafe {
        let mut ps: SYSTEM_POWER_STATUS = std::mem::zeroed();
        if GetSystemPowerStatus(&mut ps) != 0 {
            if ps.ACLineStatus != 255 {
                on_battery = Some(ps.ACLineStatus == 0);
            }
            saver = Some(ps.SystemStatusFlag == 1);
        }
    }
    serde_json::json!({ "type": "system", "idle_seconds": idle, "on_battery": on_battery, "battery_saver": saver })
}

#[cfg(not(windows))]
fn system_snapshot() -> serde_json::Value {
    serde_json::json!({ "type": "system", "idle_seconds": null, "on_battery": null, "battery_saver": null })
}

fn start_system_reporter(app: &AppHandle) {
    let h = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let core = h.state::<Core>();
        if core.quitting.load(Ordering::SeqCst) {
            break;
        }
        let line = format!("{}\n", system_snapshot());
        if let Some(child) = core.child.lock().unwrap().as_mut() {
            let _ = child.write(line.as_bytes());
        }
        refresh_tray(&h);
    });
}

// ------------------------------------------------------------------ commands
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

/// Registers (or with `None`, removes) the global Quick Capture shortcut, e.g. "Ctrl+Alt+M".
#[tauri::command]
fn set_capture_shortcut(app: AppHandle, shortcut: Option<String>) -> Result<Option<String>, String> {
    let gs = app.global_shortcut();
    let items = app.state::<TrayItems>();
    if let Some(old) = items.shortcut.lock().unwrap().take() {
        let _ = gs.unregister(old.as_str());
    }
    let label = match shortcut.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            gs.register(s).map_err(|e| format!("Could not use {s}: {e}. Another app may already use it."))?;
            *items.shortcut.lock().unwrap() = Some(s.to_string());
            Some(s.to_string())
        }
        None => None,
    };
    if let Some(item) = items.capture.lock().unwrap().as_ref() {
        let text = match &label {
            Some(s) => format!("Quick Capture ({s})"),
            None => "Quick Capture".to_string(),
        };
        let _ = item.set_text(text);
    }
    Ok(label)
}

#[tauri::command]
fn open_capture(app: AppHandle) {
    show_capture(&app);
}

#[tauri::command]
fn hide_capture(app: AppHandle) {
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn open_in_main(app: AppHandle, page: String) {
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.hide();
    }
    navigate(&app, &page);
}

#[tauri::command]
fn tray_refresh(app: AppHandle) {
    std::thread::spawn(move || refresh_tray(&app));
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    quit_completely(&app);
}

#[derive(Serialize)]
struct ShellInfo {
    version: String,
    log_dir: String,
    launched_minimized: bool,
}

#[tauri::command]
fn shell_info(app: AppHandle) -> ShellInfo {
    ShellInfo {
        version: app.package_info().version.to_string(),
        log_dir: app.path().app_log_dir().map(|p| p.display().to_string()).unwrap_or_default(),
        launched_minimized: std::env::args().any(|a| a == "--minimized"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch (e.g. clicking the shortcut while MOTH runs in the tray) just shows the window:
        // there is only ever one MOTH process and one memory engine.
        // `MOTH.exe --quit` asks the running instance to quit completely (used by scripts and the installer smoke test).
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--quit") {
                quit_completely(app);
            } else {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        show_capture(app);
                    }
                })
                .build(),
        )
        .manage(Core::default())
        .manage(TrayItems::default())
        .invoke_handler(tauri::generate_handler![
            core_endpoint,
            secret_set,
            secret_get,
            secret_delete,
            restart_engine,
            set_keep_in_tray,
            shell_info,
            set_capture_shortcut,
            open_capture,
            hide_capture,
            open_in_main,
            tray_refresh,
            quit_app
        ])
        .setup(|app| {
            app.state::<Core>().keep_in_tray.store(true, Ordering::SeqCst);

            let open = MenuItem::with_id(app, "open", "Open MOTH", true, None::<&str>)?;
            let mind = MenuItem::with_id(app, "mind", "Open The Mind", true, None::<&str>)?;
            let cortex = MenuItem::with_id(app, "cortex", "Open Cortex", true, None::<&str>)?;
            let capture = MenuItem::with_id(app, "capture", "Quick Capture", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let learning = MenuItem::with_id(app, "learning", "Pause Learning", true, None::<&str>)?;
            let privacy = CheckMenuItem::with_id(app, "privacy", "Privacy Mode", true, false, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let restart = MenuItem::with_id(app, "restart", "Restart memory engine", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit MOTH Completely", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &mind, &cortex, &capture, &sep1, &learning, &privacy, &settings, &sep2, &restart, &quit])?;
            {
                let items = app.state::<TrayItems>();
                *items.learning.lock().unwrap() = Some(learning.clone());
                *items.privacy.lock().unwrap() = Some(privacy.clone());
                *items.capture.lock().unwrap() = Some(capture.clone());
            }
            let mut tray = TrayIconBuilder::with_id("moth").tooltip("MOTH").menu(&menu).show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id().as_ref() {
                "open" => show_main(app),
                "mind" => navigate(app, "mind"),
                "cortex" => navigate(app, "cortex"),
                "settings" => navigate(app, "settings"),
                "capture" => show_capture(app),
                "learning" => tray_toggle(app, "learning"),
                "privacy" => tray_toggle(app, "privacy"),
                "restart" => restart_engine(app.clone()),
                "quit" => quit_completely(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| match event {
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => show_main(tray.app_handle()),
                TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => show_main(tray.app_handle()),
                _ => {}
            })
            .build(app)?;

            if std::env::args().any(|a| a == "--quit") {
                // Nothing was running: nothing to quit.
                app.handle().exit(0);
                return Ok(());
            }
            // Started by Windows ("Start with Windows"): stay in the tray, don't open the window.
            // The local model is never loaded at start-up; it loads on demand.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            spawn_core(app.handle());
            start_system_reporter(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let core = window.state::<Core>();
                if window.label() == "capture" {
                    api.prevent_close();
                    let _ = window.hide();
                } else if core.keep_in_tray.load(Ordering::SeqCst) && !core.quitting.load(Ordering::SeqCst) {
                    // Close = hide to tray. The engine, MCP access and background jobs keep running.
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit("hidden-to-tray", ());
                } else if !core.quitting.load(Ordering::SeqCst) {
                    // "Keep running in the tray" is off: closing the window quits MOTH completely.
                    api.prevent_close();
                    quit_completely(window.app_handle());
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

    #[test]
    fn system_snapshot_is_well_formed() {
        let v = system_snapshot();
        assert_eq!(v["type"], "system");
        assert!(v.get("idle_seconds").is_some());
    }
}
