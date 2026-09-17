//! Explicit user-selected WebView interaction. Rust owns focus and passthrough;
//! entering this mode is not an audio gesture. The subsequent real DOM click is.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

static ACTIVE: AtomicBool = AtomicBool::new(false);
pub fn active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

trait InterfaceWindow {
    fn passthrough(&self, enabled: bool) -> Result<(), String>;
    fn focusable(&self, enabled: bool) -> Result<(), String>;
    fn focus(&self) -> Result<(), String>;
}
impl InterfaceWindow for WebviewWindow {
    fn passthrough(&self, enabled: bool) -> Result<(), String> {
        self.set_ignore_cursor_events(enabled)
            .map_err(|e| e.to_string())
    }
    fn focusable(&self, enabled: bool) -> Result<(), String> {
        self.set_focusable(enabled).map_err(|e| e.to_string())
    }
    fn focus(&self) -> Result<(), String> {
        self.set_focus().map_err(|e| e.to_string())
    }
}
fn configure(window: &impl InterfaceWindow, enabled: bool) -> Result<(), String> {
    if enabled {
        let result = window
            .passthrough(false)
            .and_then(|_| window.focusable(true))
            .and_then(|_| window.focus());
        if result.is_err() {
            // Always attempt both restoration operations after a partial entry failure.
            let _ = window.passthrough(true);
            let _ = window.focusable(false);
        }
        result
    } else {
        let passthrough = window.passthrough(true);
        let focus = window.focusable(false);
        passthrough.and(focus)
    }
}
pub fn set_mode(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(super::window_manager::OVERLAY_LABEL)
        .ok_or("Primary overlay unavailable")?;
    // The global hook must release input before Windows hands real clicks to the WebView.
    if enabled {
        ACTIVE.store(true, Ordering::SeqCst);
        super::interaction::suspend_interface_input();
    } else {
        ACTIVE.store(false, Ordering::SeqCst);
        super::interaction::clear_and_cancel();
    }
    let result = configure(&window, enabled);
    if !enabled || result.is_err() {
        ACTIVE.store(false, Ordering::SeqCst);
        super::interaction::resume_interface_input();
    }
    let _ = app.emit("campaign://interface-mode", enabled && result.is_ok());
    result
}
#[tauri::command]
pub fn campaign_set_interface_mode(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    if window.label() != super::window_manager::OVERLAY_LABEL {
        return Err("Only the primary campaign overlay can change interface mode".into());
    }
    set_mode(window.app_handle(), enabled)
}
pub fn restore(app: &AppHandle) {
    if active() {
        let _ = set_mode(app, false);
    }
}

#[cfg(test)]
mod tests {
    use super::{InterfaceWindow, configure};
    use std::cell::RefCell;
    struct Fake {
        calls: RefCell<Vec<String>>,
        fail: &'static str,
    }
    impl Fake {
        fn call(&self, call: String) -> Result<(), String> {
            self.calls.borrow_mut().push(call.clone());
            if call == self.fail { Err(call) } else { Ok(()) }
        }
    }
    impl InterfaceWindow for Fake {
        fn passthrough(&self, value: bool) -> Result<(), String> {
            self.call(format!("passthrough:{value}"))
        }
        fn focusable(&self, value: bool) -> Result<(), String> {
            self.call(format!("focusable:{value}"))
        }
        fn focus(&self) -> Result<(), String> {
            self.call("focus".into())
        }
    }
    #[test]
    fn explicit_entry_receives_real_input_and_exit_restores_both_window_flags() {
        let window = Fake {
            calls: RefCell::new(vec![]),
            fail: "",
        };
        configure(&window, true).unwrap();
        configure(&window, false).unwrap();
        assert_eq!(
            *window.calls.borrow(),
            vec![
                "passthrough:false",
                "focusable:true",
                "focus",
                "passthrough:true",
                "focusable:false"
            ]
        );
    }
    #[test]
    fn partial_entry_failure_always_restores_passthrough_and_focusability() {
        for fail in ["passthrough:false", "focusable:true", "focus"] {
            let window = Fake {
                calls: RefCell::new(vec![]),
                fail,
            };
            assert!(configure(&window, true).is_err());
            assert!(
                window
                    .calls
                    .borrow()
                    .ends_with(&["passthrough:true".into(), "focusable:false".into()])
            );
        }
    }
    #[test]
    fn restore_attempts_nonfocusable_even_if_passthrough_fails() {
        let window = Fake {
            calls: RefCell::new(vec![]),
            fail: "passthrough:true",
        };
        assert!(configure(&window, false).is_err());
        assert_eq!(
            *window.calls.borrow(),
            vec!["passthrough:true", "focusable:false"]
        );
    }
}
