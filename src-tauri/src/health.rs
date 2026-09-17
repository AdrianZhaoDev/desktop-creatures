use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Default)]
pub struct RenderHealth {
    beats: Mutex<HashMap<String, Instant>>,
    retired: Mutex<std::collections::HashSet<String>>,
    hidden: Mutex<std::collections::HashSet<String>>,
}

pub struct SmokeTestState {
    enabled: bool,
    exit_scheduled: AtomicBool,
    marker: PathBuf,
}

impl Default for SmokeTestState {
    fn default() -> Self {
        Self {
            enabled: false,
            exit_scheduled: AtomicBool::new(false),
            marker: std::env::temp_dir().join("desktop-creatures-smoke-v1.txt"),
        }
    }
}

impl SmokeTestState {
    pub fn from_args() -> Self {
        let state = Self {
            enabled: std::env::args().any(|arg| arg == "--smoke-test"),
            ..Self::default()
        };
        if state.enabled {
            let _ = std::fs::remove_file(&state.marker);
            state.record("args-ok");
        }
        state
    }

    pub fn record(&self, stage: &str) {
        if self.enabled {
            let _ = std::fs::write(&self.marker, stage.as_bytes());
        }
    }

    pub fn schedule_exit_once(&self, app: tauri::AppHandle) {
        if !self.enabled || self.exit_scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        self.record("overlay-ready");
        let marker = self.marker.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(1));
            let exit_handle = app.clone();
            let _ = std::fs::write(marker, b"exit-requested");
            let _ = app.run_on_main_thread(move || exit_handle.exit(0));
        });
    }
}

impl RenderHealth {
    pub fn is_retired(&self, label: &str) -> bool {
        self.retired.lock().map_or(true, |r| r.contains(label))
    }
    pub fn activate(&self, label: &str) {
        if let Ok(mut retired) = self.retired.lock() {
            retired.remove(label);
        }
    }
    /// Retire before close and on Destroyed: queued beats cannot resurrect it.
    pub fn forget(&self, label: &str) {
        if let Ok(mut retired) = self.retired.lock() {
            retired.insert(label.to_owned());
            if let Ok(mut beats) = self.beats.lock() {
                beats.remove(label);
            }
            if let Ok(mut hidden) = self.hidden.lock() {
                hidden.remove(label);
            }
        }
    }
    pub fn recover(&self, window: &tauri::WebviewWindow) {
        if let Ok(mut hidden) = self.hidden.lock() {
            if hidden.remove(window.label()) {
                let _ = window.show();
            }
        }
    }
    pub fn forget_recovery(&self) {
        if let Ok(mut hidden) = self.hidden.lock() {
            hidden.clear();
        }
    }
    pub fn beat(&self, label: String) {
        let Ok(retired) = self.retired.lock() else {
            return;
        };
        if retired.contains(&label) {
            return;
        }
        if let Ok(mut beats) = self.beats.lock() {
            beats.insert(label, Instant::now());
        }
    }

    fn stale_labels(&self, timeout: Duration) -> Vec<String> {
        let now = Instant::now();
        self.beats
            .lock()
            .map(|beats| {
                beats
                    .iter()
                    .filter(|(_, time)| now.duration_since(**time) > timeout)
                    .map(|(label, _)| label.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn authority_stale(stale: &[String]) -> bool {
    stale
        .iter()
        .any(|label| label == crate::window_manager::OVERLAY_LABEL)
}

pub fn start_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(2));
            if crate::campaign_runtime_enabled() {
                // Native topology safety does not depend on a responsive WebView.
                let _ = crate::window_manager::sync_display_overlays(&app);
            }
            if crate::controls::MENU_OPEN.load(Ordering::SeqCst) {
                continue;
            }
            let stale = app
                .state::<RenderHealth>()
                .stale_labels(Duration::from_secs(7));
            // Only the authority renderer can pause/hide the campaign globally.
            // Passive WebViews own no Session and their retirement may race this
            // snapshot, so their health failure is confined to their own window.
            for label in &stale {
                if label.starts_with(crate::window_manager::SECONDARY_PREFIX) {
                    app.state::<RenderHealth>().forget(label);
                    if let Some(window) = app.get_webview_window(label) {
                        let _ = window.hide();
                    }
                }
            }
            if authority_stale(&stale) {
                crate::window_manager::hide_overlay(&app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{RenderHealth, SmokeTestState};
    use std::time::Duration;

    #[test]
    fn fresh_heartbeat_is_not_stale() {
        let health = RenderHealth::default();
        health.beat("overlay-primary".to_owned());
        assert!(health.stale_labels(Duration::from_secs(1)).is_empty());
    }

    #[test]
    fn closing_passive_forgets_stale_beat_and_rejects_late_ipc() {
        let health = RenderHealth::default();
        let label = "overlay-screen-b-instance-1";
        health.beats.lock().unwrap().insert(
            label.into(),
            std::time::Instant::now() - Duration::from_secs(20),
        );
        assert_eq!(health.stale_labels(Duration::from_secs(7)), vec![label]);
        let old_watchdog_snapshot = health.stale_labels(Duration::from_secs(7));
        health.forget(label);
        health.beat(label.into());
        assert!(!super::authority_stale(&old_watchdog_snapshot));
        assert!(!health.is_retired("overlay-primary"));
        assert!(health.is_retired(label));
        assert!(super::authority_stale(&["overlay-primary".into()]));
        assert!(health.stale_labels(Duration::ZERO).is_empty());
        health.activate("overlay-screen-b-instance-2");
        health.beat("overlay-screen-b-instance-2".into());
        assert!(health.stale_labels(Duration::from_secs(7)).is_empty());
    }
    #[test]
    fn smoke_mode_is_disabled_without_cli_flag() {
        let state = SmokeTestState::default();
        assert!(!state.enabled);
    }
}
