use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{
    Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const BIN_LABEL: &str = "trash-bin";
const BIN_WIDTH_DIP: f64 = 76.0;
const BIN_HEIGHT_DIP: f64 = 88.0;
const BIN_MARGIN_DIP: f64 = 16.0;
static INTAKE: std::sync::Mutex<(f64, f64)> = std::sync::Mutex::new((38.0, 39.0));
#[tauri::command]
pub fn set_bin_intake(window: WebviewWindow, x_dip: f64, y_dip: f64) -> Result<(), String> {
    if window.label() != BIN_LABEL
        || !x_dip.is_finite()
        || !y_dip.is_finite()
        || !(0.0..=BIN_WIDTH_DIP).contains(&x_dip)
        || !(0.0..=BIN_HEIGHT_DIP).contains(&y_dip)
    {
        return Err("桶口坐标无效".into());
    }
    *INTAKE.lock().map_err(|_| "桶口坐标锁失败")? = (x_dip, y_dip);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
    mouth_x: f64,
    mouth_y: f64,
}
#[tauri::command]
pub fn bin_geometry(app: tauri::AppHandle) -> Result<BinGeometry, String> {
    let w = app
        .get_webview_window(BIN_LABEL)
        .ok_or("垃圾桶窗口不可用")?;
    let p = w.outer_position().map_err(|e| e.to_string())?;
    let s = w.outer_size().map_err(|e| e.to_string())?;
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let intake = *INTAKE.lock().map_err(|_| "桶口坐标锁失败")?;
    Ok(BinGeometry {
        x: p.x as f64,
        y: p.y as f64,
        width: s.width as f64,
        height: s.height as f64,
        scale,
        mouth_x: p.x as f64 + intake.0 * scale,
        mouth_y: p.y as f64 + intake.1 * scale,
    })
}

#[derive(Serialize, Deserialize)]
struct SavedPosition {
    x: i32,
    y: i32,
}
fn position_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(super::storage::app_data_dir(app)?.join("bin-position.json"))
}

pub fn create(app: &tauri::App) -> tauri::Result<WebviewWindow> {
    let overlay = app
        .get_webview_window(super::window_manager::OVERLAY_LABEL)
        .ok_or(tauri::Error::WindowNotFound)?;
    let primary = overlay
        .primary_monitor()?
        .or(overlay.current_monitor()?)
        .ok_or(tauri::Error::WindowNotFound)?;
    let scale = primary.scale_factor();
    let area = primary.work_area();
    let fallback = PhysicalPosition::new(
        area.position.x + area.size.width as i32
            - ((BIN_WIDTH_DIP + BIN_MARGIN_DIP) * scale) as i32,
        area.position.y + area.size.height as i32
            - ((BIN_HEIGHT_DIP + BIN_MARGIN_DIP) * scale) as i32,
    );
    let saved = position_path(app.handle())
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<SavedPosition>(&text).ok())
        .map(|p| PhysicalPosition::new(p.x, p.y));
    let position = saved
        .filter(|p| {
            overlay.available_monitors().ok().is_some_and(|monitors| {
                monitors.iter().any(|m| {
                    let a = m.work_area();
                    p.x >= a.position.x
                        && p.x
                            < a.position.x + a.size.width as i32
                                - (BIN_WIDTH_DIP * m.scale_factor()) as i32
                        && p.y >= a.position.y
                        && p.y
                            < a.position.y + a.size.height as i32
                                - (BIN_HEIGHT_DIP * m.scale_factor()) as i32
                })
            })
        })
        .unwrap_or(fallback);
    let window = WebviewWindowBuilder::new(app, BIN_LABEL, WebviewUrl::App("trash.html".into()))
        .title("全面蟑螂模拟器 回收站")
        // Hover is not a browser user activation. This local-only companion needs
        // autoplay for its opt-out sound cues, without taking desktop focus.
        // Different WebView2 arguments require a distinct data directory.
        .additional_browser_args("--autoplay-policy=no-user-gesture-required")
        .data_directory(app.path().app_local_data_dir()?.join("cat-bin-webview"))
        .inner_size(BIN_WIDTH_DIP, BIN_HEIGHT_DIP)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(false)
        .shadow(false)
        .resizable(false)
        .visible(true)
        .build()?;
    window.set_position(position)?;
    window.set_size(PhysicalSize::new(
        (BIN_WIDTH_DIP * scale) as u32,
        (BIN_HEIGHT_DIP * scale) as u32,
    ))?;
    super::interaction::update_bin_rect(&window);
    Ok(window)
}

pub fn persist_position(window: &tauri::Window) {
    if window.label() != BIN_LABEL {
        return;
    }
    if let Ok(position) = window.outer_position() {
        if let Ok(path) = position_path(window.app_handle()) {
            let _ = fs::write(
                path,
                serde_json::to_vec(&SavedPosition {
                    x: position.x,
                    y: position.y,
                })
                .unwrap_or_default(),
            );
        }
    }
    if let Some(webview) = window.app_handle().get_webview_window(BIN_LABEL) {
        super::interaction::update_bin_rect(&webview);
    }
}

#[tauri::command]
pub fn start_bin_drag(window: WebviewWindow) -> Result<(), String> {
    if window.label() != BIN_LABEL {
        return Err("只有垃圾桶窗口可以开始拖动".to_owned());
    }
    if super::interaction::display_input_blocked() {
        return Err("Display move is in progress".into());
    }
    window.start_dragging().map_err(|error| error.to_string())
}

/// A migration places the same bin on the target work area, with target DPI.
pub fn move_to_monitor(app: &tauri::AppHandle, monitor: &tauri::Monitor) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(BIN_LABEL) else {
        return Err(tauri::Error::WindowNotFound);
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    window.set_position(PhysicalPosition::new(
        area.position.x
            + (area.size.width as i32 - ((BIN_WIDTH_DIP + BIN_MARGIN_DIP) * scale) as i32).max(0),
        area.position.y
            + (area.size.height as i32 - ((BIN_HEIGHT_DIP + BIN_MARGIN_DIP) * scale) as i32).max(0),
    ))?;
    window.set_size(PhysicalSize::new(
        (BIN_WIDTH_DIP * scale) as u32,
        (BIN_HEIGHT_DIP * scale) as u32,
    ))?;
    super::interaction::update_bin_rect(&window);
    Ok(())
}

/// Cancel a Windows modal bin drag before changing physical monitor geometry.
pub fn cancel_native_drag(app: &tauri::AppHandle) -> Result<(), String> {
    use windows::Win32::{
        Foundation::{LPARAM, WPARAM},
        UI::WindowsAndMessaging::{PostMessageW, WM_CANCELMODE},
    };
    for label in [BIN_LABEL, super::window_manager::OVERLAY_LABEL] {
        let window = app
            .get_webview_window(label)
            .ok_or("Migration window unavailable")?;
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        unsafe {
            PostMessageW(Some(hwnd), WM_CANCELMODE, WPARAM(0), LPARAM(0))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_size_preserves_desktop_visual_hierarchy() {
        assert!(BIN_HEIGHT_DIP < 96.0);
        assert!(BIN_HEIGHT_DIP > 44.0);
        assert!(BIN_WIDTH_DIP < BIN_HEIGHT_DIP);
    }
}
