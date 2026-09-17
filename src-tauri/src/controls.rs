use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    AppHandle, Emitter, Manager, Wry,
    menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};
use windows::{
    Win32::UI::WindowsAndMessaging::{IDYES, MB_ICONQUESTION, MB_YESNO, MessageBoxW},
    core::w,
};
pub static MENU_OPEN: AtomicBool = AtomicBool::new(false);

pub struct Controls {
    menu: Menu<Wry>,
    pause: MenuItem<Wry>,
    resume: MenuItem<Wry>,
    status: MenuItem<Wry>,
    hide: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    save: MenuItem<Wry>,
    game: CheckMenuItem<Wry>,
    idle: CheckMenuItem<Wry>,
    autosave: CheckMenuItem<Wry>,
    audio: CheckMenuItem<Wry>,
}
#[tauri::command]
pub fn show_game_menu(window: tauri::Window) -> Result<(), String> {
    super::interaction::clear_and_cancel();
    window.set_focusable(true).map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    MENU_OPEN.store(true, Ordering::SeqCst);
    let result = window
        .state::<Controls>()
        .menu
        .popup(window.clone())
        .map_err(|e| e.to_string());
    window
        .state::<super::health::RenderHealth>()
        .beat(super::window_manager::OVERLAY_LABEL.to_owned());
    MENU_OPEN.store(false, Ordering::SeqCst);
    let _ = window.set_focusable(false);
    result
}
pub fn emit(app: &AppHandle, action: &str) {
    let _ = app.emit("game://command", action);
}
pub fn pause_changed(app: &AppHandle, paused: bool) {
    if let Some(c) = app.try_state::<Controls>() {
        let _ = c.pause.set_enabled(!paused);
        let _ = c.resume.set_enabled(paused);
    }
}
pub fn quit(app: &AppHandle) {
    dispatch_exit(ExitIntent::Save, || emit(app, "quit"), || app.exit(0));
}
#[derive(Clone, Copy)]
enum ExitIntent {
    Save,
    EmergencyDiscard,
}
fn dispatch_exit(intent: ExitIntent, request_save: impl FnOnce(), exit_now: impl FnOnce()) {
    match intent {
        // No timeout: a slow or failed write may never silently discard V4 progress.
        ExitIntent::Save => request_save(),
        // A separate, explicitly labelled native action remains available if WebView fails.
        ExitIntent::EmergencyDiscard => exit_now(),
    }
}
#[tauri::command]
pub fn finish_game_exit(app: AppHandle) {
    app.exit(0);
}
#[tauri::command]
pub fn update_game_menu(
    app: AppHandle,
    mode: String,
    auto_save: bool,
    audio_enabled: bool,
    status: String,
) {
    if let Some(c) = app.try_state::<Controls>() {
        let _ = c.game.set_checked(mode == "game");
        let _ = c.idle.set_checked(mode == "idle");
        let _ = c.autosave.set_checked(auto_save);
        let _ = c.audio.set_checked(audio_enabled);
        let _ = c.status.set_text(status);
    }
    let _ = app.emit("game://audio", audio_enabled);
}
#[tauri::command]
pub async fn confirm_replace(action: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || unsafe {
        let text = if action == "new" {
            w!("重新开始将替换当前进度。请先导出需要保留的存档。是否继续？")
        } else {
            w!("即将替换当前桌面进度，原存档会保留一份备份。是否继续？")
        };
        MessageBoxW(None, text, w!("全面蟑螂模拟器"), MB_YESNO | MB_ICONQUESTION) == IDYES
    })
    .await
    .unwrap_or(false)
}
pub fn create(app: &tauri::App, unavailable: &[String]) -> tauri::Result<()> {
    let item = |id, text| MenuItem::with_id(app, id, text, true, None::<&str>);
    let show = item("show", "显示桌面生物")?;
    let hide = item("hide", "隐藏桌面生物    F12")?;
    let pause = item("pause", "暂停    Ctrl+Alt+Shift+F9")?;
    let resume = item("resume", "继续    Ctrl+Alt+Shift+F10")?;
    resume.set_enabled(false)?;
    let toggle = item("toggle", "切换暂停 / 继续    Ctrl+Alt+Shift+F11")?;
    let game = CheckMenuItem::with_id(
        app,
        "mode-game",
        "游戏模式 · 快节奏",
        true,
        true,
        None::<&str>,
    )?;
    let idle = CheckMenuItem::with_id(
        app,
        "mode-idle",
        "挂机模式 · 慢休闲",
        true,
        false,
        None::<&str>,
    )?;
    let autosave = CheckMenuItem::with_id(
        app,
        "autosave",
        "自动保存 · 每 5 秒",
        true,
        true,
        None::<&str>,
    )?;
    let audio = CheckMenuItem::with_id(app, "audio", "播放音效", true, true, None::<&str>)?;
    let save = item("save", "立即保存    Ctrl+Alt+Shift+S")?;
    let load = item("load", "读取当前存档")?;
    let export = item("export", "导出存档…")?;
    let import = item("import", "导入存档…")?;
    let new = item("new", "重新开始…")?;
    let status = MenuItem::with_id(app, "status", "尚未保存", false, None::<&str>)?;
    let companion = item("companion-settings", "人偶的小屋…")?;
    let settings = item("shortcut-settings", "设置快捷键…")?;
    let exit = item("quit", "保存并退出")?;
    let emergency_exit = item(
        "emergency-quit",
        "紧急退出（不保存） / Emergency exit without saving",
    )?;
    let interface = item("campaign-interface", "界面交互 / 点击以启用音频")?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    for (key, entry) in [
        ("F12", &hide),
        ("Ctrl+Alt+Shift+F9", &pause),
        ("Ctrl+Alt+Shift+F10", &resume),
        ("Ctrl+Alt+Shift+F11", &toggle),
        ("Ctrl+Alt+Shift+S", &save),
    ] {
        if unavailable.iter().any(|s| s == key) {
            entry.set_text(format!("{}（快捷键被占用）", entry.text()?))?;
        }
    }
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &hide,
            &pause,
            &resume,
            &toggle,
            &sep1,
            &game,
            &idle,
            &sep2,
            &save,
            &load,
            &export,
            &import,
            &new,
            &autosave,
            &status,
            &sep3,
            &audio,
            &companion,
            &settings,
            &interface,
            &exit,
            &emergency_exit,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("desktop-creatures")
        .menu(&menu)
        .tooltip("全面蟑螂模拟器")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => super::window_manager::show_overlay(app),
            "hide" => super::window_manager::hide_overlay(app),
            "pause" => super::safety::set_pause(app, true),
            "resume" => super::safety::set_pause(app, false),
            "toggle" => super::safety::toggle_pause(app),
            "companion-settings" => {
                if let Err(e) = open_companion(app) {
                    eprintln!("{e}");
                }
            }
            "shortcut-settings" => {
                if let Err(e) = super::shortcuts::open(app) {
                    eprintln!("{e}");
                }
            }
            "quit" => quit(app),
            "emergency-quit" => dispatch_exit(ExitIntent::EmergencyDiscard, || {}, || app.exit(0)),
            "campaign-interface" => {
                if let Err(error) =
                    super::campaign_interface::set_mode(app, !super::campaign_interface::active())
                {
                    eprintln!("Campaign interface mode: {error}");
                }
            }
            action => emit(app, action),
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(Controls {
        menu,
        pause,
        resume,
        status,
        hide,
        toggle,
        save,
        game,
        idle,
        autosave,
        audio,
    });
    Ok(())
}

#[cfg(test)]
mod exit_tests {
    use super::{ExitIntent, dispatch_exit};
    use std::cell::Cell;

    #[test]
    fn save_exit_only_requests_flush_and_can_be_requested_again_after_failure() {
        let requests = Cell::new(0);
        let exits = Cell::new(0);
        for _ in 0..2 {
            dispatch_exit(
                ExitIntent::Save,
                || requests.set(requests.get() + 1),
                || exits.set(exits.get() + 1),
            );
        }
        assert_eq!(requests.get(), 2);
        assert_eq!(exits.get(), 0);
    }

    #[test]
    fn explicit_emergency_exit_is_native_and_does_not_wait_for_renderer() {
        let requests = Cell::new(0);
        let exits = Cell::new(0);
        dispatch_exit(
            ExitIntent::EmergencyDiscard,
            || requests.set(requests.get() + 1),
            || exits.set(exits.get() + 1),
        );
        assert_eq!(requests.get(), 0);
        assert_eq!(exits.get(), 1);
    }
}

pub fn shortcut_label(app: &AppHandle, id: &str, text: &str) {
    if let Some(c) = app.try_state::<Controls>() {
        let item = match id {
            "pause" => &c.pause,
            "resume" => &c.resume,
            "toggle" => &c.toggle,
            "hide" => &c.hide,
            "save" => &c.save,
            _ => return,
        };
        let _ = item.set_text(text);
    }
}

pub fn open_companion(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("companion-settings") {
        w.show().map_err(|e| e.to_string())?;
        return w.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "companion-settings",
        tauri::WebviewUrl::App("companion.html".into()),
    )
    .title("人偶的小屋")
    .inner_size(900.0, 780.0)
    .min_inner_size(560.0, 650.0)
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}
