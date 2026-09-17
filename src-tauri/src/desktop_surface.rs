//! Pixels never leave this worker. Only a bounded, local-DIP support grid reaches WebView.
use super::desktop_geometry::{
    self, BgraFrame, FrameRotation, GeometryCandidates, GeometryConfig, SurfaceSnapshotV2,
    SurfaceTracker,
};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    sync::{LazyLock, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
static LAST_REQUEST: AtomicU64 = AtomicU64::new(0);
// A quiet or powered-off display need not produce an image in this interval.
// Report delayed startup, but keep polling the same duplication until a real API error.
const FIRST_FRAME_NOTICE_AFTER: Duration = Duration::from_secs(3);
use windows::{
    Win32::{
        Foundation::HMODULE,
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
            Direct3D11::*,
            Dxgi::{Common::*, *},
        },
        UI::WindowsAndMessaging::{
            GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
        },
    },
    core::Interface,
};

#[derive(Clone, PartialEq)]
struct Request {
    binding_generation: u64,
    id: String,
    x: i32,
    y: i32,
    width: f64,
    height: f64,
    floor: f64,
    scale: f64,
    cell: f64,
    threshold: u8,
    hz: f64,
    geometry: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(skip)]
    request: Request,
    display_id: String,
    revision: u64,
    captured_at_ms: u64,
    valid: bool,
    width: f64,
    height: f64,
    floor_y: f64,
    cell_dip: f64,
    columns: usize,
    rows: usize,
    cells: Vec<u8>,
    error: Option<String>,
    processing_ms: f64,
    captured_frames: u64,
    pixel_range: [u8; 2],
    diagnostics: Option<CaptureDiagnostics>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureDiagnostics {
    adapter: String,
    output: String,
    acquisition_events: u64,
    pointer_only_events: u64,
    wait_timeouts: u64,
    first_frame_latency_ms: Option<f64>,
    last_image_at_ms: u64,
    protected_content_masked: bool,
    restarts: u64,
    state: String,
    api_stage: String,
    last_hresult: Option<String>,
    last_present_time: i64,
    last_mouse_update_time: i64,
    last_accumulated_frames: u32,
    last_resource_present: bool,
}
static REQUEST: LazyLock<Mutex<Option<Request>>> = LazyLock::new(|| Mutex::new(None));
static LATEST: LazyLock<Mutex<Option<Snapshot>>> = LazyLock::new(|| Mutex::new(None));
static LATEST_V2: LazyLock<Mutex<Option<(Request, SurfaceSnapshotV2)>>> =
    LazyLock::new(|| Mutex::new(None));
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn exclude(window: &tauri::WebviewWindow) -> Result<(), String> {
    unsafe {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let mut affinity = 0;
        GetWindowDisplayAffinity(hwnd, &mut affinity).map_err(|e| e.to_string())?;
        if affinity == WDA_EXCLUDEFROMCAPTURE.0 {
            return Ok(());
        }
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn desktop_surface(
    window: tauri::WebviewWindow,
    app: AppHandle,
    binding_generation: Option<u64>,
    display_id: String,
    cell_dip: f64,
    edge_threshold: u8,
    sample_hz: f64,
) -> Result<Option<Snapshot>, String> {
    let mut binding = if crate::campaign_runtime_enabled() {
        let state = crate::campaign_display::lock(&app)?;
        state.validate_binding(
            window.label(),
            &display_id,
            binding_generation.ok_or("Missing display generation")?,
        )?;
        Some(state)
    } else {
        None
    };
    let r = request_surface(
        &app,
        display_id,
        cell_dip,
        edge_threshold,
        sample_hz,
        false,
        binding_generation.unwrap_or(0),
    )
    .map_err(|error| {
        if let Some(state) = binding.as_deref_mut() {
            crate::campaign_display::reject_owner_geometry(&window, state, &error);
        }
        error
    })?;
    publish_request(&window, binding.as_deref_mut(), &r)?;
    Ok(LATEST
        .lock()
        .map_err(|_| "感知锁失败")?
        .as_ref()
        .filter(|s| snapshot_matches(s, &r) && now().saturating_sub(s.captured_at_ms) <= 1000)
        .cloned())
}

#[tauri::command]
pub async fn desktop_surface_v2(
    window: tauri::WebviewWindow,
    app: AppHandle,
    display_id: String,
    binding_generation: Option<u64>,
) -> Result<Option<SurfaceSnapshotV2>, String> {
    let mut binding = if crate::campaign_runtime_enabled() {
        let state = crate::campaign_display::lock(&app)?;
        state.validate_binding(
            window.label(),
            &display_id,
            binding_generation.ok_or("Missing display generation")?,
        )?;
        Some(state)
    } else {
        None
    };
    let r = request_surface(
        &app,
        display_id,
        8.0,
        32,
        4.0,
        true,
        binding_generation.unwrap_or(0),
    )
    .map_err(|error| {
        if let Some(state) = binding.as_deref_mut() {
            crate::campaign_display::reject_owner_geometry(&window, state, &error);
        }
        error
    })?;
    publish_request(&window, binding.as_deref_mut(), &r)?;
    let snapshot = LATEST_V2
        .lock()
        .map_err(|_| "感知锁失败")?
        .as_ref()
        .filter(|(request, s)| {
            request == &r && (!s.valid || now().saturating_sub(s.verified_at_ms) <= 1000)
        })
        .map(|(_, s)| s.clone());
    if let Some(state) = binding.as_mut() {
        state.mark_surface(snapshot.as_ref().is_some_and(|s| s.valid));
    }
    Ok(snapshot)
}

pub fn invalidate_binding() {
    if let Ok(mut request) = REQUEST.lock() {
        *request = None;
    }
    if let Ok(mut latest) = LATEST.lock() {
        *latest = None;
    }
    if let Ok(mut latest) = LATEST_V2.lock() {
        *latest = None;
    }
}
pub fn binding_surface_valid(display: &str, generation: u64) -> bool {
    LATEST_V2.lock().ok().is_some_and(|latest| {
        latest.as_ref().is_some_and(|(r, s)| {
            r.id == display
                && r.binding_generation == generation
                && s.valid
                && now().saturating_sub(s.verified_at_ms) <= 1000
        })
    })
}

fn request_surface(
    app: &AppHandle,
    display_id: String,
    cell_dip: f64,
    edge_threshold: u8,
    sample_hz: f64,
    geometry: bool,
    binding_generation: u64,
) -> Result<Request, String> {
    if !(4.0..=32.0).contains(&cell_dip)
        || !(1.0..=10.0).contains(&sample_hz)
        || edge_threshold == 0
    {
        return Err("感知参数无效".into());
    }
    let displays = super::window_manager::list_displays(&app).map_err(|e| e.to_string())?;
    let d = displays
        .iter()
        .find(|d| {
            if display_id == "primary" {
                d.primary
            } else {
                d.id == display_id
            }
        })
        .ok_or("显示器已断开")?;
    for (label, w) in app.webview_windows() {
        if label.starts_with("overlay-") || label == "trash-bin" {
            exclude(&w)?;
        }
    }
    let primary = app
        .get_webview_window(super::window_manager::OVERLAY_LABEL)
        .ok_or("覆盖层不可用")?;
    let monitors = primary.available_monitors().map_err(|e| e.to_string())?;
    let m = monitors
        .iter()
        .find(|m| m.position().x == d.position.x && m.position().y == d.position.y)
        .ok_or("显示器已断开")?;
    let area = m.work_area();
    let r = Request {
        binding_generation,
        id: display_id.clone(),
        x: d.position.x,
        y: d.position.y,
        width: d.size.width as f64 / d.scale_factor,
        height: d.size.height as f64 / d.scale_factor,
        floor: (area.position.y + area.size.height as i32 - d.position.y) as f64 / d.scale_factor,
        scale: d.scale_factor,
        cell: cell_dip,
        threshold: edge_threshold,
        hz: sample_hz,
        geometry,
    };
    Ok(r)
}
fn request_matches_owner(r: &Request, actual: &crate::campaign_display::OwnerGeometry) -> bool {
    r.x == actual.position.x
        && r.y == actual.position.y
        && (r.width * r.scale).round() == f64::from(actual.size.width)
        && (r.height * r.scale).round() == f64::from(actual.size.height)
        && actual.scale.is_finite()
        && (r.scale - actual.scale).abs() <= 0.001
}
fn publish_request(
    window: &tauri::WebviewWindow,
    binding: Option<&mut crate::campaign_display::DisplayState>,
    r: &Request,
) -> Result<(), String> {
    if let Some(state) = binding {
        // Enumeration and live geometry can change ahead of topology polling.
        // Validate both the cached binding and the capture target before publish.
        let actual = crate::campaign_display::require_owner_geometry(window, state, &r.id)?;
        if !request_matches_owner(r, &actual) {
            return Err(crate::campaign_display::reject_owner_geometry(
                window,
                state,
                "Capture target geometry differs from the owner viewport",
            ));
        }
    }
    LAST_REQUEST.store(now(), Ordering::Relaxed);
    *REQUEST.lock().map_err(|_| "感知锁失败")? = Some(r.clone());
    Ok(())
}
fn snapshot_matches(s: &Snapshot, r: &Request) -> bool {
    &s.request == r
}
struct Capture {
    context: ID3D11DeviceContext,
    device: ID3D11Device,
    duplication: IDXGIOutputDuplication,
    staging: Option<ID3D11Texture2D>,
    frames: u64,
    pixel_range: [u8; 2],
    last_frame_info: DXGI_OUTDUPL_FRAME_INFO,
    created_at: Instant,
    frame_held: bool,
    diagnostics: CaptureDiagnostics,
    geometry_candidates: Option<GeometryCandidates>,
}
// Disconnected/virtual outputs can share (0, 0); match the attached physical bounds too.
fn output_matches(desc: &DXGI_OUTPUT_DESC, r: &Request) -> bool {
    let rect = desc.DesktopCoordinates;
    desc.AttachedToDesktop.as_bool()
        && rect.left == r.x
        && rect.top == r.y
        && rect.right > rect.left
        && rect.bottom > rect.top
        && rect.right - rect.left == (r.width * r.scale).round() as i32
        && rect.bottom - rect.top == (r.height * r.scale).round() as i32
}
fn is_desktop_update(info: &DXGI_OUTDUPL_FRAME_INFO) -> bool {
    info.LastPresentTime != 0 && info.AccumulatedFrames != 0
}
fn no_image_state(frames: u64, elapsed: Duration) -> &'static str {
    if frames > 0 {
        "unchanged"
    } else if elapsed >= FIRST_FRAME_NOTICE_AFTER {
        "first-frame-delayed"
    } else {
        "waiting-first-frame"
    }
}
fn first_frame_message(state: &str) -> &'static str {
    if state == "first-frame-delayed" {
        "等待桌面图像首帧：超过3秒无图像更新（显示器关闭或桌面未更新等）；采集仍在等待"
    } else {
        "等待桌面首帧"
    }
}
fn api_error(stage: &str, error: windows::core::Error) -> windows::core::Error {
    windows::core::Error::new(error.code(), format!("{stage}: {error}"))
}
impl Capture {
    unsafe fn create(r: &Request) -> windows::core::Result<Self> {
        unsafe {
            let factory: IDXGIFactory1 =
                CreateDXGIFactory1().map_err(|e| api_error("CreateDXGIFactory1", e))?;
            for ai in 0..32 {
                let Ok(adapter) = factory.EnumAdapters1(ai) else {
                    break;
                };
                for oi in 0..32 {
                    let Ok(output) = adapter.EnumOutputs(oi) else {
                        break;
                    };
                    let desc = output.GetDesc()?;
                    if !output_matches(&desc, r) {
                        continue;
                    }
                    let mut device = None;
                    let mut context = None;
                    let adapter_name = String::from_utf16_lossy(&adapter.GetDesc1()?.Description)
                        .trim_end_matches('\0')
                        .to_owned();
                    let adapter: IDXGIAdapter = adapter.cast()?;
                    D3D11CreateDevice(
                        &adapter,
                        D3D_DRIVER_TYPE_UNKNOWN,
                        HMODULE::default(),
                        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                        None,
                        D3D11_SDK_VERSION,
                        Some(&mut device),
                        None,
                        Some(&mut context),
                    )
                    .map_err(|e| api_error("D3D11CreateDevice", e))?;
                    let missing_object = || {
                        windows::core::Error::new(
                            windows::Win32::Foundation::E_FAIL,
                            "D3D11初始化没有返回设备或上下文",
                        )
                    };
                    let device = device.ok_or_else(missing_object)?;
                    let output: IDXGIOutput1 = output.cast()?;
                    let duplication = output
                        .DuplicateOutput(&device)
                        .map_err(|e| api_error("DuplicateOutput", e))?;
                    return Ok(Self {
                        context: context.ok_or_else(missing_object)?,
                        device,
                        duplication,
                        staging: None,
                        frames: 0,
                        pixel_range: [0, 0],
                        last_frame_info: DXGI_OUTDUPL_FRAME_INFO::default(),
                        created_at: Instant::now(),
                        frame_held: false,
                        geometry_candidates: None,
                        diagnostics: CaptureDiagnostics {
                            adapter: adapter_name,
                            output: String::from_utf16_lossy(&desc.DeviceName)
                                .trim_end_matches('\0')
                                .to_owned(),
                            acquisition_events: 0,
                            pointer_only_events: 0,
                            wait_timeouts: 0,
                            first_frame_latency_ms: None,
                            last_image_at_ms: 0,
                            protected_content_masked: false,
                            restarts: 0,
                            state: "waiting-first-frame".into(),
                            api_stage: "DuplicateOutput".into(),
                            last_hresult: None,
                            last_present_time: 0,
                            last_mouse_update_time: 0,
                            last_accumulated_frames: 0,
                            last_resource_present: false,
                        },
                    });
                }
            }
            Err(windows::core::Error::new(
                windows::Win32::Foundation::E_FAIL,
                "DXGI没有与目标显示器位置、尺寸一致的已连接输出",
            ))
        }
    }
    unsafe fn read(&mut self, r: &Request) -> windows::core::Result<Option<Vec<u8>>> {
        let result = unsafe { self.read_next(r) };
        result.map_err(|e| {
            self.diagnostics.state = "error".into();
            self.diagnostics.last_hresult = Some(format!("0x{:08X}", e.code().0 as u32));
            api_error(&self.diagnostics.api_stage, e)
        })
    }
    unsafe fn read_next(&mut self, r: &Request) -> windows::core::Result<Option<Vec<u8>>> {
        unsafe {
            // Release immediately before acquiring, as required by the DXGI lifecycle.
            // Holding between samples lets DXGI coalesce updates without redundant copies.
            if self.frame_held {
                self.frame_held = false;
                self.diagnostics.api_stage = "ReleaseFrame".into();
                self.duplication.ReleaseFrame()?;
            }
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource = None;
            self.diagnostics.api_stage = "AcquireNextFrame".into();
            match self
                .duplication
                .AcquireNextFrame(50, &mut info, &mut resource)
            {
                Ok(()) => self.diagnostics.last_hresult = Some("0x00000000".into()),
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    self.diagnostics.wait_timeouts += 1;
                    self.diagnostics.last_hresult = Some("0x887A0027".into());
                    self.diagnostics.state =
                        no_image_state(self.frames, self.created_at.elapsed()).into();
                    return Ok(None);
                }
                Err(e) => return Err(e),
            }
            self.last_frame_info = info;
            self.frame_held = true;
            self.diagnostics.acquisition_events += 1;
            self.diagnostics.last_present_time = info.LastPresentTime;
            self.diagnostics.last_mouse_update_time = info.LastMouseUpdateTime;
            self.diagnostics.last_accumulated_frames = info.AccumulatedFrames;
            self.diagnostics.last_resource_present = resource.is_some();
            // An initial pointer-only event can contain an uninitialized black texture.
            // It is not a desktop image and must never seed the support map.
            if !is_desktop_update(&info) {
                self.diagnostics.pointer_only_events += 1;
                self.diagnostics.state =
                    no_image_state(self.frames, self.created_at.elapsed()).into();
                return Ok(None);
            }
            let result = (|| -> windows::core::Result<Vec<u8>> {
                self.diagnostics.api_stage = "DesktopTexture".into();
                let texture: ID3D11Texture2D = resource
                    .ok_or_else(|| {
                        windows::core::Error::new(
                            windows::Win32::Foundation::E_FAIL,
                            "DXGI返回桌面更新但没有纹理资源",
                        )
                    })?
                    .cast()?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                texture.GetDesc(&mut desc);
                if desc.Width == 0 || desc.Height == 0 || desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
                {
                    return Err(windows::core::Error::new(
                        windows::Win32::Foundation::E_FAIL,
                        "DXGI返回空尺寸或不支持的桌面像素格式",
                    ));
                }
                let staging_matches = self.staging.as_ref().is_some_and(|staging| {
                    let mut old = D3D11_TEXTURE2D_DESC::default();
                    staging.GetDesc(&mut old);
                    old.Width == desc.Width
                        && old.Height == desc.Height
                        && old.Format == desc.Format
                });
                if !staging_matches {
                    self.staging = None;
                    desc.Usage = D3D11_USAGE_STAGING;
                    desc.BindFlags = 0;
                    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                    desc.MiscFlags = 0;
                    self.diagnostics.api_stage = "CreateTexture2D".into();
                    self.device
                        .CreateTexture2D(&desc, None, Some(&mut self.staging))?;
                }
                let staging = self.staging.as_ref().ok_or_else(|| {
                    windows::core::Error::new(
                        windows::Win32::Foundation::E_FAIL,
                        "D3D11没有返回桌面读回纹理",
                    )
                })?;
                self.context.CopyResource(staging, &texture);
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                self.diagnostics.api_stage = "Map".into();
                self.context
                    .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
                if mapped.pData.is_null() || mapped.RowPitch < desc.Width * 4 {
                    self.context.Unmap(staging, 0);
                    return Err(windows::core::Error::new(
                        windows::Win32::Foundation::E_FAIL,
                        "D3D11桌面读回缓冲区无效",
                    ));
                }
                let data = std::slice::from_raw_parts(
                    mapped.pData as *const u8,
                    mapped.RowPitch as usize * desc.Height as usize,
                );
                self.frames += 1;
                self.diagnostics
                    .first_frame_latency_ms
                    .get_or_insert_with(|| self.created_at.elapsed().as_secs_f64() * 1000.0);
                self.diagnostics.last_image_at_ms = now();
                self.diagnostics.protected_content_masked =
                    info.ProtectedContentMaskedOut.as_bool();
                self.diagnostics.state = "live".into();
                let mut low = 255;
                let mut high = 0;
                for y in (0..desc.Height as usize).step_by(8) {
                    for x in (0..desc.Width as usize).step_by(8) {
                        let v = data[y * mapped.RowPitch as usize + x * 4];
                        low = low.min(v);
                        high = high.max(v);
                    }
                }
                self.pixel_range = [low, high];
                let rotation = self.duplication.GetDesc().Rotation;
                self.diagnostics.api_stage = "Extract".into();
                let geometry = if r.geometry {
                    desktop_geometry::extract_candidates(
                        &BgraFrame {
                            pixels: data,
                            width_px: desc.Width as usize,
                            height_px: desc.Height as usize,
                            row_pitch: mapped.RowPitch as usize,
                            scale_factor: r.scale,
                            rotation: match rotation {
                                DXGI_MODE_ROTATION_ROTATE90 => FrameRotation::Rotate90,
                                DXGI_MODE_ROTATION_ROTATE180 => FrameRotation::Rotate180,
                                DXGI_MODE_ROTATION_ROTATE270 => FrameRotation::Rotate270,
                                _ => FrameRotation::Identity,
                            },
                            width_dip: r.width,
                            height_dip: r.height,
                            floor_y_dip: r.floor,
                        },
                        &GeometryConfig::default(),
                    )
                    .map(Some)
                } else {
                    Ok(None)
                };
                let grid = if r.geometry {
                    vec![]
                } else {
                    extract(
                        data,
                        desc.Width as usize,
                        desc.Height as usize,
                        mapped.RowPitch as usize,
                        r,
                        rotation,
                    )
                };
                self.context.Unmap(staging, 0);
                self.geometry_candidates = geometry.map_err(|e| {
                    windows::core::Error::new(windows::Win32::Foundation::E_FAIL, e.to_string())
                })?;
                Ok(grid)
            })();
            result.map(Some)
        }
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        if self.frame_held {
            unsafe {
                let _ = self.duplication.ReleaseFrame();
            }
        }
    }
}
fn extract(
    data: &[u8],
    width: usize,
    height: usize,
    pitch: usize,
    r: &Request,
    rotation: DXGI_MODE_ROTATION,
) -> Vec<u8> {
    let cols = (r.width / r.cell).ceil() as usize + 1;
    let rows = (r.height / r.cell).ceil() as usize + 1;
    let mut result = vec![0; cols * rows];
    let sample = |x: usize, y: usize| -> i32 {
        let (x, y) = match rotation {
            DXGI_MODE_ROTATION_ROTATE90 => (y, height.saturating_sub(x + 1)),
            DXGI_MODE_ROTATION_ROTATE180 => {
                (width.saturating_sub(x + 1), height.saturating_sub(y + 1))
            }
            DXGI_MODE_ROTATION_ROTATE270 => (width.saturating_sub(y + 1), x),
            _ => (x, y),
        };
        let i = y.min(height - 1) * pitch + x.min(width - 1) * 4;
        (data[i] as i32 * 29 + data[i + 1] as i32 * 150 + data[i + 2] as i32 * 77) / 256
    };
    for y in 0..rows {
        for x in 0..cols {
            let px = (x as f64 * r.cell * r.scale) as usize;
            let py = (y as f64 * r.cell * r.scale) as usize;
            let radius = (r.cell * r.scale / 2.0).max(1.0) as usize;
            let mut low = 255;
            let mut high = 0;
            // Sample within the cell at native pixel resolution to retain tiny text strokes.
            for dy in 0..radius * 2 {
                for dx in 0..radius * 2 {
                    let v = sample(
                        px.saturating_sub(radius) + dx,
                        py.saturating_sub(radius) + dy,
                    );
                    low = low.min(v);
                    high = high.max(v);
                }
            }
            result[y * cols + x] = u8::from(high - low >= r.threshold as i32);
        }
    }
    result
}
pub fn start() {
    std::thread::spawn(|| {
        let mut current: Option<Request> = None;
        let mut capture: Option<Capture> = None;
        let mut revision = 0;
        let mut restarts = 0;
        let mut retry_after: Option<Instant> = None;
        let mut tracker: Option<SurfaceTracker> = None;
        let mut session_id = 0_u64;
        let mut observation_id = 0_u64;
        loop {
            let request = REQUEST.lock().ok().and_then(|r| r.clone());
            if now().saturating_sub(LAST_REQUEST.load(Ordering::Relaxed)) > 3000 {
                capture = None;
                current = None;
                *LATEST.lock().unwrap() = None;
                *LATEST_V2.lock().unwrap() = None;
                tracker = None;
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }
            if let Some(r) = request {
                let started = Instant::now();
                if current.as_ref() != Some(&r) {
                    capture = None;
                    current = Some(r.clone());
                    restarts = 0;
                    retry_after = None;
                    *LATEST.lock().unwrap() = None;
                    *LATEST_V2.lock().unwrap() = None;
                    tracker = r.geometry.then(|| {
                        SurfaceTracker::new(
                            &r.id,
                            r.width,
                            r.height,
                            r.floor,
                            GeometryConfig::default(),
                        )
                    });
                }
                if retry_after.is_some_and(|at| Instant::now() < at) {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                let result = unsafe {
                    if capture.is_none() {
                        Capture::create(&r).map(|mut c| {
                            session_id += 1;
                            c.diagnostics.restarts = restarts;
                            capture = Some(c);
                        })
                    } else {
                        Ok(())
                    }
                    .and_then(|_| capture.as_mut().unwrap().read(&r))
                };
                let diagnostics = capture.as_ref().map(|c| c.diagnostics.clone());
                if let Some(t) = tracker.as_mut() {
                    observation_id += 1;
                    match &result {
                        Ok(Some(_)) => {
                            if let Some(c) = capture.as_mut() {
                                if let Some(candidates) = c.geometry_candidates.take() {
                                    t.observe_image(
                                        session_id,
                                        observation_id,
                                        c.diagnostics.last_image_at_ms,
                                        candidates,
                                    );
                                }
                            }
                        }
                        Ok(None)
                            if capture
                                .as_ref()
                                .is_some_and(|c| c.frames > 0 && !c.frame_held) =>
                        {
                            t.observe_unchanged(session_id, observation_id, now());
                        }
                        Ok(None)
                            if capture
                                .as_ref()
                                .is_some_and(|c| c.frames > 0 && c.frame_held) =>
                        {
                            t.verify_pointer_only(session_id, now());
                        }
                        Ok(None) => {
                            if let Some(c) = capture.as_ref() {
                                t.invalidate(first_frame_message(&c.diagnostics.state));
                            }
                        }
                        Err(e) => {
                            t.invalidate(format!("桌面识别不可用：{e}"));
                        }
                    }
                    t.advance_time(now());
                    *LATEST_V2.lock().unwrap() = Some((r.clone(), t.snapshot().clone()));
                }
                let mut latest = LATEST.lock().unwrap();
                let previous = latest.as_ref().filter(|s| {
                    s.display_id == r.id
                        && s.valid
                        && s.cell_dip == r.cell
                        && capture.as_ref().is_some_and(|c| c.frames > 0)
                });
                let (cells, valid, error) = match result {
                    Ok(Some(c)) => (c, true, None),
                    Ok(None) => previous
                        .map(|s| (s.cells.clone(), true, None))
                        .unwrap_or_else(|| {
                            let state = capture
                                .as_ref()
                                .map_or("", |c| c.diagnostics.state.as_str());
                            (vec![], false, Some(first_frame_message(state).into()))
                        }),
                    Err(e) => {
                        capture = None;
                        restarts += 1;
                        retry_after = Some(Instant::now() + Duration::from_secs(1));
                        (vec![], false, Some(format!("桌面识别不可用：{e}")))
                    }
                };
                if previous.is_none_or(|s| s.cells != cells) || !valid {
                    revision += 1;
                }
                *latest = Some(Snapshot {
                    request: r.clone(),
                    display_id: r.id.clone(),
                    revision,
                    captured_at_ms: now(),
                    valid,
                    width: r.width,
                    height: r.height,
                    floor_y: r.floor,
                    cell_dip: r.cell,
                    columns: (r.width / r.cell).ceil() as usize + 1,
                    rows: (r.height / r.cell).ceil() as usize + 1,
                    cells,
                    error,
                    processing_ms: started.elapsed().as_secs_f64() * 1000.0,
                    captured_frames: capture.as_ref().map_or(0, |c| c.frames),
                    pixel_range: capture.as_ref().map_or([0, 0], |c| c.pixel_range),
                    diagnostics,
                });
                drop(latest);
                std::thread::sleep(
                    Duration::from_secs_f64(1.0 / r.hz).saturating_sub(started.elapsed()),
                );
            } else {
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    });
}
#[cfg(test)]
#[path = "desktop_surface_native_tests.rs"]
mod native_tests;
#[cfg(test)]
mod tests {
    use super::*;
    fn probe_request() -> Request {
        Request {
            binding_generation: 0,
            id: "probe".into(),
            x: 0,
            y: 0,
            width: 2560.0,
            height: 1440.0,
            floor: 1440.0,
            scale: 1.0,
            cell: 8.0,
            threshold: 32,
            hz: 4.0,
            geometry: false,
        }
    }
    #[test]
    fn capture_target_must_match_live_owner_origin_size_and_scale() {
        let r = probe_request();
        let owner = crate::campaign_display::OwnerGeometry {
            position: tauri::PhysicalPosition::new(0, 0),
            size: tauri::PhysicalSize::new(2560, 1440),
            scale: 1.,
        };
        assert!(request_matches_owner(&r, &owner));
        assert!(!request_matches_owner(
            &r,
            &crate::campaign_display::OwnerGeometry {
                scale: 1.5,
                ..owner.clone()
            }
        ));
        assert!(!request_matches_owner(
            &r,
            &crate::campaign_display::OwnerGeometry {
                position: tauri::PhysicalPosition::new(-2560, 0),
                ..owner.clone()
            }
        ));
        assert!(!request_matches_owner(
            &r,
            &crate::campaign_display::OwnerGeometry {
                size: tauri::PhysicalSize::new(1920, 1080),
                ..owner
            }
        ));
    }
    #[test]
    fn same_monitor_new_generation_cannot_reuse_capture_or_surface_cache() {
        let previous = probe_request();
        let mut moved = previous.clone();
        moved.binding_generation += 1;
        assert!(previous != moved);
        let mut dpi_changed = previous.clone();
        dpi_changed.scale = 1.5;
        assert!(previous != dpi_changed);
    }
    #[test]
    fn ignores_pointer_only_startup_including_black_texture_events() {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        info.LastMouseUpdateTime = 123;
        assert!(!is_desktop_update(&info));
        assert_eq!(no_image_state(0, Duration::ZERO), "waiting-first-frame");
        assert_eq!(
            no_image_state(0, Duration::from_secs(4)),
            "first-frame-delayed"
        );
        assert_eq!(no_image_state(1, Duration::from_secs(4)), "unchanged");
        info.LastPresentTime = 456;
        info.AccumulatedFrames = 1;
        assert!(is_desktop_update(&info));
    }
    #[test]
    fn output_selection_rejects_disconnected_and_wrong_sized_origin_matches() {
        let mut d = DXGI_OUTPUT_DESC::default();
        d.DesktopCoordinates.right = 2560;
        d.DesktopCoordinates.bottom = 1440;
        let mut r = probe_request();
        assert!(!output_matches(&d, &r));
        d.AttachedToDesktop = true.into();
        assert!(output_matches(&d, &r));
        r.width /= 1.5;
        r.height /= 1.5;
        r.scale = 1.5;
        assert!(output_matches(&d, &r));
        d.DesktopCoordinates.right = 1920;
        assert!(!output_matches(&d, &r));
        d.DesktopCoordinates.right = 2560;
        d.DesktopCoordinates.left = -2560;
        assert!(!output_matches(&d, &r));
    }
    #[test]
    #[ignore = "requires an unlocked Windows display"]
    fn native_capture_probe() {
        let mut captured_frames = 0;
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().unwrap();
            for ai in 0..8 {
                let Ok(adapter) = factory.EnumAdapters1(ai) else {
                    break;
                };
                for oi in 0..8 {
                    let Ok(output) = adapter.EnumOutputs(oi) else {
                        break;
                    };
                    let d = output.GetDesc().unwrap();
                    let rect = d.DesktopCoordinates;
                    let ad = adapter.GetDesc1().unwrap();
                    println!(
                        "adapter={ai} name={} output={oi} attached={} rect={rect:?}",
                        String::from_utf16_lossy(&ad.Description).trim_end_matches('\0'),
                        d.AttachedToDesktop.as_bool()
                    );
                    if !d.AttachedToDesktop.as_bool()
                        || rect.right <= rect.left
                        || rect.bottom <= rect.top
                    {
                        continue;
                    }
                    let r = Request {
                        binding_generation: 0,
                        id: "probe".into(),
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
                    };
                    match Capture::create(&r) {
                        Ok(mut capture) => {
                            for _ in 0..24 {
                                match capture.read(&r) {
                                    Ok(Some(c)) => {
                                        println!(
                                            "adapter={ai} output={oi} size={}x{} support={} range={:?} present={} accumulated={} protected={}",
                                            r.width,
                                            r.height,
                                            c.iter().filter(|v| **v == 1).count(),
                                            capture.pixel_range,
                                            capture.last_frame_info.LastPresentTime,
                                            capture.last_frame_info.AccumulatedFrames,
                                            capture
                                                .last_frame_info
                                                .ProtectedContentMaskedOut
                                                .as_bool()
                                        );
                                    }
                                    Ok(None) => {}
                                    Err(e) => {
                                        println!("capture error={e}");
                                        break;
                                    }
                                }
                                std::thread::sleep(Duration::from_millis(250));
                            }
                            println!(
                                "frames={} diagnostics={}",
                                capture.frames,
                                serde_json::to_string(&capture.diagnostics).unwrap()
                            );
                            captured_frames += capture.frames;
                        }
                        Err(e) => println!("create error={e}"),
                    }
                }
            }
        }
        assert!(
            captured_frames > 0,
            "No desktop frame captured; run on an unlocked Windows desktop"
        );
    }
    #[test]
    fn blank_and_textured_frames() {
        let r = Request {
            binding_generation: 0,
            id: "primary".into(),
            x: 0,
            y: 0,
            width: 64.0,
            height: 64.0,
            floor: 64.0,
            scale: 1.0,
            cell: 8.0,
            threshold: 32,
            hz: 4.0,
            geometry: false,
        };
        let mut data = vec![255; 64 * 64 * 4];
        assert!(
            extract(&data, 64, 64, 256, &r, DXGI_MODE_ROTATION_IDENTITY)
                .iter()
                .all(|v| *v == 0)
        );
        for y in 0..64 {
            for x in (0..64).step_by(4) {
                let i = (y * 64 + x) * 4;
                data[i..i + 3].fill(0);
            }
        }
        assert!(
            extract(&data, 64, 64, 256, &r, DXGI_MODE_ROTATION_IDENTITY)
                .iter()
                .any(|v| *v == 1)
        );
    }
}

#[tauri::command]
pub fn companion_benchmark_mode() -> String {
    if std::env::args().any(|a| a == "--companion-baseline") {
        "baseline".into()
    } else if std::env::args().any(|a| a == "--companion-benchmark") {
        "enabled".into()
    } else {
        "none".into()
    }
}
#[tauri::command]
pub fn companion_validation_enabled() -> bool {
    std::env::args().any(|a| a == "--companion-validation")
}
#[tauri::command]
pub fn companion_validation_report(
    app: AppHandle,
    report: serde_json::Value,
) -> Result<(), String> {
    if !companion_validation_enabled() {
        return Err("仅验证模式可写报告".into());
    }
    use windows::Win32::UI::WindowsAndMessaging::*;
    let mut windows_report = Vec::new();
    for (label, w) in app.webview_windows() {
        let hwnd = w.hwnd().map_err(|e| e.to_string())?;
        let (style, affinity, focused) = unsafe {
            let mut affinity = 0;
            let _ = GetWindowDisplayAffinity(hwnd, &mut affinity);
            (
                GetWindowLongPtrW(hwnd, GWL_EXSTYLE),
                affinity,
                GetForegroundWindow() == hwnd,
            )
        };
        windows_report.push(serde_json::json!({
            "label":label,"extendedStyle":style,
            "excludedFromCapture":affinity==WDA_EXCLUDEFROMCAPTURE.0,
            "foreground":focused,"visible":w.is_visible().unwrap_or(false),
            "topmost":style & WS_EX_TOPMOST.0 as isize != 0,
            "nonActivating":style & WS_EX_NOACTIVATE.0 as isize != 0,
            "layered":style & WS_EX_LAYERED.0 as isize != 0,
            "transparentInputStyle":style & WS_EX_TRANSPARENT.0 as isize != 0
        }));
    }
    let capture = LATEST.lock().map_err(|_| "感知锁失败")?.as_ref().map(|s| serde_json::json!({
        "valid":s.valid,"error":s.error,"width":s.width,"height":s.height,"floorY":s.floor_y,
        "geometryMode":s.request.geometry,
        // Healthy DXGI timeouts confirm an unchanged image; they are not newly captured images.
        "capturedAtMs":s.captured_at_ms,"supportedCells":s.cells.iter().filter(|v|**v==1).count(),
        "totalCells":s.cells.len(),"processingMs":s.processing_ms,"capturedFrames":s.captured_frames,
        "pixelRange":s.pixel_range,"diagnostics":s.diagnostics
    }));
    let geometry = LATEST_V2
        .lock()
        .map_err(|_| "感知锁失败")?
        .as_ref()
        .map(|(_, s)| {
            serde_json::json!({
                "schemaVersion":s.schema_version,"valid":s.valid,"revision":s.revision,
                "capturedAtMs":s.captured_at_ms,"verifiedAtMs":s.verified_at_ms,
                "platforms":s.platforms.len(),"grips":s.grips.len(),"error":s.error
            })
        });
    let output = serde_json::json!({"mode":companion_benchmark_mode(),"productionBuild":!tauri::is_dev(),"frontend":report,"windows":windows_report,"capture":capture,"geometry":geometry});
    super::storage::atomic_write(
        &super::storage::app_data_dir(&app)?.join("companion-validation.json"),
        serde_json::to_string_pretty(&output).unwrap().as_bytes(),
        false,
    )
}
