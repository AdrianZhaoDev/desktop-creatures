//! A physical monitor binding, never a transfer of the campaign WebView/Session.
//! The same mutex serializes topology/move, surface requests and native regions.
use crate::window_manager::{DisplayInfo, OVERLAY_LABEL};
use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Ready,
    Moving,
    AwaitingSurface,
    Disconnected,
    TopologyChanged,
    Failed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayState {
    pub owner_label: &'static str,
    pub display_id: Option<String>,
    pub displays: Vec<DisplayInfo>,
    pub topology_revision: u64,
    pub binding_generation: u64,
    pub phase: Phase,
    pub error: Option<String>,
    #[serde(skip)]
    surface_ready: bool,
}
impl Default for DisplayState {
    fn default() -> Self {
        Self {
            owner_label: OVERLAY_LABEL,
            display_id: None,
            displays: vec![],
            topology_revision: 0,
            binding_generation: 1,
            phase: Phase::Disconnected,
            error: None,
            surface_ready: false,
        }
    }
}
#[derive(Clone, Debug)]
pub struct OwnerGeometry {
    pub position: tauri::PhysicalPosition<i32>,
    pub size: tauri::PhysicalSize<u32>,
    pub scale: f64,
}
pub fn read_owner_geometry(window: &WebviewWindow) -> Result<OwnerGeometry, String> {
    Ok(OwnerGeometry {
        position: window.outer_position().map_err(|e| e.to_string())?,
        size: window.outer_size().map_err(|e| e.to_string())?,
        scale: window.scale_factor().map_err(|e| e.to_string())?,
    })
}

#[derive(Default)]
pub struct CampaignDisplay(pub Mutex<DisplayState>);
pub fn lock(app: &AppHandle) -> Result<MutexGuard<'_, DisplayState>, String> {
    app.state::<CampaignDisplay>()
        .inner()
        .0
        .lock()
        .map_err(|_| "Display state lock poisoned".into())
}
impl DisplayState {
    pub fn observe(&mut self, mut displays: Vec<DisplayInfo>) -> bool {
        displays.sort_by(|a, b| a.id.cmp(&b.id));
        if self.displays == displays {
            return false;
        }
        let initial = self.topology_revision == 0;
        self.topology_revision += 1;
        self.displays = displays;
        if initial {
            self.display_id = self
                .displays
                .iter()
                .find(|d| d.primary)
                .or(self.displays.first())
                .map(|d| d.id.clone());
            self.phase = if self.display_id.is_some() {
                Phase::Ready
            } else {
                Phase::Disconnected
            };
        } else {
            self.binding_generation += 1;
            self.surface_ready = false;
            self.phase = if self
                .displays
                .iter()
                .any(|d| Some(&d.id) == self.display_id.as_ref())
            {
                Phase::TopologyChanged
            } else {
                Phase::Disconnected
            };
            self.error = Some(
                "Display topology changed; a checkpoint and explicit viewport remap are required"
                    .into(),
            );
        }
        !initial
    }
    pub fn validate_binding(
        &self,
        owner: &str,
        display: &str,
        generation: u64,
    ) -> Result<(), String> {
        if owner != OVERLAY_LABEL {
            return Err("Only overlay-primary owns the campaign".into());
        }
        if self.display_id.as_deref() != Some(display) || self.binding_generation != generation {
            return Err("Stale display binding".into());
        }
        if !matches!(self.phase, Phase::Ready | Phase::AwaitingSurface) {
            return Err("Display binding is not available".into());
        }
        Ok(())
    }
    fn begin(
        &mut self,
        owner: &str,
        expected: Option<&str>,
        generation: u64,
        revision: u64,
        target: &str,
    ) -> Result<bool, String> {
        if owner != OVERLAY_LABEL {
            return Err("Only overlay-primary can move the campaign".into());
        }
        if self.display_id.as_deref() != expected
            || self.binding_generation != generation
            || self.topology_revision != revision
        {
            return Err("Stale display move request".into());
        }
        if !self.displays.iter().any(|d| d.id == target) {
            return Err("Target display disconnected".into());
        }
        if self.phase == Phase::AwaitingSurface && self.display_id.as_deref() == Some(target) {
            return Ok(false);
        }
        self.binding_generation += 1;
        self.display_id = Some(target.to_owned());
        self.phase = Phase::Moving;
        self.surface_ready = false;
        self.error = None;
        Ok(true)
    }
    pub fn geometry_matches(&self, display: &str, actual: &OwnerGeometry) -> bool {
        self.displays
            .iter()
            .find(|d| d.id == display)
            .is_some_and(|target| {
                actual.position.x == target.position.x
                    && actual.position.y == target.position.y
                    && actual.size.width == target.size.width
                    && actual.size.height == target.size.height
                    && actual.scale.is_finite()
                    && (actual.scale - target.scale_factor).abs() <= 0.001
            })
    }
    fn reject_geometry(&mut self, error: &str) -> bool {
        self.surface_ready = false;
        self.error = Some(error.into());
        if self.phase == Phase::Ready {
            self.binding_generation += 1;
            self.phase = Phase::TopologyChanged;
            return true;
        }
        // Moving to mixed DPI can settle asynchronously. It already has its
        // own input blocker; keep awaiting-surface so polling can finish safely.
        false
    }
    pub fn mark_surface(&mut self, valid: bool) {
        self.surface_ready = valid;
    }
    fn complete(&mut self, owner: &str, display: &str, generation: u64) -> Result<(), String> {
        self.validate_binding(owner, display, generation)?;
        if self.phase == Phase::Ready {
            return Ok(());
        }
        if !self.surface_ready {
            return Err("Waiting for a valid surface on the new binding".into());
        }
        self.phase = Phase::Ready;
        self.error = None;
        Ok(())
    }
    /// Returns true only when entering a new failure. Callers perform native
    /// safety/lease cancellation exactly then, preserving explicit recovery UI
    /// throughout repeated observations of the same unresolved failure.
    fn enumeration_failed(&mut self, message: &str) -> bool {
        if self.phase == Phase::Failed && self.error.as_deref() == Some(message) {
            return false;
        }
        self.binding_generation += 1;
        self.fail(message.to_owned());
        true
    }
    pub fn fail(&mut self, error: String) {
        self.phase = Phase::Failed;
        self.surface_ready = false;
        self.error = Some(error);
    }
}

/// Native safety half is shared by region, surface and completion checks.
/// Callers hold the binding mutex, so old messages cannot republish after this.
pub(crate) fn block_geometry(state: &mut DisplayState, message: &str) -> bool {
    crate::interaction::suspend_display_input();
    let newly_blocked = state.reject_geometry(message);
    crate::desktop_surface::invalidate_binding();
    newly_blocked
}
pub fn reject_owner_geometry(
    window: &WebviewWindow,
    state: &mut DisplayState,
    message: &str,
) -> String {
    if block_geometry(state, message) {
        crate::campaign_interface::restore(window.app_handle());
    }
    message.into()
}
pub fn require_owner_geometry(
    window: &WebviewWindow,
    state: &mut DisplayState,
    display: &str,
) -> Result<OwnerGeometry, String> {
    let geometry = match read_owner_geometry(window) {
        Ok(geometry) => geometry,
        Err(error) => {
            return Err(reject_owner_geometry(
                window,
                state,
                &format!("Owner geometry unavailable: {error}"),
            ));
        }
    };
    if !state.geometry_matches(display, &geometry) {
        return Err(reject_owner_geometry(
            window,
            state,
            "Owner viewport differs from its display binding",
        ));
    }
    Ok(geometry)
}

/// Caller holds the display mutex before querying monitors, preventing an older
/// enumeration from overwriting a newer topology or move.
pub fn refresh(app: &AppHandle, state: &mut DisplayState) -> Result<(), String> {
    let displays = match crate::window_manager::list_displays(app) {
        Ok(displays) => displays,
        Err(error) => {
            let message = format!("Display enumeration failed: {error}");
            if crate::campaign_runtime_enabled() && state.enumeration_failed(&message) {
                crate::interaction::suspend_display_input();
                crate::campaign_interface::restore(app);
                crate::desktop_surface::invalidate_binding();
            }
            return Err(message);
        }
    };
    if state.observe(displays) && crate::campaign_runtime_enabled() {
        crate::interaction::suspend_display_input();
        crate::campaign_interface::restore(app);
        crate::desktop_surface::invalidate_binding();
    }
    Ok(())
}

#[tauri::command]
pub async fn campaign_display_state(window: WebviewWindow) -> Result<DisplayState, String> {
    if window.label() != OVERLAY_LABEL {
        return Err("Only the campaign owner can read its binding".into());
    }
    let app = window.app_handle();
    let mut state = lock(app)?;
    refresh(app, &mut state)?;
    Ok(state.clone())
}

#[tauri::command]
pub async fn campaign_move_display(
    window: WebviewWindow,
    expected_display_id: Option<String>,
    binding_generation: u64,
    topology_revision: u64,
    target_display_id: String,
) -> Result<DisplayState, String> {
    if !crate::campaign_runtime_enabled() {
        return Err("Campaign mode required".into());
    }
    let app = window.app_handle();
    let mut state = lock(app)?;
    refresh(app, &mut state)?;
    // Close input before generation/geometry changes. Retrying cannot open it.
    // Validation failures leave an existing healthy binding alone.
    let mut next = state.clone();
    if !next.begin(
        window.label(),
        expected_display_id.as_deref(),
        binding_generation,
        topology_revision,
        &target_display_id,
    )? {
        return Ok(state.clone());
    }
    crate::interaction::suspend_display_input();
    crate::campaign_interface::restore(app);
    *state = next;
    crate::desktop_surface::invalidate_binding();
    let result = crate::bin_window::cancel_native_drag(app).and_then(|_| {
        crate::window_manager::move_campaign_windows(app, &target_display_id)
            .map_err(|e| e.to_string())
    });
    match result {
        Ok(()) => state.phase = Phase::AwaitingSurface,
        Err(error) => state.fail(error),
    }
    Ok(state.clone())
}

#[tauri::command]
pub async fn campaign_complete_display_move(
    window: WebviewWindow,
    display_id: String,
    binding_generation: u64,
) -> Result<DisplayState, String> {
    let app = window.app_handle();
    let mut state = lock(app)?;
    refresh(app, &mut state)?;
    state.validate_binding(window.label(), &display_id, binding_generation)?;
    require_owner_geometry(&window, &mut state, &display_id)?;
    if state.phase != Phase::Ready
        && !crate::desktop_surface::binding_surface_valid(&display_id, binding_generation)
    {
        return Err("Fresh display surface expired; poll before completing".into());
    }
    state.complete(window.label(), &display_id, binding_generation)?;
    crate::interaction::resume_display_input();
    Ok(state.clone())
}

#[tauri::command]
pub async fn campaign_abort_display_move(
    window: WebviewWindow,
    display_id: String,
    binding_generation: u64,
) -> Result<DisplayState, String> {
    let mut state = lock(window.app_handle())?;
    if window.label() != OVERLAY_LABEL
        || state.display_id.as_deref() != Some(&display_id)
        || state.binding_generation != binding_generation
    {
        return Err("Stale display abort request".into());
    }
    crate::interaction::suspend_display_input();
    state.fail("Display migration was interrupted; retry explicitly".into());
    Ok(state.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn display(id: &str, scale: f64) -> DisplayInfo {
        DisplayInfo {
            id: id.into(),
            name: None,
            position: crate::window_manager::PointI32 { x: 0, y: 0 },
            size: crate::window_manager::SizeU32 {
                width: 1920,
                height: 1080,
            },
            scale_factor: scale,
            primary: id == "a",
        }
    }
    fn state() -> DisplayState {
        let mut s = DisplayState::default();
        s.observe(vec![display("a", 1.), display("b", 1.5)]);
        s
    }
    #[test]
    fn physical_reposition_resolution_and_dpi_mismatch_reject_cached_binding_before_topology_poll()
    {
        let mut s = state();
        let expected = OwnerGeometry {
            position: tauri::PhysicalPosition::new(0, 0),
            size: tauri::PhysicalSize::new(1920, 1080),
            scale: 1.,
        };
        assert!(s.geometry_matches("a", &expected));
        for actual in [
            OwnerGeometry {
                position: tauri::PhysicalPosition::new(-1920, 0),
                ..expected.clone()
            },
            OwnerGeometry {
                size: tauri::PhysicalSize::new(1280, 720),
                ..expected.clone()
            },
            OwnerGeometry {
                scale: 1.5,
                ..expected.clone()
            },
            OwnerGeometry {
                scale: f64::NAN,
                ..expected.clone()
            },
        ] {
            assert!(!s.geometry_matches("a", &actual));
        }
        assert!(s.reject_geometry("geometry changed"));
        assert_eq!(s.phase, Phase::TopologyChanged);
        assert_eq!(s.binding_generation, 2);
        assert!(s.validate_binding(OVERLAY_LABEL, "a", 1).is_err());
        assert!(!s.reject_geometry("geometry changed"));
        assert_eq!(s.binding_generation, 2);
        s.begin(OVERLAY_LABEL, Some("a"), 2, 1, "b").unwrap();
        s.phase = Phase::AwaitingSurface;
        assert!(!s.reject_geometry("DPI settling"));
        assert_eq!(s.binding_generation, 3);
        assert_eq!(s.phase, Phase::AwaitingSurface);
    }
    #[test]
    fn repeated_enumeration_failure_does_not_cancel_explicit_recovery_controls_again() {
        let mut s = state();
        let mut native_cancellations = 0;
        let mut observe_failure = |s: &mut DisplayState, message: &str| {
            if s.enumeration_failed(message) {
                native_cancellations += 1;
            }
        };
        observe_failure(&mut s, "offline");
        for _ in 0..20 {
            observe_failure(&mut s, "offline");
        }
        assert_eq!(s.binding_generation, 2);
        assert_eq!(s.phase, Phase::Failed);
        observe_failure(&mut s, "different native error");
        assert_eq!(s.binding_generation, 3);
        // An explicit successful retry creates a fresh binding. A later failure
        // must cancel input again, even if its error text has been seen before.
        s.begin(OVERLAY_LABEL, Some("a"), 3, 1, "a").unwrap();
        s.phase = Phase::AwaitingSurface;
        s.mark_surface(true);
        s.complete(OVERLAY_LABEL, "a", 4).unwrap();
        observe_failure(&mut s, "different native error");
        assert_eq!(s.binding_generation, 5);
        assert_eq!(native_cancellations, 3);
    }
    #[test]
    fn startup_binding_prefers_primary_then_sorted_fallback() {
        let mut s = DisplayState::default();
        let mut a = display("a", 1.);
        a.primary = false;
        let mut b = display("b", 1.5);
        b.primary = true;
        s.observe(vec![a.clone(), b.clone()]);
        assert_eq!(s.display_id.as_deref(), Some("b"));
        b.primary = false;
        let mut fallback = DisplayState::default();
        fallback.observe(vec![b, a]);
        assert_eq!(fallback.display_id.as_deref(), Some("a"));
    }
    #[test]
    fn owner_never_changes_and_stale_binding_is_rejected() {
        let mut s = state();
        assert!(s.begin("overlay-screen-b", Some("a"), 1, 1, "b").is_err());
        assert!(s.begin(OVERLAY_LABEL, Some("a"), 0, 1, "b").is_err());
        assert!(s.begin(OVERLAY_LABEL, Some("a"), 1, 0, "b").is_err());
        assert!(s.begin(OVERLAY_LABEL, Some("wrong"), 1, 1, "b").is_err());
        s.begin(OVERLAY_LABEL, Some("a"), 1, 1, "b").unwrap();
        s.phase = Phase::AwaitingSurface;
        assert_eq!(s.owner_label, OVERLAY_LABEL);
        assert!(s.validate_binding(OVERLAY_LABEL, "a", 1).is_err());
        assert!(s.validate_binding(OVERLAY_LABEL, "b", 1).is_err());
        assert!(s.validate_binding("passive", "b", 2).is_err());
        assert!(s.validate_binding(OVERLAY_LABEL, "b", 2).is_ok());
    }
    #[test]
    fn retry_is_idempotent_and_requires_fresh_surface_before_complete() {
        let mut s = state();
        s.begin(OVERLAY_LABEL, Some("a"), 1, 1, "b").unwrap();
        s.phase = Phase::AwaitingSurface;
        assert!(!s.begin(OVERLAY_LABEL, Some("b"), 2, 1, "b").unwrap());
        assert_eq!(s.binding_generation, 2);
        assert!(s.complete(OVERLAY_LABEL, "b", 2).is_err());
        s.mark_surface(true);
        s.complete(OVERLAY_LABEL, "b", 2).unwrap();
        s.complete(OVERLAY_LABEL, "b", 2).unwrap();
        assert_eq!(s.phase, Phase::Ready);
    }
    #[test]
    fn disconnect_reconnect_and_dpi_change_invalidate_generation_without_transferring_owner() {
        let mut s = state();
        assert!(s.observe(vec![display("b", 1.5)]));
        assert_eq!(s.phase, Phase::Disconnected);
        assert_eq!(s.display_id.as_deref(), Some("a"));
        assert!(s.observe(vec![display("a", 2.), display("b", 1.5)]));
        assert_eq!(s.phase, Phase::TopologyChanged);
        assert_eq!(s.binding_generation, 3);
        assert!(!s.observe(vec![display("b", 1.5), display("a", 2.)]));
        assert!(s.begin(OVERLAY_LABEL, Some("a"), 3, 3, "a").unwrap());
        assert_eq!(s.binding_generation, 4);
        assert_eq!(s.owner_label, OVERLAY_LABEL);
    }
    #[test]
    fn in_flight_old_generation_cannot_publish_after_migration_lock() {
        use std::sync::{Arc, Barrier};
        let shared = Arc::new(Mutex::new(state()));
        let barrier = Arc::new(Barrier::new(2));
        let mut moving = shared.lock().unwrap();
        let old_writer = {
            let shared = shared.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                // This IPC has already read old geometry, but publication needs
                // the very same mutex as the move, not a separate atomic read.
                barrier.wait();
                shared
                    .lock()
                    .unwrap()
                    .validate_binding(OVERLAY_LABEL, "a", 1)
            })
        };
        barrier.wait();
        moving.begin(OVERLAY_LABEL, Some("a"), 1, 1, "b").unwrap();
        moving.phase = Phase::AwaitingSurface;
        drop(moving);
        assert!(old_writer.join().unwrap().is_err());
    }
    #[test]
    fn partial_failure_stays_closed_and_retry_invalidates_previous_surface() {
        let mut s = state();
        s.begin(OVERLAY_LABEL, Some("a"), 1, 1, "b").unwrap();
        s.mark_surface(true);
        s.fail("native position failed".into());
        assert!(s.validate_binding(OVERLAY_LABEL, "b", 2).is_err());
        assert!(s.complete(OVERLAY_LABEL, "b", 2).is_err());
        s.begin(OVERLAY_LABEL, Some("b"), 2, 1, "b").unwrap();
        s.phase = Phase::AwaitingSurface;
        assert!(s.complete(OVERLAY_LABEL, "b", 3).is_err());
    }
}
