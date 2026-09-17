//! Opt-in native integration checks. Only synthetic windows and aggregate counters are logged.
#[path = "desktop_surface_v2_native_tests.rs"]
mod v2;
use super::*;
use windows::Win32::{
    Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM},
    Graphics::Gdi::*,
    UI::{HiDpi::*, WindowsAndMessaging::*},
};
use windows::core::w;

static PAINT_PHASE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static PAINT_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

unsafe extern "system" fn pattern_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    unsafe {
        if message == WM_PAINT {
            let mut paint = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut paint);
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            FillRect(dc, &rect, HBRUSH(GetStockObject(WHITE_BRUSH).0));
            let offset = (PAINT_PHASE.load(Ordering::Relaxed) % 2) as i32 * 8;
            for x in (offset..rect.right).step_by(16) {
                FillRect(
                    dc,
                    &RECT {
                        left: x,
                        top: 0,
                        right: x + 8,
                        bottom: rect.bottom,
                    },
                    HBRUSH(GetStockObject(BLACK_BRUSH).0),
                );
            }
            let _ = EndPaint(hwnd, &paint);
            PAINT_COUNT.fetch_add(1, Ordering::Relaxed);
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, message, w, l)
    }
}

struct TestWindow(HWND);
impl Drop for TestWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}

unsafe fn pump() {
    unsafe {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn inner_support(cells: &[u8], r: &Request) -> usize {
    let cols = (r.width / r.cell).ceil() as usize + 1;
    // Ignore fixture edges; this region is fully covered by the synthetic white window.
    (12..28)
        .flat_map(|y| (12..44).map(move |x| y * cols + x))
        .filter(|i| cells.get(*i) == Some(&1))
        .count()
}

unsafe fn wait_for_support(
    capture: &mut Capture,
    r: &Request,
    hwnd: HWND,
    expected_pattern: bool,
) -> usize {
    unsafe {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut observed = None;
        while Instant::now() < deadline {
            // Present after duplication exists; a static fixture painted before it is
            // created need not cause a new DXGI image. Only this owned window changes.
            PAINT_PHASE.fetch_add(1, Ordering::Relaxed);
            let _ = InvalidateRect(Some(hwnd), None, false);
            let _ = UpdateWindow(hwnd);
            pump();
            if let Some(cells) = capture.read(r).unwrap_or_else(|e| {
                panic!(
                    "DXGI fixture read failed: {e}; diagnostics={}",
                    serde_json::to_string(&capture.diagnostics).unwrap()
                )
            }) {
                let count = inner_support(&cells, r);
                observed = Some(count);
                if if expected_pattern {
                    count >= 400
                } else {
                    count <= 8
                } {
                    return count;
                }
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        panic!(
            "synthetic pattern expected={expected_pattern}, observed support={observed:?}, paints={}, diagnostics={}",
            PAINT_COUNT.load(Ordering::Relaxed),
            serde_json::to_string(&capture.diagnostics).unwrap()
        );
    }
}

#[test]
#[ignore = "creates temporary non-focusable synthetic windows on the unlocked Windows desktop"]
fn native_exclusion_and_continuity() {
    unsafe {
        let foreground = GetForegroundWindow();
        let factory: IDXGIFactory1 = CreateDXGIFactory1().unwrap();
        let mut selected = None;
        for ai in 0..32 {
            let Ok(adapter) = factory.EnumAdapters1(ai) else {
                break;
            };
            for oi in 0..32 {
                let Ok(output) = adapter.EnumOutputs(oi) else {
                    break;
                };
                let desc = output.GetDesc().unwrap();
                let rect = desc.DesktopCoordinates;
                if desc.AttachedToDesktop.as_bool()
                    && rect.right - rect.left >= 400
                    && rect.bottom - rect.top >= 300
                {
                    selected = Some(Request {
                        binding_generation: 0,
                        id: "synthetic-native-probe".into(),
                        x: rect.left,
                        y: rect.top,
                        width: (rect.right - rect.left) as f64,
                        height: (rect.bottom - rect.top) as f64,
                        floor: (rect.bottom - rect.top) as f64,
                        scale: 1.0,
                        cell: 8.0,
                        threshold: 32,
                        hz: 4.0,
                        geometry: false,
                    });
                    break;
                }
            }
            if selected.is_some() {
                break;
            }
        }
        let r = selected.expect("no attached Windows desktop");
        // DPI-aware physical coordinates avoid a false exclusion result at 150% display scale.
        let old_dpi = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        struct DpiRestore(DPI_AWARENESS_CONTEXT);
        impl Drop for DpiRestore {
            fn drop(&mut self) {
                unsafe {
                    SetThreadDpiAwarenessContext(self.0);
                }
            }
        }
        let _dpi_restore = DpiRestore(old_dpi);
        let class = WNDCLASSW {
            lpfnWndProc: Some(pattern_proc),
            lpszClassName: w!("DesktopCreaturesCaptureProbe"),
            ..Default::default()
        };
        assert_ne!(RegisterClassW(&class), 0);
        let backing = TestWindow(
            CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                class.lpszClassName,
                w!("Synthetic DXGI test pattern"),
                WS_POPUP,
                r.x + 64,
                r.y + 64,
                320,
                192,
                None,
                None,
                None,
                None,
            )
            .unwrap(),
        );
        let mut capture = Capture::create(&r).unwrap();
        let _ = ShowWindow(backing.0, SW_SHOWNOACTIVATE);
        let baseline = wait_for_support(&mut capture, &r, backing.0, true);
        // SS_WHITERECT = 6 in WinUser.h. This is a plain diagnostic card, never a fake desktop.
        let cover = TestWindow(
            CreateWindowExW(
                WS_EX_NOACTIVATE
                    | WS_EX_TOOLWINDOW
                    | WS_EX_TOPMOST
                    | WS_EX_LAYERED
                    | WS_EX_TRANSPARENT,
                w!("STATIC"),
                w!("Synthetic exclusion test card"),
                WS_POPUP | WINDOW_STYLE(6),
                r.x + 64,
                r.y + 64,
                320,
                192,
                Some(backing.0),
                None,
                None,
                None,
            )
            .unwrap(),
        );
        SetLayeredWindowAttributes(cover.0, COLORREF(0), 255, LWA_ALPHA).unwrap();
        let _ = ShowWindow(cover.0, SW_SHOWNOACTIVATE);
        let visible_cover = wait_for_support(&mut capture, &r, backing.0, false);
        SetWindowDisplayAffinity(cover.0, WDA_EXCLUDEFROMCAPTURE).unwrap();
        let mut affinity = 0;
        GetWindowDisplayAffinity(cover.0, &mut affinity).unwrap();
        assert_eq!(affinity, WDA_EXCLUDEFROMCAPTURE.0);
        let excluded_cover = wait_for_support(&mut capture, &r, backing.0, true);
        let mut samples = Vec::new();
        for phase in 1..=10 {
            PAINT_PHASE.store(phase, Ordering::Relaxed);
            let _ = InvalidateRect(Some(backing.0), None, false);
            pump();
            samples.push(wait_for_support(&mut capture, &r, backing.0, true));
            std::thread::sleep(Duration::from_millis(250));
        }
        assert_eq!(
            GetForegroundWindow(),
            foreground,
            "probe stole foreground focus"
        );
        println!(
            "native-exclusion baseline={baseline} visibleCover={visible_cover} excludedCover={excluded_cover} sustained={samples:?} desktopFrames={} pointerOnly={} firstFrameMs={:?} foregroundUnchanged=true pixelsSaved=false",
            capture.frames,
            capture.diagnostics.pointer_only_events,
            capture.diagnostics.first_frame_latency_ms
        );
    }
}

#[test]
#[ignore = "real DXGI diagnostic of polling past the startup notice; does not prove image availability"]
fn native_startup_wait_does_not_restart_or_fabricate_support() {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().unwrap();
        let mut request = None;
        for ai in 0..32 {
            let Ok(adapter) = factory.EnumAdapters1(ai) else {
                break;
            };
            for oi in 0..32 {
                let Ok(output) = adapter.EnumOutputs(oi) else {
                    break;
                };
                let desc = output.GetDesc().unwrap();
                let rect = desc.DesktopCoordinates;
                if desc.AttachedToDesktop.as_bool()
                    && rect.right > rect.left
                    && rect.bottom > rect.top
                {
                    request = Some(Request {
                        binding_generation: 0,
                        id: "startup-wait-probe".into(),
                        x: rect.left,
                        y: rect.top,
                        width: (rect.right - rect.left) as f64,
                        height: (rect.bottom - rect.top) as f64,
                        floor: (rect.bottom - rect.top) as f64,
                        scale: 1.0,
                        cell: 8.0,
                        threshold: 32,
                        hz: 4.0,
                        geometry: true,
                    });
                    break;
                }
            }
            if request.is_some() {
                break;
            }
        }
        let r = request.expect("no attached desktop");
        let mut capture = Capture::create(&r).unwrap();
        let identity = capture.duplication.as_raw();
        // Inject only the age, never a fake DXGI result or pixel buffer. The old
        // implementation returned a fabricated HRESULT before even calling Acquire.
        capture.created_at = Instant::now() - FIRST_FRAME_NOTICE_AFTER;
        let start = Instant::now();
        let mut max_read_ms = 0.0_f64;
        let mut no_image_observations = 0;
        let mut tracker =
            SurfaceTracker::new(&r.id, r.width, r.height, r.floor, GeometryConfig::default());
        while start.elapsed() < Duration::from_secs(4) {
            let call = Instant::now();
            let result = capture
                .read(&r)
                .expect("only a real API error may end capture");
            max_read_ms = max_read_ms.max(call.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(
                capture.duplication.as_raw(),
                identity,
                "quiet desktop must not recreate duplication"
            );
            if capture.frames == 0 {
                assert!(result.is_none());
                assert!(capture.geometry_candidates.is_none());
                assert_eq!(capture.diagnostics.state, "first-frame-delayed");
                no_image_observations += 1;
                tracker.invalidate(first_frame_message(&capture.diagnostics.state));
                tracker.observe_unchanged(1, no_image_observations, now());
                tracker.verify_pointer_only(1, now());
                assert!(!tracker.snapshot().valid);
                assert!(tracker.snapshot().platforms.is_empty());
                assert!(tracker.snapshot().grips.is_empty());
                assert!(tracker.snapshot().error.is_some());
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        assert_eq!(capture.diagnostics.restarts, 0);
        println!(
            "startup-wait injectedAgeSeconds=3 elapsedMs={:.2} maxReadMs={max_read_ms:.2} noImageObservations={no_image_observations} frames={} sameDuplication=true diagnostics={} imageAvailabilityGate=false pixelsSaved=false",
            start.elapsed().as_secs_f64() * 1000.0,
            capture.frames,
            serde_json::to_string(&capture.diagnostics).unwrap()
        );
    }
}
