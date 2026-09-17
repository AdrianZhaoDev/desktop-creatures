use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
pub static SETTINGS_FOCUSED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
type Bindings = BTreeMap<String, String>;
const ACTIONS: [(&str, &str); 5] = [
    ("pause", "暂停"),
    ("resume", "继续"),
    ("toggle", "切换暂停 / 继续"),
    ("hide", "隐藏桌面生物"),
    ("save", "立即保存"),
];
#[derive(Default)]
struct State {
    bindings: Bindings,
    active: Vec<Shortcut>,
    unavailable: Vec<String>,
}
#[derive(Serialize)]
pub struct Settings {
    bindings: Bindings,
    defaults: Bindings,
    unavailable: Vec<String>,
}
fn defaults() -> Bindings {
    [
        ("pause", "Ctrl+Alt+Shift+F9"),
        ("resume", "Ctrl+Alt+Shift+F10"),
        ("toggle", "Ctrl+Alt+Shift+F11"),
        ("hide", "Ctrl+Alt+Shift+F12"),
        ("save", "Ctrl+Alt+Shift+S"),
    ]
    .into_iter()
    .map(|(a, b)| (a.into(), b.into()))
    .collect()
}
fn parse(bindings: &Bindings) -> Result<Vec<Shortcut>, String> {
    if bindings.len() != ACTIONS.len() || ACTIONS.iter().any(|(id, _)| !bindings.contains_key(*id))
    {
        return Err("快捷键配置项目不完整".into());
    }
    let mut seen = HashSet::new();
    seen.insert("F12".parse::<Shortcut>().unwrap().id());
    let mut result = Vec::new();
    for (id, label) in ACTIONS {
        let text = bindings[id].trim();
        if text.is_empty() {
            continue;
        }
        let key = text
            .parse::<Shortcut>()
            .map_err(|_| format!("{label}：快捷键格式无效"))?;
        if !seen.insert(key.id()) {
            return Err(format!("{label}：{text} 重复或占用了保留的 F12"));
        }
        if !text.contains('+')
            && !matches!(
                text,
                "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11"
            )
        {
            return Err(format!("{label}：字母和数字必须搭配修饰键"));
        }
        result.push(key);
    }
    Ok(result)
}
fn handler(app: &AppHandle, key: &Shortcut, event: ShortcutEvent) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    if key.id() == "F12".parse::<Shortcut>().unwrap().id() {
        super::window_manager::hide_overlay(app);
        return;
    }
    let action = app.state::<Mutex<State>>().try_lock().ok().and_then(|s| {
        s.bindings
            .iter()
            .find(|(_, v)| {
                v.parse::<Shortcut>()
                    .ok()
                    .is_some_and(|k| k.id() == key.id())
            })
            .map(|(a, _)| a.clone())
    });
    match action.as_deref() {
        Some("pause") => super::safety::set_pause(app, true),
        Some("resume") => super::safety::set_pause(app, false),
        Some("toggle") => super::safety::toggle_pause(app),
        Some("hide") => super::window_manager::hide_overlay(app),
        Some("save") => super::controls::emit(app, "save"),
        _ => {}
    }
}
pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let path = super::storage::app_data_dir(app)?.join("shortcuts.json");
    let bindings = std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Bindings>(&b).ok())
        .filter(|b| parse(b).is_ok())
        .unwrap_or_else(defaults);
    let mut state = State {
        bindings,
        ..Default::default()
    };
    if !std::env::args().any(|a| a == "--smoke-test") {
        for key in parse(&state.bindings)?
            .into_iter()
            .chain(["F12".parse().unwrap()])
        {
            match app.global_shortcut().on_shortcut(key, handler) {
                Ok(()) => state.active.push(key),
                Err(_) => state.unavailable.push(key.to_string()),
            }
        }
    }
    app.manage(Mutex::new(state));
    refresh_menu(app);
    Ok(())
}
pub fn refresh_menu(app: &AppHandle) {
    let state = app.state::<Mutex<State>>();
    let s = state.lock().unwrap();
    for (action, label) in ACTIONS {
        let value = &s.bindings[action];
        let unavailable = value
            .parse::<Shortcut>()
            .ok()
            .is_some_and(|key| !s.active.iter().any(|k| k.id() == key.id()));
        let text = if value.is_empty() {
            format!("{label}（未设置）")
        } else {
            format!(
                "{label}    {value}{}",
                if unavailable {
                    "（快捷键被占用）"
                } else {
                    ""
                }
            )
        };
        super::controls::shortcut_label(app, action, &text);
    }
}
#[tauri::command]
pub fn get_shortcut_settings(app: AppHandle) -> Settings {
    let state = app.state::<Mutex<State>>();
    let s = state.lock().unwrap();
    Settings {
        bindings: s.bindings.clone(),
        defaults: defaults(),
        unavailable: s.unavailable.clone(),
    }
}
#[tauri::command]
pub fn save_shortcut_settings(app: AppHandle, bindings: Bindings) -> Result<Settings, String> {
    let next = parse(&bindings)?;
    let path = super::storage::app_data_dir(&app)?.join("shortcuts.json");
    let bytes = serde_json::to_vec_pretty(&bindings).map_err(|e| e.to_string())?;
    let state = app.state::<Mutex<State>>();
    let mut s = state.lock().map_err(|_| "快捷键设置暂不可用")?;
    let mut added = Vec::new();
    for key in &next {
        if s.active.iter().any(|k| k.id() == key.id()) {
            continue;
        }
        if let Err(e) = app.global_shortcut().on_shortcut(*key, handler) {
            for k in added {
                let _ = app.global_shortcut().unregister(k);
            }
            return Err(format!(
                "{key} 无法注册，可能被其他应用占用。原设置保持不变。{e}"
            ));
        }
        added.push(*key);
    }
    if let Err(e) = super::storage::atomic_write(&path, &bytes, true) {
        for k in added {
            let _ = app.global_shortcut().unregister(k);
        }
        return Err(e);
    }
    let emergency = "F12".parse::<Shortcut>().unwrap();
    let old = std::mem::take(&mut s.active);
    let mut retained = Vec::new();
    for key in old {
        if key.id() == emergency.id() || next.iter().any(|k| k.id() == key.id()) {
            retained.push(key);
        } else if app.global_shortcut().unregister(key).is_err() {
            retained.push(key);
        }
    }
    retained.extend(added);
    s.active = retained;
    s.bindings = bindings;
    s.unavailable.retain(|v| {
        v.parse::<Shortcut>()
            .ok()
            .is_some_and(|k| k.id() == emergency.id())
    });
    drop(s);
    refresh_menu(&app);
    Ok(get_shortcut_settings(app))
}
pub fn open(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("shortcut-settings") {
        w.show().map_err(|e| e.to_string())?;
        return w.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(
        app,
        "shortcut-settings",
        WebviewUrl::App("shortcuts.html".into()),
    )
    .title("快捷键设置 · 全面蟑螂模拟器")
    .always_on_top(true)
    .inner_size(620.0, 620.0)
    .min_inner_size(550.0, 580.0)
    .resizable(true)
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_are_valid() {
        assert_eq!(parse(&defaults()).unwrap().len(), 5);
    }
    #[test]
    fn duplicates_and_reserved_keys_are_rejected() {
        let mut b = defaults();
        b.insert("save".into(), b["pause"].clone());
        assert!(parse(&b).is_err());
        b.insert("save".into(), "F12".into());
        assert!(parse(&b).is_err());
    }
    #[test]
    fn disabling_is_allowed_but_plain_letters_are_not() {
        let mut b = defaults();
        b.insert("save".into(), String::new());
        assert_eq!(parse(&b).unwrap().len(), 4);
        b.insert("save".into(), "S".into());
        assert!(parse(&b).is_err());
    }
}
