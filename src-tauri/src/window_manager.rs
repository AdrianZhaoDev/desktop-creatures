use std::collections::HashSet;

use serde::Serialize;
use tauri::{
    Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const OVERLAY_LABEL: &str = "overlay-primary";
pub const SECONDARY_PREFIX: &str = "overlay-screen-";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub name: Option<String>,
    pub position: PointI32,
    pub size: SizeU32,
    pub scale_factor: f64,
    pub primary: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PointI32 {
    pub x: i32,
    pub y: i32,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SizeU32 {
    pub width: u32,
    pub height: u32,
}

fn monitor_id(monitor: &Monitor) -> String {
    let p = monitor.position();
    let s = monitor.size();
    format!(
        "{}x{}-{}-{}",
        s.width,
        s.height,
        encode_coord(p.x),
        encode_coord(p.y)
    )
}

fn encode_coord(value: i32) -> String {
    if value < 0 {
        format!("n{}", value.unsigned_abs())
    } else {
        format!("p{value}")
    }
}

fn same_monitor(first: &Monitor, second: &Monitor) -> bool {
    first.position() == second.position() && first.size() == second.size()
}

fn display_info(monitor: &Monitor, primary: Option<&Monitor>) -> DisplayInfo {
    DisplayInfo {
        id: monitor_id(monitor),
        name: monitor.name().cloned(),
        position: PointI32 {
            x: monitor.position().x,
            y: monitor.position().y,
        },
        size: SizeU32 {
            width: monitor.size().width,
            height: monitor.size().height,
        },
        scale_factor: monitor.scale_factor(),
        primary: primary.is_some_and(|item| same_monitor(item, monitor)),
    }
}

pub(crate) fn configure_window_on_monitor(
    window: &WebviewWindow,
    monitor: &Monitor,
) -> tauri::Result<()> {
    let position = monitor.position();
    let size = monitor.size();
    window.set_position(PhysicalPosition::new(position.x, position.y))?;
    window.set_size(PhysicalSize::new(size.width, size.height))?;
    window.set_decorations(false)?;
    window.set_resizable(false)?;
    window.set_skip_taskbar(true)?;
    window.set_always_on_top(true)?;
    window.set_focusable(false)?;
    window.set_ignore_cursor_events(true)?;
    Ok(())
}

pub fn configure_overlay(window: &WebviewWindow) -> tauri::Result<()> {
    // Once initialized, owner geometry changes only inside the move transaction.
    // Tray show/late ready cannot race it and restore a previously read binding.
    let monitor = if window.label() == OVERLAY_LABEL {
        let binding = window.state::<crate::campaign_display::CampaignDisplay>();
        let Ok(state) = binding.0.try_lock() else {
            return Ok(());
        };
        if state.topology_revision > 0 {
            return Ok(());
        }
        // Match DisplayState::observe even if Windows reports no primary.
        window.primary_monitor()?.or(window
            .available_monitors()?
            .into_iter()
            .min_by_key(monitor_id))
    } else {
        window.current_monitor()?.or(window.primary_monitor()?)
    };
    if let Some(monitor) = monitor {
        configure_window_on_monitor(window, &monitor)?;
    }
    Ok(())
}

// Caller holds the binding mutex. Never reuse passive WebView identities.
fn sync_passives(
    app: &tauri::AppHandle,
    monitors: &[Monitor],
    owner_display: Option<&str>,
) -> tauri::Result<()> {
    static NEXT_PASSIVE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let mut expected = HashSet::new();
    for monitor in monitors {
        let id = monitor_id(monitor);
        if Some(id.as_str()) == owner_display {
            continue;
        }
        let prefix = format!("{SECONDARY_PREFIX}{id}-instance-");
        let window = if let Some((_, existing)) = app
            .webview_windows()
            .into_iter()
            .find(|(label, _)| label.starts_with(&prefix))
        {
            existing
        } else {
            let incarnation = NEXT_PASSIVE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let label = format!("{prefix}{incarnation}");
            let url = WebviewUrl::App(format!("index.html?display={id}").into());
            let window = WebviewWindowBuilder::new(app, &label, url)
                .title("桌面生物")
                .transparent(true)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focusable(false)
                .shadow(false)
                .resizable(false)
                .visible(false)
                .build()?;
            app.state::<crate::health::RenderHealth>().activate(&label);
            window
        };
        expected.insert(window.label().to_owned());
        configure_window_on_monitor(&window, monitor)?;
    }
    for (label, window) in app.webview_windows() {
        if label.starts_with(SECONDARY_PREFIX) && !expected.contains(&label) {
            app.state::<crate::health::RenderHealth>().forget(&label);
            window.hide()?;
            window.close()?;
        }
    }
    Ok(())
}

pub fn sync_display_overlays(app: &tauri::AppHandle) -> Result<Vec<DisplayInfo>, String> {
    let mut state = crate::campaign_display::lock(app)?;
    let initializing = state.topology_revision == 0;
    crate::campaign_display::refresh(app, &mut state)?;
    let owner = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or("Campaign owner unavailable")?;
    let monitors = owner.available_monitors().map_err(|e| e.to_string())?;
    if initializing {
        // Setup has no Session yet. Align geometry to the same topology snapshot
        // used for the initial binding, including a primary change during setup.
        if let Some(target) = state.display_id.as_deref() {
            let monitor = monitors
                .iter()
                .find(|m| monitor_id(m) == target)
                .ok_or("Initial display disconnected")?;
            configure_window_on_monitor(&owner, monitor).map_err(|e| e.to_string())?;
        }
    }
    // A topology change needs a checkpoint/remap transaction before owner movement.
    let physical_owner = owner
        .current_monitor()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(monitor_id);
    let exclude = if monitors
        .iter()
        .any(|m| Some(monitor_id(m).as_str()) == state.display_id.as_deref())
    {
        state.display_id.as_deref()
    } else {
        physical_owner.as_deref()
    };
    sync_passives(app, &monitors, exclude).map_err(|e| e.to_string())?;
    Ok(state.displays.clone())
}

pub fn move_campaign_windows(app: &tauri::AppHandle, target: &str) -> tauri::Result<()> {
    let owner = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(tauri::Error::WindowNotFound)?;
    let monitors = owner.available_monitors()?;
    let monitor = monitors
        .iter()
        .find(|m| monitor_id(m) == target)
        .ok_or(tauri::Error::WindowNotFound)?;
    configure_window_on_monitor(&owner, monitor)?;
    sync_passives(app, &monitors, Some(target))?;
    crate::bin_window::move_to_monitor(app, monitor)?;
    Ok(())
}

pub fn current_display(window: &WebviewWindow) -> tauri::Result<Option<DisplayInfo>> {
    let primary = window.primary_monitor()?;
    Ok(window
        .current_monitor()?
        .as_ref()
        .map(|monitor| display_info(monitor, primary.as_ref())))
}

pub fn list_displays(app: &tauri::AppHandle) -> tauri::Result<Vec<DisplayInfo>> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let primary = window.primary_monitor()?;
    Ok(window
        .available_monitors()?
        .iter()
        .map(|monitor| display_info(monitor, primary.as_ref()))
        .collect())
}

pub fn hide_overlay(app: &tauri::AppHandle) {
    crate::interaction::suspend_input();
    crate::campaign_interface::restore(app);
    // Emergency hiding must stop campaign pressure even if WebView cannot respond.
    crate::safety::set_pause(app, true);
    app.state::<crate::health::RenderHealth>().forget_recovery();
    for (label, window) in app.webview_windows() {
        if label == OVERLAY_LABEL
            || label.starts_with(SECONDARY_PREFIX)
            || label == crate::bin_window::BIN_LABEL
        {
            let _ = window.hide();
        }
    }
}

pub fn show_overlay(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if app
            .state::<crate::health::RenderHealth>()
            .is_retired(&label)
        {
            continue;
        }
        if label == crate::bin_window::BIN_LABEL {
            let _ = window.show();
            crate::interaction::update_bin_rect(&window);
        } else if (label == OVERLAY_LABEL || label.starts_with(SECONDARY_PREFIX))
            && configure_overlay(&window).is_ok()
        {
            let _ = window.show();
        }
    }
    crate::interaction::resume_input();
}

#[cfg(test)]
mod tests {
    use super::encode_coord;
    #[test]
    fn labels_encode_negative_coordinates_without_invalid_characters() {
        assert_eq!(encode_coord(-1920), "n1920");
        assert_eq!(encode_coord(0), "p0");
    }
}
