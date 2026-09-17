//! Real DXGI + V2 extraction/tracker integration using only our own painted windows.
//! No mouse/keyboard automation, desktop screenshots, or unfiltered geometry logs.
use super::*;
use crate::desktop_geometry::{SurfaceSnapshotV2, SurfaceTracker};
use std::sync::atomic::AtomicU32;

static MODE: AtomicU32 = AtomicU32::new(0);
static TICK: AtomicU32 = AtomicU32::new(0);
static V2_PAINT_COUNT: AtomicU32 = AtomicU32::new(0);

unsafe extern "system" fn geometry_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    unsafe {
        if msg != WM_PAINT {
            return DefWindowProcW(hwnd, msg, w, l);
        }
        let mut ps = PAINTSTRUCT::default();
        let dc = BeginPaint(hwnd, &mut ps);
        let white = HBRUSH(GetStockObject(WHITE_BRUSH).0);
        let black = HBRUSH(GetStockObject(BLACK_BRUSH).0);
        FillRect(
            dc,
            &RECT {
                left: 0,
                top: 0,
                right: 600,
                bottom: 400,
            },
            white,
        );
        let mode = MODE.load(Ordering::Relaxed);
        if mode != 2 {
            let shift = if mode == 1 { 48 } else { 0 };
            for y in [120 + shift, 240 + shift] {
                FillRect(
                    dc,
                    &RECT {
                        left: 48,
                        top: y,
                        right: 520,
                        bottom: y + 3,
                    },
                    black,
                );
            }
            FillRect(
                dc,
                &RECT {
                    left: 320 + shift,
                    top: 64,
                    right: 323 + shift,
                    bottom: 340,
                },
                black,
            );
        }
        // Small changing mark outside the inspected area produces a real DWM update
        // while the tested platform/grip geometry remains unchanged.
        if TICK.load(Ordering::Relaxed) % 2 == 1 {
            FillRect(
                dc,
                &RECT {
                    left: 4,
                    top: 4,
                    right: 8,
                    bottom: 8,
                },
                black,
            );
        }
        let _ = EndPaint(hwnd, &ps);
        V2_PAINT_COUNT.fetch_add(1, Ordering::Relaxed);
        LRESULT(0)
    }
}

fn fixture_counts(s: &SurfaceSnapshotV2, scale: f64, shift: f64) -> (usize, usize) {
    let platforms = s
        .platforms
        .iter()
        .filter(|p| {
            [184.0 + shift, 304.0 + shift]
                .iter()
                .any(|y| (p.y - y / scale).abs() <= 4.0)
                && p.x2 - p.x1 >= 100.0 / scale
                && p.x1 >= 95.0 / scale
                && p.x2 <= 605.0 / scale
        })
        .count();
    let grips = s
        .grips
        .iter()
        .filter(|g| {
            (g.x - (384.0 + shift) / scale).abs() <= 4.0
                && g.y2 - g.y1 >= 100.0 / scale
                && g.y1 >= 110.0 / scale
                && g.y2 <= 425.0 / scale
        })
        .count();
    (platforms, grips)
}

fn identity(s: &SurfaceSnapshotV2, scale: f64) -> Vec<(String, u64)> {
    let mut ids: Vec<_> = s
        .platforms
        .iter()
        .filter(|p| {
            p.y > 100.0 / scale
                && p.y < 440.0 / scale
                && p.x1 > 90.0 / scale
                && p.x2 < 610.0 / scale
        })
        .map(|p| (p.id.clone(), p.version))
        .collect();
    ids.extend(
        s.grips
            .iter()
            .filter(|g| {
                g.x > 100.0 / scale
                    && g.x < 600.0 / scale
                    && g.y1 > 100.0 / scale
                    && g.y2 < 430.0 / scale
            })
            .map(|g| (g.id.clone(), g.version)),
    );
    ids.sort();
    ids
}

struct Probe {
    capture: Capture,
    tracker: SurfaceTracker,
    request: Request,
    session: u64,
    observation: u64,
    processing: Vec<f64>,
}
impl Probe {
    unsafe fn new(request: Request, session: u64) -> Self {
        let tracker = SurfaceTracker::new(
            &request.id,
            request.width,
            request.height,
            request.floor,
            GeometryConfig::default(),
        );
        Self {
            capture: unsafe { Capture::create(&request).unwrap() },
            tracker,
            request,
            session,
            observation: 0,
            processing: Vec::new(),
        }
    }
    unsafe fn step(&mut self) -> SurfaceSnapshotV2 {
        let started = Instant::now();
        let result = unsafe { self.capture.read(&self.request) }.unwrap_or_else(|e| {
            panic!(
                "native V2 capture failed: {e}; paints={}, diagnostics={}",
                V2_PAINT_COUNT.load(Ordering::Relaxed),
                serde_json::to_string(&self.capture.diagnostics).unwrap()
            )
        });
        self.observation += 1;
        if let Some(grid) = result {
            assert!(
                grid.is_empty(),
                "opt-in V2 must not generate the legacy grid"
            );
            let candidates = self
                .capture
                .geometry_candidates
                .take()
                .expect("real image must extract V2 candidates");
            self.tracker.observe_image(
                self.session,
                self.observation,
                self.capture.diagnostics.last_image_at_ms,
                candidates,
            );
        } else if self.capture.frames > 0 {
            if self.capture.frame_held {
                self.tracker.verify_pointer_only(self.session, now());
            } else {
                self.tracker
                    .observe_unchanged(self.session, self.observation, now());
            }
        } else {
            self.tracker
                .invalidate(first_frame_message(&self.capture.diagnostics.state));
        }
        self.tracker.advance_time(now());
        self.processing
            .push(started.elapsed().as_secs_f64() * 1000.0);
        self.tracker.snapshot().clone()
    }
}

unsafe fn repaint(hwnd: HWND) {
    TICK.fetch_add(1, Ordering::Relaxed);
    unsafe {
        let _ = InvalidateRect(Some(hwnd), None, false);
        let _ = UpdateWindow(hwnd);
        pump();
    }
}

unsafe fn await_counts(
    probe: &mut Probe,
    hwnd: HWND,
    shift: f64,
    present: bool,
) -> SurfaceSnapshotV2 {
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut last = (0, 0);
    while Instant::now() < deadline {
        unsafe {
            repaint(hwnd);
        }
        std::thread::sleep(Duration::from_millis(100));
        let snapshot = unsafe { probe.step() };
        last = fixture_counts(&snapshot, probe.request.scale, shift);
        if snapshot.valid
            && if present {
                last.0 >= 2 && last.1 >= 1
            } else {
                last == (0, 0)
            }
        {
            return snapshot;
        }
    }
    panic!(
        "native V2 fixture expected present={present}, last counts={last:?}, paints={}, diagnostics={}",
        V2_PAINT_COUNT.load(Ordering::Relaxed),
        serde_json::to_string(&probe.capture.diagnostics).unwrap()
    );
}

#[test]
#[ignore = "paints owned non-activating Windows fixtures and captures them through real DXGI"]
fn native_v2_platforms_grips_exclusion_and_session() {
    unsafe {
        let foreground = GetForegroundWindow();
        let old_dpi = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        struct RestoreDpi(DPI_AWARENESS_CONTEXT);
        impl Drop for RestoreDpi {
            fn drop(&mut self) {
                unsafe {
                    SetThreadDpiAwarenessContext(self.0);
                }
            }
        }
        let _dpi = RestoreDpi(old_dpi);
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
                    && rect.right - rect.left >= 800
                    && rect.bottom - rect.top >= 600
                {
                    request = Some(Request {
                        binding_generation: 0,
                        id: "v2-owned-window-probe".into(),
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
        let mut r = request.expect("no attached desktop large enough for owned fixture");
        let class = WNDCLASSW {
            lpfnWndProc: Some(geometry_proc),
            lpszClassName: w!("DesktopCreaturesV2NativeFixture"),
            ..Default::default()
        };
        assert_ne!(RegisterClassW(&class), 0);
        let backing = TestWindow(
            CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                class.lpszClassName,
                w!("Owned V2 geometry fixture"),
                WS_POPUP,
                r.x + 64,
                r.y + 64,
                600,
                400,
                None,
                None,
                None,
                None,
            )
            .unwrap(),
        );
        let _ = ShowWindow(backing.0, SW_SHOWNOACTIVATE);
        pump();
        r.scale = GetDpiForWindow(backing.0) as f64 / 96.0;
        r.width /= r.scale;
        r.height /= r.scale;
        r.floor /= r.scale;
        let mut probe = Probe::new(r.clone(), 1);
        let deadline = Instant::now() + Duration::from_secs(3);
        while probe.capture.frames == 0 && Instant::now() < deadline {
            repaint(backing.0);
            std::thread::sleep(Duration::from_millis(40));
            let first = probe.step();
            assert_eq!(
                fixture_counts(&first, r.scale, 0.0),
                (0, 0),
                "one image cannot confirm stable geometry"
            );
        }
        assert!(
            probe.capture.frames > 0,
            "no native V2 image; paints={}, diagnostics={}",
            V2_PAINT_COUNT.load(Ordering::Relaxed),
            serde_json::to_string(&probe.capture.diagnostics).unwrap()
        );
        let stable = await_counts(&mut probe, backing.0, 0.0, true);
        let baseline_counts = fixture_counts(&stable, r.scale, 0.0);
        let stable_ids = identity(&stable, r.scale);
        assert!(!stable_ids.is_empty());
        let mut continuity = 0;
        for _ in 0..10 {
            repaint(backing.0);
            std::thread::sleep(Duration::from_millis(250));
            let same = probe.step();
            assert_eq!(
                identity(&same, r.scale),
                stable_ids,
                "static support identity/version changed"
            );
            continuity += 1;
        }
        let cover = TestWindow(
            CreateWindowExW(
                WS_EX_NOACTIVATE
                    | WS_EX_TOOLWINDOW
                    | WS_EX_TOPMOST
                    | WS_EX_LAYERED
                    | WS_EX_TRANSPARENT,
                w!("STATIC"),
                w!("Owned V2 exclusion card"),
                WS_POPUP | WINDOW_STYLE(6),
                r.x + 64,
                r.y + 64,
                600,
                400,
                Some(backing.0),
                None,
                None,
                None,
            )
            .unwrap(),
        );
        SetLayeredWindowAttributes(cover.0, COLORREF(0), 255, LWA_ALPHA).unwrap();
        let _ = ShowWindow(cover.0, SW_SHOWNOACTIVATE);
        let covered = await_counts(&mut probe, backing.0, 0.0, false);
        assert_eq!(fixture_counts(&covered, r.scale, 0.0), (0, 0));
        SetWindowDisplayAffinity(cover.0, WDA_EXCLUDEFROMCAPTURE).unwrap();
        let excluded = await_counts(&mut probe, backing.0, 0.0, true);
        assert_eq!(fixture_counts(&excluded, r.scale, 0.0), baseline_counts);
        MODE.store(1, Ordering::Relaxed);
        let shifted = await_counts(&mut probe, backing.0, 48.0, true);
        std::thread::sleep(Duration::from_millis(180));
        probe.tracker.advance_time(now());
        assert_eq!(
            fixture_counts(probe.tracker.snapshot(), r.scale, 0.0),
            (0, 0)
        );
        assert!(fixture_counts(&shifted, r.scale, 48.0).0 >= 2);
        MODE.store(2, Ordering::Relaxed);
        let blank = await_counts(&mut probe, backing.0, 48.0, false);
        assert_eq!(fixture_counts(&blank, r.scale, 48.0), (0, 0));
        probe.tracker.invalidate("injected capture-session reset");
        probe.tracker.observe_unchanged(2, 1, now());
        probe.tracker.verify_pointer_only(2, now());
        assert!(!probe.tracker.snapshot().valid);
        assert!(probe.tracker.snapshot().platforms.is_empty());
        let image_frames = probe.capture.frames;
        drop(probe.capture);
        MODE.store(0, Ordering::Relaxed);
        let mut restarted = Probe::new(r.clone(), 2);
        let recovered = await_counts(&mut restarted, backing.0, 0.0, true);
        assert!(recovered.valid);
        assert_eq!(
            GetForegroundWindow(),
            foreground,
            "owned fixture stole foreground"
        );
        probe.processing.sort_by(f64::total_cmp);
        println!(
            "native-v2 scale={} baselinePlatforms={} baselineGrips={} stableIdentityChecks={continuity} desktopFrames={image_frames} unexcludedCover=(0,0) excludedRestored=true movedOldRemoved=true blankRemoved=true injectedSessionResetRecovered=true acquireAndProcessP95Ms={:.2} foregroundUnchanged=true pixelsSaved=false",
            r.scale,
            baseline_counts.0,
            baseline_counts.1,
            probe.processing[probe.processing.len() * 95 / 100]
        );
    }
}
