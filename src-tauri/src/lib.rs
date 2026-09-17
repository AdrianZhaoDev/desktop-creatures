mod bin_window;
mod campaign_display;
mod campaign_interface;
mod campaign_storage;
mod controls;
mod desktop_geometry;
mod desktop_surface;
mod health;
mod interaction;
mod recycle_bin;
mod safety;
mod save_dialog;
mod shortcuts;
mod storage;
mod support_bundle;
mod window_manager;

use safety::OverlayState;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use window_manager::OVERLAY_LABEL;

#[derive(serde::Serialize)]
struct CursorPoint {
    x: f64,
    y: f64,
}

#[tauri::command]
fn overlay_ready(window: tauri::WebviewWindow) -> Result<(), String> {
    if window
        .state::<health::RenderHealth>()
        .is_retired(window.label())
    {
        return Err("Overlay incarnation has been retired".into());
    }
    window_manager::configure_overlay(&window).map_err(|error| error.to_string())?;
    window
        .state::<health::RenderHealth>()
        .beat(window.label().to_owned());
    safety::emit_pause_state(window.app_handle());
    if !interaction::overlays_hidden()
        && !window
            .state::<health::RenderHealth>()
            .is_retired(window.label())
    {
        window.show().map_err(|error| error.to_string())?;
    }
    window
        .state::<health::SmokeTestState>()
        .schedule_exit_once(window.app_handle().clone());
    Ok(())
}

#[tauri::command]
fn render_heartbeat(window: tauri::WebviewWindow) {
    window.state::<health::RenderHealth>().recover(&window);
    window
        .state::<health::RenderHealth>()
        .beat(window.label().to_owned());
}

#[tauri::command]
fn cursor_position_local(window: tauri::WebviewWindow) -> Result<CursorPoint, String> {
    let cursor = window
        .cursor_position()
        .map_err(|error| error.to_string())?;
    let origin = window.outer_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    Ok(CursorPoint {
        x: (cursor.x - f64::from(origin.x)) / scale,
        y: (cursor.y - f64::from(origin.y)) / scale,
    })
}

#[tauri::command]
async fn sync_displays(app: tauri::AppHandle) -> Result<Vec<window_manager::DisplayInfo>, String> {
    window_manager::sync_display_overlays(&app).map_err(|error| error.to_string())
}

#[tauri::command]
fn current_display(
    window: tauri::WebviewWindow,
) -> Result<Option<window_manager::DisplayInfo>, String> {
    window_manager::current_display(&window).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_displays(app: tauri::AppHandle) -> Result<Vec<window_manager::DisplayInfo>, String> {
    window_manager::list_displays(&app).map_err(|error| error.to_string())
}

#[tauri::command]
fn steam_preview_enabled() -> bool {
    std::env::args().any(|arg| arg == "--steam-preview")
}

// Runtime authority is independent of the preview flag's routing/storage policy.
// Activation is process-long, so reloads cannot downgrade existing native bindings.
static CAMPAIGN_RUNTIME_ACTIVE: AtomicBool = AtomicBool::new(false);

fn runtime_enabled(preview: bool, activation: &AtomicBool) -> bool {
    preview || activation.load(Ordering::SeqCst)
}

pub(crate) fn campaign_runtime_enabled() -> bool {
    runtime_enabled(steam_preview_enabled(), &CAMPAIGN_RUNTIME_ACTIVE)
}

fn activate_campaign_runtime(owner: &str, activation: &AtomicBool) -> Result<(), String> {
    if owner != OVERLAY_LABEL {
        return Err("Only overlay-primary can activate the campaign runtime".into());
    }
    activation.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn campaign_activate_runtime(window: tauri::WebviewWindow) -> Result<(), String> {
    activate_campaign_runtime(window.label(), &CAMPAIGN_RUNTIME_ACTIVE)
}

#[tauri::command]
fn campaign_set_paused(app: tauri::AppHandle, paused: bool) -> Result<(), String> {
    if !campaign_runtime_enabled() {
        return Err("Campaign runtime is not active".into());
    }
    safety::set_pause(&app, paused);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shortcuts = tauri_plugin_global_shortcut::Builder::new().build();
    tauri::Builder::default()
        .manage(OverlayState::default())
        .manage(campaign_display::CampaignDisplay::default())
        .manage(health::RenderHealth::default())
        .manage(health::SmokeTestState::from_args())
        .plugin(shortcuts)
        .setup(move |app| {
            app.state::<health::SmokeTestState>().record("setup");
            let window = app
                .get_webview_window(OVERLAY_LABEL)
                .ok_or_else(|| format!("missing window {OVERLAY_LABEL}"))?;
            window_manager::configure_overlay(&window)?;
            window_manager::sync_display_overlays(app.handle()).map_err(std::io::Error::other)?;
            bin_window::create(app)?;
            controls::create(app, &[])?;
            shortcuts::initialize(app.handle())?;
            health::start_watchdog(app.handle().clone());
            interaction::start(app.handle().clone());
            desktop_surface::start();
            if desktop_surface::companion_validation_enabled()
                && !steam_preview_enabled()
                && desktop_surface::companion_benchmark_mode() == "none"
            {
                controls::open_companion(app.handle())?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .app_handle()
                    .state::<health::RenderHealth>()
                    .forget(window.label());
            }
            if window.label() == window_manager::OVERLAY_LABEL
                && matches!(
                    event,
                    tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed
                )
            {
                campaign_interface::restore(window.app_handle());
            }
            if window.label() == "shortcut-settings" {
                match event {
                    tauri::WindowEvent::Focused(focused) => shortcuts::SETTINGS_FOCUSED
                        .store(*focused, std::sync::atomic::Ordering::SeqCst),
                    tauri::WindowEvent::Destroyed => shortcuts::SETTINGS_FOCUSED
                        .store(false, std::sync::atomic::Ordering::SeqCst),
                    _ => {}
                }
            }

            if window.label() != bin_window::BIN_LABEL {
                return;
            }
            match event {
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    bin_window::persist_position(window)
                }
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    recycle_bin::recycle_external_paths(window.app_handle().clone(), paths.clone())
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            campaign_display::campaign_display_state,
            campaign_display::campaign_move_display,
            campaign_display::campaign_complete_display_move,
            campaign_display::campaign_abort_display_move,
            desktop_surface::desktop_surface,
            desktop_surface::desktop_surface_v2,
            steam_preview_enabled,
            campaign_activate_runtime,
            campaign_set_paused,
            desktop_surface::companion_validation_enabled,
            desktop_surface::companion_benchmark_mode,
            desktop_surface::companion_validation_report,
            shortcuts::get_shortcut_settings,
            shortcuts::save_shortcut_settings,
            controls::update_game_menu,
            controls::confirm_replace,
            controls::finish_game_exit,
            controls::show_game_menu,
            campaign_interface::campaign_set_interface_mode,
            save_dialog::import_game_file,
            save_dialog::export_game_file,
            support_bundle::export_support_bundle,
            bin_window::bin_geometry,
            bin_window::set_bin_intake,
            overlay_ready,
            render_heartbeat,
            cursor_position_local,
            sync_displays,
            current_display,
            list_displays,
            storage::load_game_balance,
            storage::load_companion_balance,
            storage::load_game_state,
            storage::load_game_backup,
            storage::save_game_state,
            campaign_storage::read_campaign_session,
            campaign_storage::write_campaign_session_atomic,
            campaign_storage::preserve_campaign_legacy,
            campaign_storage::preserve_campaign_cycle_v1,
            campaign_storage::cloud::read_campaign_cloud,
            campaign_storage::cloud::refresh_campaign_cloud,
            campaign_storage::cloud::restore_campaign_cloud,
            interaction::update_interaction_regions,
            interaction::cancel_game_grab,
            recycle_bin::recycle_game_object,
            recycle_bin::next_memorial_number,
            recycle_bin::query_recycle_bin_count,
            recycle_bin::open_recycle_bin,
            bin_window::start_bin_drag
        ])
        .run(tauri::generate_context!())
        .expect("error while running Desktop Creatures");
}

#[cfg(test)]
mod campaign_runtime_tests {
    use super::{AtomicBool, OVERLAY_LABEL, activate_campaign_runtime, runtime_enabled};

    #[test]
    fn primary_activation_enables_native_campaign_binding_without_preview_flag() {
        let activation = AtomicBool::new(false);
        assert!(!runtime_enabled(false, &activation));
        activate_campaign_runtime(OVERLAY_LABEL, &activation).unwrap();
        assert!(runtime_enabled(false, &activation));
        // Reloading the primary WebView keeps the same native runtime authority.
        activate_campaign_runtime(OVERLAY_LABEL, &activation).unwrap();
        assert!(runtime_enabled(false, &activation));
    }

    #[test]
    fn secondary_and_auxiliary_windows_cannot_activate_campaign_runtime() {
        let activation = AtomicBool::new(false);
        for owner in [
            "overlay-secondary-a-instance-1",
            "shortcut-settings",
            "",
            "primary",
        ] {
            assert!(activate_campaign_runtime(owner, &activation).is_err());
            assert!(!runtime_enabled(false, &activation));
        }
    }

    #[test]
    fn preview_flag_keeps_native_campaign_binding_enabled_before_activation() {
        let activation = AtomicBool::new(false);
        assert!(runtime_enabled(true, &activation));
        assert!(!runtime_enabled(false, &activation));
    }
}
