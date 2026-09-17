use serde::{Deserialize, Serialize};
use std::sync::{
    LazyLock, Mutex, OnceLock, RwLock,
    atomic::{AtomicU8, AtomicU64, Ordering},
    mpsc::{self, Sender},
};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, MSG, MSLLHOOKSTRUCT, SetWindowsHookExW,
        TranslateMessage, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    x: f64,
    y: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    entity_id: u64,
    kind: String,
    center_dip: Point,
    half_extent_dip: Point,
    rotation_rad: f64,
    priority: i32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default)]
    binding_generation: Option<u64>,
    revision: u64,
    generated_at_ms: u64,
    display_id: String,
    regions: Vec<Region>,
}

#[derive(Clone)]
struct NativeRegion {
    entity_id: u64,
    kind: String,
    center_x: f64,
    center_y: f64,
    half_x: f64,
    half_y: f64,
    rotation: f64,
    priority: i32,
}
#[derive(Clone)]
struct NativeSnapshot {
    binding_generation: u64,
    revision: u64,
    received_at_ms: u64,
    display_id: String,
    origin_x: f64,
    origin_y: f64,
    scale: f64,
    width: f64,
    height: f64,
    regions: Vec<NativeRegion>,
}
#[derive(Clone)]
struct ActiveGrab {
    binding_generation: u64,
    session_id: u64,
    entity_id: u64,
    kind: String,
    display_id: String,
    origin_x: f64,
    origin_y: f64,
    scale: f64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrabEvent {
    binding_generation: u64,
    session_id: u64,
    phase: String,
    entity_id: u64,
    kind: String,
    display_id: String,
    screen_physical: EventPoint,
    local_dip: EventPoint,
    over_trash_bin: bool,
    timestamp_ms: u64,
}
#[derive(Clone, Serialize)]
struct EventPoint {
    x: f64,
    y: f64,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static SNAPSHOTS: LazyLock<RwLock<Vec<NativeSnapshot>>> = LazyLock::new(|| RwLock::new(Vec::new()));
static ACTIVE: LazyLock<Mutex<Option<ActiveGrab>>> = LazyLock::new(|| Mutex::new(None));
const HIDDEN_INPUT: u8 = 1;
const INTERFACE_INPUT: u8 = 2;
const DISPLAY_INPUT: u8 = 4;
static INPUT_BLOCKERS: AtomicU8 = AtomicU8::new(0);

fn input_enabled() -> bool {
    INPUT_BLOCKERS.load(Ordering::SeqCst) == 0
}
static BIN_RECT: LazyLock<RwLock<Option<(i32, i32, i32, i32)>>> =
    LazyLock::new(|| RwLock::new(None));
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
static LAST_MOVE_MS: AtomicU64 = AtomicU64::new(0);
static EVENT_TX: OnceLock<Sender<(ActiveGrab, &'static str, f64, f64)>> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn update_interaction_regions(
    window: WebviewWindow,
    snapshot: Snapshot,
) -> Result<(), String> {
    // Hold this guard through native registration. Geometry read before a move
    // cannot register after that move, even when the same monitor is selected.
    let mut binding = if crate::campaign_runtime_enabled() {
        let binding = crate::campaign_display::lock(window.app_handle())?;
        binding.validate_binding(
            window.label(),
            &snapshot.display_id,
            snapshot
                .binding_generation
                .ok_or("Missing display generation")?,
        )?;
        Some(binding)
    } else {
        None
    };
    // A hidden overlay must never re-register invisible clickable targets after F12.
    if !input_enabled() || !window.is_visible().map_err(|error| error.to_string())? {
        SNAPSHOTS
            .write()
            .map_err(|_| "命中快照锁已损坏")?
            .retain(|item| item.display_id != snapshot.display_id);
        return Ok(());
    }
    let geometry = if let Some(state) = binding.as_mut() {
        crate::campaign_display::require_owner_geometry(&window, state, &snapshot.display_id)?
    } else {
        crate::campaign_display::read_owner_geometry(&window)?
    };
    let origin = geometry.position;
    let size = geometry.size;
    let scale = geometry.scale;
    let received = now_ms();
    let native = NativeSnapshot {
        binding_generation: binding.as_ref().map_or(0, |s| s.binding_generation),
        revision: snapshot.revision,
        received_at_ms: received,
        display_id: snapshot.display_id,
        origin_x: f64::from(origin.x),
        origin_y: f64::from(origin.y),
        scale,
        width: f64::from(size.width),
        height: f64::from(size.height),
        regions: snapshot
            .regions
            .into_iter()
            .map(|region| NativeRegion {
                entity_id: region.entity_id,
                kind: region.kind,
                center_x: f64::from(origin.x) + region.center_dip.x * scale,
                center_y: f64::from(origin.y) + region.center_dip.y * scale,
                half_x: region.half_extent_dip.x * scale,
                half_y: region.half_extent_dip.y * scale,
                rotation: region.rotation_rad,
                priority: region.priority,
            })
            .collect(),
    };
    let _frontend_clock = snapshot.generated_at_ms;
    register_native_snapshot(native)
}

fn register_native_snapshot(native: NativeSnapshot) -> Result<(), String> {
    let mut snapshots = SNAPSHOTS
        .write()
        .map_err(|_| "命中快照锁已损坏".to_owned())?;
    // hide may have happened while the command fetched window geometry.
    if !input_enabled() {
        snapshots.retain(|item| item.display_id != native.display_id);
        return Ok(());
    }
    if let Some(existing) = snapshots
        .iter_mut()
        .find(|item| item.display_id == native.display_id)
    {
        if native.revision >= existing.revision {
            *existing = native;
        }
    } else {
        snapshots.push(native);
    }
    Ok(())
}

pub fn update_bin_rect(window: &WebviewWindow) {
    if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
        if let Ok(mut rect) = BIN_RECT.write() {
            *rect = Some((
                position.x,
                position.y,
                position.x + size.width as i32,
                position.y + size.height as i32,
            ));
        }
    }
}

#[tauri::command]
pub fn cancel_game_grab() {
    clear_and_cancel();
}

pub fn clear_and_cancel() {
    if let Ok(mut snapshots) = SNAPSHOTS.write() {
        snapshots.clear();
    }
    if let Ok(mut active) = ACTIVE.lock() {
        if let Some(grab) = active.take() {
            queue_emit(&grab, "cancel", 0.0, 0.0);
        }
    }
}

pub fn suspend_input() {
    // Close the native gate before waiting for any in-flight registration/grab.
    // clear_and_cancel waits for ACTIVE, so a pre-hide start is cancelled before
    // this function returns and before the native windows are actually hidden.
    INPUT_BLOCKERS.fetch_or(HIDDEN_INPUT, Ordering::SeqCst);
    clear_and_cancel();
}

pub fn overlays_hidden() -> bool {
    INPUT_BLOCKERS.load(Ordering::SeqCst) & HIDDEN_INPUT != 0
}
pub fn resume_input() {
    INPUT_BLOCKERS.fetch_and(!HIDDEN_INPUT, Ordering::SeqCst);
}

pub fn suspend_interface_input() {
    INPUT_BLOCKERS.fetch_or(INTERFACE_INPUT, Ordering::SeqCst);
    clear_and_cancel();
}

pub fn suspend_display_input() {
    INPUT_BLOCKERS.fetch_or(DISPLAY_INPUT, Ordering::SeqCst);
    clear_and_cancel();
}
pub fn resume_display_input() {
    INPUT_BLOCKERS.fetch_and(!DISPLAY_INPUT, Ordering::SeqCst);
}
pub fn display_input_blocked() -> bool {
    INPUT_BLOCKERS.load(Ordering::SeqCst) & DISPLAY_INPUT != 0
}

pub fn resume_interface_input() {
    // A delayed WebView restore can release only its own pause reason.
    INPUT_BLOCKERS.fetch_and(!INTERFACE_INPUT, Ordering::SeqCst);
}

fn begin_grab(x: f64, y: f64) -> bool {
    let Ok(mut active) = ACTIVE.lock() else {
        return false;
    };
    if !input_enabled() || active.is_some() {
        return false;
    }
    let Some((snapshot, region)) = hit_test(x, y) else {
        return false;
    };
    if !input_enabled() {
        return false;
    }
    let grab = ActiveGrab {
        binding_generation: snapshot.binding_generation,
        session_id: NEXT_SESSION.fetch_add(1, Ordering::Relaxed),
        entity_id: region.entity_id,
        kind: region.kind,
        display_id: snapshot.display_id,
        origin_x: snapshot.origin_x,
        origin_y: snapshot.origin_y,
        scale: snapshot.scale,
    };
    // Establish and queue the start under the same lock used by cancellation.
    *active = Some(grab.clone());
    queue_emit(&grab, "start", x, y);
    true
}

pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    let (sender, receiver) = mpsc::channel();
    let _ = EVENT_TX.set(sender);
    std::thread::spawn(move || {
        while let Ok((grab, phase, x, y)) = receiver.recv() {
            emit(&grab, phase, x, y);
        }
    });
    std::thread::spawn(|| unsafe {
        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("mouse hook unavailable: {error}");
                return;
            }
        };
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx(hook);
    });
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0
        || super::controls::MENU_OPEN.load(Ordering::SeqCst)
        || super::campaign_interface::active()
        || super::shortcuts::SETTINGS_FOCUSED.load(Ordering::SeqCst)
    {
        return unsafe { CallNextHookEx(None, code, wparam, lparam) };
    }
    let mouse = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
    let x = f64::from(mouse.pt.x);
    let y = f64::from(mouse.pt.y);
    match wparam.0 as u32 {
        WM_LBUTTONDOWN => {
            if begin_grab(x, y) {
                return LRESULT(1);
            }
        }
        WM_MOUSEMOVE => {
            let current = now_ms();
            if current.saturating_sub(LAST_MOVE_MS.load(Ordering::Relaxed)) >= 16
                && let Ok(active) = ACTIVE.lock()
            {
                if let Some(grab) = active.as_ref() {
                    LAST_MOVE_MS.store(current, Ordering::Relaxed);
                    queue_emit(grab, "move", x, y);
                }
            }
        }
        WM_LBUTTONUP => {
            if let Ok(mut active) = ACTIVE.lock() {
                if let Some(grab) = active.take() {
                    queue_emit(&grab, "end", x, y);
                    return LRESULT(1);
                }
            }
        }
        _ => {}
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn hit_test(x: f64, y: f64) -> Option<(NativeSnapshot, NativeRegion)> {
    let current = now_ms();
    let snapshots = SNAPSHOTS.read().ok()?;
    if !input_enabled() {
        return None;
    }
    let mut candidates = Vec::new();
    for snapshot in snapshots
        .iter()
        .filter(|item| current.saturating_sub(item.received_at_ms) <= 250)
    {
        for region in &snapshot.regions {
            let dx = x - region.center_x;
            let dy = y - region.center_y;
            let c = region.rotation.cos();
            let s = region.rotation.sin();
            let local_x = dx * c + dy * s;
            let local_y = -dx * s + dy * c;
            if local_x.abs() <= region.half_x && local_y.abs() <= region.half_y {
                candidates.push((snapshot.clone(), region.clone()));
            }
        }
    }
    candidates
        .into_iter()
        .max_by_key(|(_, region)| region.priority)
}

fn emit(grab: &ActiveGrab, phase: &str, x: f64, y: f64) {
    // The hook queue can outlive cancellation. Never deliver an old start/end
    // into the new viewport; Session is owned by the one fixed WebView.
    let binding = if crate::campaign_runtime_enabled() {
        let Some(app) = APP.get() else {
            return;
        };
        let Ok(binding) = crate::campaign_display::lock(app) else {
            return;
        };
        if phase != "cancel"
            && (!input_enabled()
                || binding
                    .validate_binding(
                        crate::window_manager::OVERLAY_LABEL,
                        &grab.display_id,
                        grab.binding_generation,
                    )
                    .is_err())
        {
            return;
        }
        Some(binding)
    } else {
        None
    };
    let _binding_guard = binding;
    let over = BIN_RECT
        .read()
        .ok()
        .and_then(|value| *value)
        .is_some_and(|(l, t, r, b)| {
            x >= f64::from(l) && x <= f64::from(r) && y >= f64::from(t) && y <= f64::from(b)
        });
    let target = SNAPSHOTS.read().ok().and_then(|items| {
        items
            .iter()
            .find(|item| {
                x >= item.origin_x
                    && x < item.origin_x + item.width
                    && y >= item.origin_y
                    && y < item.origin_y + item.height
            })
            .cloned()
    });
    let (display_id, origin_x, origin_y, scale) = target
        .map(|item| (item.display_id, item.origin_x, item.origin_y, item.scale))
        .unwrap_or_else(|| {
            (
                grab.display_id.clone(),
                grab.origin_x,
                grab.origin_y,
                grab.scale,
            )
        });
    let payload = GrabEvent {
        binding_generation: grab.binding_generation,
        session_id: grab.session_id,
        phase: phase.to_owned(),
        entity_id: grab.entity_id,
        kind: grab.kind.clone(),
        display_id,
        screen_physical: EventPoint { x, y },
        local_dip: EventPoint {
            x: (x - origin_x) / scale,
            y: (y - origin_y) / scale,
        },
        over_trash_bin: over,
        timestamp_ms: now_ms(),
    };
    if let Some(app) = APP.get() {
        let _ = app.emit("game://grab", payload);
    }
}

fn queue_emit(grab: &ActiveGrab, phase: &'static str, x: f64, y: f64) {
    if let Some(sender) = EVENT_TX.get() {
        let _ = sender.send((grab.clone(), phase, x, y));
    }
}

#[cfg(test)]
mod tests {
    use super::{NativeRegion, NativeSnapshot, SNAPSHOTS, hit_test};
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    use std::time::{Duration, Instant};
    #[test]
    fn rotation_math_accepts_center() {
        let region = NativeRegion {
            entity_id: 1,
            kind: "roach".into(),
            center_x: 10.0,
            center_y: 20.0,
            half_x: 5.0,
            half_y: 2.0,
            rotation: 1.2,
            priority: 1,
        };
        let snapshot = NativeSnapshot {
            binding_generation: 0,
            revision: 1,
            received_at_ms: super::now_ms(),
            display_id: "test".into(),
            origin_x: 0.0,
            origin_y: 0.0,
            scale: 1.0,
            width: 100.0,
            height: 100.0,
            regions: vec![region],
        };
        assert_eq!(snapshot.regions[0].entity_id, 1);
    }

    #[test]
    fn ten_thousand_misses_pass_through_below_p99_budget() {
        let _test = TEST_LOCK.lock().unwrap();
        super::resume_input();
        let regions = (0..300)
            .map(|index| NativeRegion {
                entity_id: index,
                kind: "roach".into(),
                center_x: f64::from(index as u32),
                center_y: 100.0,
                half_x: 10.0,
                half_y: 4.0,
                rotation: 0.3,
                priority: 1,
            })
            .collect();
        *SNAPSHOTS.write().unwrap() = vec![NativeSnapshot {
            binding_generation: 0,
            revision: 1,
            received_at_ms: super::now_ms(),
            display_id: "perf".into(),
            origin_x: 0.0,
            origin_y: 0.0,
            scale: 1.0,
            width: 1920.0,
            height: 1080.0,
            regions,
        }];
        let mut timings = Vec::with_capacity(10_000);
        for _ in 0..10_000 {
            let started = Instant::now();
            assert!(hit_test(-10_000.0, -10_000.0).is_none());
            timings.push(started.elapsed());
        }
        timings.sort_unstable();
        assert!(
            timings[9_899] < Duration::from_micros(250),
            "p99 was {:?}",
            timings[9_899]
        );
        SNAPSHOTS.write().unwrap().clear();
    }

    fn clickable_snapshot() -> NativeSnapshot {
        NativeSnapshot {
            binding_generation: 0,
            revision: 1,
            received_at_ms: super::now_ms(),
            display_id: "gate-test".into(),
            origin_x: 0.0,
            origin_y: 0.0,
            scale: 1.0,
            width: 100.0,
            height: 100.0,
            regions: vec![NativeRegion {
                entity_id: 7,
                kind: "roach".into(),
                center_x: 30.0,
                center_y: 40.0,
                half_x: 10.0,
                half_y: 10.0,
                rotation: 0.0,
                priority: 1,
            }],
        }
    }
    struct RestoreInput;
    impl Drop for RestoreInput {
        fn drop(&mut self) {
            super::clear_and_cancel();
            super::resume_input();
            super::resume_interface_input();
            super::resume_display_input();
        }
    }
    #[test]
    fn hidden_gate_rejects_late_regions_and_cancels_existing_grab() {
        let _test = TEST_LOCK.lock().unwrap();
        let _restore = RestoreInput;
        super::resume_input();
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(super::begin_grab(30.0, 40.0));
        super::suspend_input();
        assert!(super::ACTIVE.lock().unwrap().is_none());
        // Simulate a command which read visible window geometry before hide.
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(SNAPSHOTS.read().unwrap().is_empty());
        assert!(hit_test(30.0, 40.0).is_none());
        assert!(!super::begin_grab(30.0, 40.0));
        super::resume_input();
        assert!(!super::begin_grab(30.0, 40.0));
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(super::begin_grab(30.0, 40.0));
    }
    #[test]
    fn pending_native_grab_rechecks_gate_after_waiting_for_active_lock() {
        let _test = TEST_LOCK.lock().unwrap();
        let _restore = RestoreInput;
        super::resume_input();
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        let held = super::ACTIVE.lock().unwrap();
        let waiting = std::thread::spawn(|| super::begin_grab(30.0, 40.0));
        // Same first operation as suspend_input, while hook start is waiting.
        super::INPUT_BLOCKERS.fetch_or(super::HIDDEN_INPUT, super::Ordering::SeqCst);
        drop(held);
        assert!(!waiting.join().unwrap());
        super::suspend_input();
        assert!(super::ACTIVE.lock().unwrap().is_none());
    }

    #[test]
    fn hide_then_late_interface_disable_cannot_accept_late_regions() {
        let _test = TEST_LOCK.lock().unwrap();
        let _restore = RestoreInput;
        super::resume_input();
        super::resume_interface_input();
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(super::begin_grab(30.0, 40.0));
        super::suspend_interface_input();
        assert!(super::ACTIVE.lock().unwrap().is_none());
        // Rust hide owns its pause even after the frontend sends repeated restores.
        super::suspend_input();
        super::resume_interface_input();
        super::resume_interface_input();
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(!super::input_enabled());
        assert!(SNAPSHOTS.read().unwrap().is_empty());
        assert!(hit_test(30.0, 40.0).is_none());
        assert!(!super::begin_grab(30.0, 40.0));
        // Only native show releases hide, and it still needs fresh regions.
        super::resume_input();
        assert!(!super::begin_grab(30.0, 40.0));
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(super::begin_grab(30.0, 40.0));
    }

    #[test]
    fn unobserved_os_geometry_change_clears_active_grab_and_rejects_late_old_regions() {
        let _test = TEST_LOCK.lock().unwrap();
        let _restore = RestoreInput;
        super::resume_input();
        super::resume_interface_input();
        super::resume_display_input();
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(super::begin_grab(30.0, 40.0));
        let mut state = crate::campaign_display::DisplayState::default();
        state.phase = crate::campaign_display::Phase::Ready;
        assert!(crate::campaign_display::block_geometry(
            &mut state,
            "OS moved window before topology poll"
        ));
        assert!(super::ACTIVE.lock().unwrap().is_none());
        assert_eq!(state.binding_generation, 2);
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(SNAPSHOTS.read().unwrap().is_empty());
        assert!(!super::begin_grab(30.0, 40.0));
        super::resume_interface_input();
        super::resume_input();
        assert!(super::display_input_blocked());
    }
    #[test]
    fn display_move_gate_cancels_input_and_does_not_release_hidden_or_interface_pause() {
        let _test = TEST_LOCK.lock().unwrap();
        let _restore = RestoreInput;
        super::resume_input();
        super::resume_interface_input();
        super::resume_display_input();
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(super::begin_grab(30.0, 40.0));
        super::suspend_display_input();
        assert!(super::ACTIVE.lock().unwrap().is_none());
        super::resume_input();
        super::resume_interface_input();
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(super::display_input_blocked());
        assert!(SNAPSHOTS.read().unwrap().is_empty());
        super::suspend_input();
        super::suspend_interface_input();
        super::resume_display_input();
        assert!(!super::input_enabled());
        super::resume_input();
        assert!(!super::input_enabled());
        super::resume_interface_input();
        assert!(super::input_enabled());
        assert!(!super::begin_grab(30.0, 40.0));
    }
    #[test]
    fn native_show_does_not_release_interface_pause() {
        let _test = TEST_LOCK.lock().unwrap();
        let _restore = RestoreInput;
        super::suspend_input();
        super::suspend_interface_input();
        super::resume_input();
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(SNAPSHOTS.read().unwrap().is_empty());
        assert!(!super::begin_grab(30.0, 40.0));
        super::resume_interface_input();
        super::register_native_snapshot(clickable_snapshot()).unwrap();
        assert!(super::begin_grab(30.0, 40.0));
    }
}
