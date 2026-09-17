use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct OverlayState {
    paused: AtomicBool,
}

impl OverlayState {
    pub fn toggle_pause(&self) -> bool {
        let previous = self.paused.fetch_xor(true, Ordering::SeqCst);
        !previous
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
}

pub fn toggle_pause(app: &AppHandle) {
    let paused = app.state::<OverlayState>().toggle_pause();
    super::controls::pause_changed(app, paused);
    let _ = app.emit("creature://pause", paused);
}

pub fn set_pause(app: &AppHandle, paused: bool) {
    app.state::<OverlayState>()
        .paused
        .store(paused, Ordering::SeqCst);
    super::controls::pause_changed(app, paused);
    let _ = app.emit("creature://pause", paused);
}

pub fn emit_pause_state(app: &AppHandle) {
    let paused = app.state::<OverlayState>().is_paused();
    let _ = app.emit("creature://pause", paused);
}

#[cfg(test)]
mod tests {
    use super::OverlayState;

    #[test]
    fn pause_state_toggles_predictably() {
        let state = OverlayState::default();
        assert!(!state.is_paused());
        assert!(state.toggle_pause());
        assert!(state.is_paused());
        assert!(!state.toggle_pause());
    }
}
