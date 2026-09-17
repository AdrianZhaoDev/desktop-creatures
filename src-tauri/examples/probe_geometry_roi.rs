//! Offline diagnosis of a user-supplied image. No screen capture and no file output.
//! Pass a temporary BGRA buffer, width, height, scale, then a physical-pixel ROI.
#[allow(dead_code)]
#[path = "../src/desktop_geometry.rs"]
mod desktop_geometry;
use desktop_geometry::{
    BgraFrame, FrameRotation, GeometryConfig, SurfaceTracker, extract_candidates,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 9 {
        return Err("usage: probe_geometry_roi BGRA WIDTH HEIGHT SCALE X1 Y1 X2 Y2".into());
    }
    let pixels = std::fs::read(&args[1])?;
    let width: usize = args[2].parse()?;
    let height: usize = args[3].parse()?;
    let scale: f64 = args[4].parse()?;
    let roi: Vec<f64> = args[5..]
        .iter()
        .map(|v| v.parse())
        .collect::<Result<_, _>>()?;
    let frame = BgraFrame {
        pixels: &pixels,
        width_px: width,
        height_px: height,
        row_pitch: width * 4,
        scale_factor: scale,
        rotation: FrameRotation::Identity,
        width_dip: width as f64 / scale,
        height_dip: height as f64 / scale,
        floor_y_dip: height as f64 / scale,
    };
    for (name, minimum) in [
        ("legacy", 32.0),
        ("current", GeometryConfig::default().vertical_min_length_dip),
    ] {
        let config = GeometryConfig {
            vertical_min_length_dip: minimum,
            ..GeometryConfig::default()
        };
        let candidates = extract_candidates(&frame, &config)?;
        let mut tracker = SurfaceTracker::new(
            "offline-fixture",
            frame.width_dip,
            frame.height_dip,
            frame.floor_y_dip,
            config,
        );
        tracker.observe_image(1, 1, 1000, candidates.clone());
        let first_count = tracker.snapshot().grips.len();
        tracker.observe_image(1, 2, 1250, candidates);
        let selected: Vec<_> = tracker.snapshot().grips.iter().filter(|g| {
            let (x, y1, y2) = (g.x * scale, g.y1 * scale, g.y2 * scale);
            x >= roi[0] && x <= roi[2] && y1 >= roi[1] && y2 <= roi[3]
        }).map(|g| serde_json::json!({"xPx":g.x*scale,"y1Px":g.y1*scale,"y2Px":g.y2*scale,"heightDip":g.y2-g.y1})).collect();
        println!(
            "{}",
            serde_json::json!({"mode":name,"minimumDip":minimum,"scale":scale,
            "firstObservationGrips":first_count,"stableRoiGrips":selected,"fullImageGripCount":tracker.snapshot().grips.len()})
        );
    }
    Ok(())
}
