//! Pure desktop-pixel geometry extraction and temporal stabilization.
//!
//! The capture worker lends a mapped BGRA frame to `extract_candidates` and
//! discards the pixels after the call. Only candidate segments and stable
//! snapshots are retained here.

use serde::Serialize;
use std::{error::Error, fmt};

const SCHEMA_VERSION: u8 = 2;
const MAX_PLATFORM_CANDIDATES: usize = 2_048;
const MAX_GRIP_CANDIDATES: usize = 1_024;
const LEGACY_VERTICAL_MIN_LENGTH_DIP: f64 = 32.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FrameRotation {
    Identity,
    Rotate90,
    Rotate180,
    Rotate270,
}

#[derive(Clone, Copy)]
pub struct BgraFrame<'a> {
    pub pixels: &'a [u8],
    pub width_px: usize,
    pub height_px: usize,
    pub row_pitch: usize,
    pub scale_factor: f64,
    pub rotation: FrameRotation,
    pub width_dip: f64,
    pub height_dip: f64,
    pub floor_y_dip: f64,
}

#[derive(Clone, Debug)]
pub struct GeometryConfig {
    pub edge_threshold: u8,
    pub horizontal_min_length_dip: f64,
    pub horizontal_merge_gap_dip: f64,
    pub text_min_ink_dip: f64,
    pub vertical_min_length_dip: f64,
    pub vertical_gap_tolerance_dip: f64,
    pub duplicate_axis_tolerance_dip: f64,
    pub match_axis_tolerance_dip: f64,
    pub match_endpoint_tolerance_dip: f64,
    pub mismatch_grace_ms: u64,
}

impl Default for GeometryConfig {
    fn default() -> Self {
        Self {
            edge_threshold: 32,
            horizontal_min_length_dip: 24.0,
            horizontal_merge_gap_dip: 8.0,
            text_min_ink_dip: 12.0,
            // Explorer-sized icons and strong glyph stems are commonly only
            // 6-12 DIP tall. Short supports have an additional continuity gate
            // in extraction so fragments cannot combine to meet this minimum.
            vertical_min_length_dip: 6.0,
            // The wider eight-DIP merge belongs to horizontal/text rows.
            // Vertical gaps remain limited to antialiasing-sized interruptions.
            vertical_gap_tolerance_dip: 2.0,
            duplicate_axis_tolerance_dip: 2.0,
            match_axis_tolerance_dip: 2.0,
            match_endpoint_tolerance_dip: 8.0,
            mismatch_grace_ms: 150,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GeometryCandidates {
    pub platforms: Vec<PlatformCandidate>,
    pub grips: Vec<GripCandidate>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SurfacePlatformSource {
    PixelEdge,
    TextRow,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SurfaceGripSource {
    PixelEdge,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlatformCandidate {
    pub source: SurfacePlatformSource,
    pub confidence: f64,
    pub x1: f64,
    pub x2: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GripCandidate {
    pub confidence: f64,
    pub x: f64,
    pub y1: f64,
    pub y2: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfacePlatformSegment {
    pub id: String,
    pub version: u64,
    pub source: SurfacePlatformSource,
    pub confidence: f64,
    pub x1: f64,
    pub x2: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceGripSegment {
    pub id: String,
    pub version: u64,
    pub source: SurfaceGripSource,
    pub confidence: f64,
    pub x: f64,
    pub y1: f64,
    pub y2: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceSnapshotV2 {
    pub schema_version: u8,
    pub display_id: String,
    pub revision: u64,
    pub captured_at_ms: u64,
    pub verified_at_ms: u64,
    pub valid: bool,
    pub width: f64,
    pub height: f64,
    pub floor_y: f64,
    pub platforms: Vec<SurfacePlatformSegment>,
    pub grips: Vec<SurfaceGripSegment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GeometryError(&'static str);

impl fmt::Display for GeometryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl Error for GeometryError {}

#[derive(Clone)]
struct PendingPlatform {
    candidate: PlatformCandidate,
    observations: u8,
}

#[derive(Clone)]
struct PendingGrip {
    candidate: GripCandidate,
    observations: u8,
}

#[derive(Clone)]
struct TrackedPlatform {
    segment: SurfacePlatformSegment,
    pending_update: Option<PendingPlatform>,
}

#[derive(Clone)]
struct TrackedGrip {
    segment: SurfaceGripSegment,
    pending_update: Option<PendingGrip>,
}

pub struct SurfaceTracker {
    config: GeometryConfig,
    snapshot: SurfaceSnapshotV2,
    session_id: Option<u64>,
    last_observation_id: Option<u64>,
    cached_candidates: Option<GeometryCandidates>,
    pending_platforms: Vec<PendingPlatform>,
    pending_grips: Vec<PendingGrip>,
    tracked_platforms: Vec<TrackedPlatform>,
    tracked_grips: Vec<TrackedGrip>,
    next_platform_id: u64,
    next_grip_id: u64,
}

impl SurfaceTracker {
    pub fn new(
        display_id: impl Into<String>,
        width: f64,
        height: f64,
        floor_y: f64,
        config: GeometryConfig,
    ) -> Self {
        Self {
            config,
            snapshot: SurfaceSnapshotV2 {
                schema_version: SCHEMA_VERSION,
                display_id: display_id.into(),
                revision: 0,
                captured_at_ms: 0,
                verified_at_ms: 0,
                valid: false,
                width,
                height,
                floor_y,
                platforms: Vec::new(),
                grips: Vec::new(),
                error: None,
            },
            session_id: None,
            last_observation_id: None,
            cached_candidates: None,
            pending_platforms: Vec::new(),
            pending_grips: Vec::new(),
            tracked_platforms: Vec::new(),
            tracked_grips: Vec::new(),
            next_platform_id: 1,
            next_grip_id: 1,
        }
    }

    pub fn snapshot(&self) -> &SurfaceSnapshotV2 {
        &self.snapshot
    }

    pub fn observe_image(
        &mut self,
        session_id: u64,
        observation_id: u64,
        captured_at_ms: u64,
        candidates: GeometryCandidates,
    ) -> &SurfaceSnapshotV2 {
        if !self.start_observation(session_id, observation_id, true) {
            return &self.snapshot;
        }
        self.snapshot.captured_at_ms = captured_at_ms;
        self.snapshot.verified_at_ms = captured_at_ms;
        self.cached_candidates = Some(candidates.clone());
        self.apply_observation(&candidates, captured_at_ms);
        self.finish_publish(true, None);
        &self.snapshot
    }

    /// Re-observe the last extracted candidates after a healthy DXGI timeout.
    /// This is a new observation of static physical content, not a replay of a
    /// WebView snapshot. It cannot cross capture sessions or precede a real image.
    pub fn observe_unchanged(
        &mut self,
        session_id: u64,
        observation_id: u64,
        verified_at_ms: u64,
    ) -> &SurfaceSnapshotV2 {
        if self.session_id != Some(session_id) || self.cached_candidates.is_none() {
            return &self.snapshot;
        }
        if !self.start_observation(session_id, observation_id, false) {
            return &self.snapshot;
        }
        let candidates = self.cached_candidates.clone().expect("checked above");
        self.snapshot.verified_at_ms = verified_at_ms;
        self.apply_observation(&candidates, verified_at_ms);
        self.finish_publish(true, None);
        &self.snapshot
    }

    /// A pointer-only DXGI event proves that the existing capture session is
    /// healthy, but it is not a second image observation. It may refresh the
    /// snapshot health clock only after a real image and never revives invalid
    /// geometry or advances temporal stabilization.
    pub fn verify_pointer_only(
        &mut self,
        session_id: u64,
        verified_at_ms: u64,
    ) -> &SurfaceSnapshotV2 {
        if self.session_id == Some(session_id)
            && self.cached_candidates.is_some()
            && self.snapshot.valid
        {
            self.snapshot.verified_at_ms = self.snapshot.verified_at_ms.max(verified_at_ms);
        }
        &self.snapshot
    }

    pub fn advance_time(&mut self, now_ms: u64) -> &SurfaceSnapshotV2 {
        let previous = self.semantic_state();
        self.tracked_platforms.retain(|tracked| {
            tracked
                .segment
                .expires_at_ms
                .is_none_or(|expires| now_ms < expires)
        });
        self.tracked_grips.retain(|tracked| {
            tracked
                .segment
                .expires_at_ms
                .is_none_or(|expires| now_ms < expires)
        });
        self.publish_from_tracks();
        self.bump_if_changed(previous);
        &self.snapshot
    }

    pub fn invalidate(&mut self, error: impl Into<String>) -> &SurfaceSnapshotV2 {
        let previous = self.semantic_state();
        self.snapshot.valid = false;
        self.snapshot.error = Some(error.into());
        self.cached_candidates = None;
        self.pending_platforms.clear();
        self.pending_grips.clear();
        self.tracked_platforms.clear();
        self.tracked_grips.clear();
        self.publish_from_tracks();
        self.bump_if_changed(previous);
        &self.snapshot
    }

    fn start_observation(&mut self, session_id: u64, observation_id: u64, has_image: bool) -> bool {
        if self.session_id != Some(session_id) {
            if !has_image {
                return false;
            }
            self.session_id = Some(session_id);
            self.last_observation_id = None;
            self.cached_candidates = None;
            self.pending_platforms.clear();
            self.pending_grips.clear();
            self.tracked_platforms.clear();
            self.tracked_grips.clear();
        }
        if self
            .last_observation_id
            .is_some_and(|last| observation_id <= last)
        {
            return false;
        }
        self.last_observation_id = Some(observation_id);
        true
    }

    fn apply_observation(&mut self, candidates: &GeometryCandidates, at_ms: u64) {
        self.update_confirmed_platforms(&candidates.platforms, at_ms);
        self.update_confirmed_grips(&candidates.grips, at_ms);
    }

    fn update_confirmed_platforms(&mut self, candidates: &[PlatformCandidate], at_ms: u64) {
        let mut used = vec![false; candidates.len()];
        for tracked in &mut self.tracked_platforms {
            let best = candidates
                .iter()
                .enumerate()
                .filter(|(index, candidate)| {
                    !used[*index]
                        && platform_matches_segment(candidate, &tracked.segment, &self.config)
                })
                .min_by(|(_, a), (_, b)| {
                    platform_distance_to_segment(a, &tracked.segment)
                        .total_cmp(&platform_distance_to_segment(b, &tracked.segment))
                });
            if let Some((index, candidate)) = best {
                used[index] = true;
                tracked.segment.expires_at_ms = None;
                update_platform_if_stable(tracked, candidate, &self.config);
            } else if tracked.segment.expires_at_ms.is_none() {
                tracked.segment.expires_at_ms =
                    Some(at_ms.saturating_add(self.config.mismatch_grace_ms));
                tracked.pending_update = None;
            }
        }

        let unmatched: Vec<_> = candidates
            .iter()
            .enumerate()
            .filter(|(index, _)| !used[*index])
            .map(|(_, candidate)| candidate.clone())
            .collect();
        let previous_pending = std::mem::take(&mut self.pending_platforms);
        let mut used_pending = vec![false; previous_pending.len()];
        let mut next_pending = Vec::new();
        for candidate in unmatched {
            let matched = previous_pending
                .iter()
                .enumerate()
                .filter(|(index, pending)| {
                    !used_pending[*index]
                        && platform_candidates_match(&pending.candidate, &candidate, &self.config)
                })
                .min_by(|(_, a), (_, b)| {
                    platform_candidate_distance(&a.candidate, &candidate)
                        .total_cmp(&platform_candidate_distance(&b.candidate, &candidate))
                });
            if let Some((pending_index, previous)) = matched {
                used_pending[pending_index] = true;
                if previous.observations + 1 >= 2 {
                    self.tracked_platforms.push(TrackedPlatform {
                        segment: SurfacePlatformSegment {
                            id: format!(
                                "p-{}-{}",
                                self.session_id.expect("image observation has a session"),
                                self.next_platform_id
                            ),
                            version: 1,
                            source: candidate.source,
                            confidence: candidate.confidence,
                            x1: candidate.x1,
                            x2: candidate.x2,
                            y: candidate.y,
                            expires_at_ms: None,
                        },
                        pending_update: None,
                    });
                    self.next_platform_id += 1;
                } else {
                    next_pending.push(PendingPlatform {
                        candidate,
                        observations: previous.observations + 1,
                    });
                }
            } else {
                next_pending.push(PendingPlatform {
                    candidate,
                    observations: 1,
                });
            }
        }
        self.pending_platforms = next_pending;
    }

    fn update_confirmed_grips(&mut self, candidates: &[GripCandidate], at_ms: u64) {
        let mut used = vec![false; candidates.len()];
        for tracked in &mut self.tracked_grips {
            let best = candidates
                .iter()
                .enumerate()
                .filter(|(index, candidate)| {
                    !used[*index] && grip_matches_segment(candidate, &tracked.segment, &self.config)
                })
                .min_by(|(_, a), (_, b)| {
                    grip_distance_to_segment(a, &tracked.segment)
                        .total_cmp(&grip_distance_to_segment(b, &tracked.segment))
                });
            if let Some((index, candidate)) = best {
                used[index] = true;
                tracked.segment.expires_at_ms = None;
                update_grip_if_stable(tracked, candidate, &self.config);
            } else if tracked.segment.expires_at_ms.is_none() {
                tracked.segment.expires_at_ms =
                    Some(at_ms.saturating_add(self.config.mismatch_grace_ms));
                tracked.pending_update = None;
            }
        }

        let unmatched: Vec<_> = candidates
            .iter()
            .enumerate()
            .filter(|(index, _)| !used[*index])
            .map(|(_, candidate)| candidate.clone())
            .collect();
        let previous_pending = std::mem::take(&mut self.pending_grips);
        let mut used_pending = vec![false; previous_pending.len()];
        let mut next_pending = Vec::new();
        for candidate in unmatched {
            let matched = previous_pending
                .iter()
                .enumerate()
                .filter(|(index, pending)| {
                    !used_pending[*index]
                        && grip_candidates_match(&pending.candidate, &candidate, &self.config)
                })
                .min_by(|(_, a), (_, b)| {
                    grip_candidate_distance(&a.candidate, &candidate)
                        .total_cmp(&grip_candidate_distance(&b.candidate, &candidate))
                });
            if let Some((pending_index, previous)) = matched {
                used_pending[pending_index] = true;
                if previous.observations + 1 >= 2 {
                    self.tracked_grips.push(TrackedGrip {
                        segment: SurfaceGripSegment {
                            id: format!(
                                "g-{}-{}",
                                self.session_id.expect("image observation has a session"),
                                self.next_grip_id
                            ),
                            version: 1,
                            source: SurfaceGripSource::PixelEdge,
                            confidence: candidate.confidence,
                            x: candidate.x,
                            y1: candidate.y1,
                            y2: candidate.y2,
                            expires_at_ms: None,
                        },
                        pending_update: None,
                    });
                    self.next_grip_id += 1;
                } else {
                    next_pending.push(PendingGrip {
                        candidate,
                        observations: previous.observations + 1,
                    });
                }
            } else {
                next_pending.push(PendingGrip {
                    candidate,
                    observations: 1,
                });
            }
        }
        self.pending_grips = next_pending;
    }

    fn finish_publish(&mut self, valid: bool, error: Option<String>) {
        let previous = self.semantic_state();
        self.snapshot.valid = valid;
        self.snapshot.error = error;
        self.publish_from_tracks();
        self.bump_if_changed(previous);
    }

    fn publish_from_tracks(&mut self) {
        self.snapshot.platforms = self
            .tracked_platforms
            .iter()
            .map(|tracked| tracked.segment.clone())
            .collect();
        self.snapshot.grips = self
            .tracked_grips
            .iter()
            .map(|tracked| tracked.segment.clone())
            .collect();
        self.snapshot.platforms.sort_by(|a, b| {
            a.y.total_cmp(&b.y)
                .then_with(|| a.x1.total_cmp(&b.x1))
                .then_with(|| a.id.cmp(&b.id))
        });
        self.snapshot.grips.sort_by(|a, b| {
            a.x.total_cmp(&b.x)
                .then_with(|| a.y1.total_cmp(&b.y1))
                .then_with(|| a.id.cmp(&b.id))
        });
    }

    fn semantic_state(&self) -> SemanticState {
        SemanticState {
            display_id: self.snapshot.display_id.clone(),
            valid: self.snapshot.valid,
            width: self.snapshot.width,
            height: self.snapshot.height,
            floor_y: self.snapshot.floor_y,
            platforms: self.snapshot.platforms.clone(),
            grips: self.snapshot.grips.clone(),
            error: self.snapshot.error.clone(),
        }
    }

    fn bump_if_changed(&mut self, previous: SemanticState) {
        if previous != self.semantic_state() {
            self.snapshot.revision += 1;
        }
    }
}

#[derive(PartialEq)]
struct SemanticState {
    display_id: String,
    valid: bool,
    width: f64,
    height: f64,
    floor_y: f64,
    platforms: Vec<SurfacePlatformSegment>,
    grips: Vec<SurfaceGripSegment>,
    error: Option<String>,
}

#[derive(Clone)]
struct Run {
    start: usize,
    end: usize,
    ink: usize,
    strength_sum: usize,
    fragments: usize,
    longest_fragment: usize,
}

pub fn extract_candidates(
    frame: &BgraFrame<'_>,
    config: &GeometryConfig,
) -> Result<GeometryCandidates, GeometryError> {
    validate_frame(frame, config)?;
    let (width, height) = logical_dimensions(frame);
    let mut horizontal = vec![0u8; width * height];
    let mut vertical = vec![0u8; width * height];
    let threshold = u16::from(config.edge_threshold);

    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let gx = channel_distance(sample(frame, x - 1, y), sample(frame, x + 1, y));
            let gy = channel_distance(sample(frame, x, y - 1), sample(frame, x, y + 1));
            let index = y * width + x;
            if gy >= threshold && u32::from(gy) * 4 >= u32::from(gx) * 5 {
                horizontal[index] = gy.min(255) as u8;
            }
            if gx >= threshold && u32::from(gx) * 4 >= u32::from(gy) * 6 {
                vertical[index] = gx.min(255) as u8;
            }
        }
    }

    let scale = frame.scale_factor;
    let horizontal_gap_px = dip_to_px(config.horizontal_merge_gap_dip, scale);
    let mut platforms = Vec::new();
    for y in 1..height.saturating_sub(1) {
        let runs = merged_runs(&horizontal[y * width..(y + 1) * width], horizontal_gap_px);
        for run in runs {
            // The centered two-sided gradient loses one pixel at each visible
            // endpoint. Restore those endpoints before applying DIP limits.
            let support_start = run.start.saturating_sub(1);
            let support_end = (run.end + 1).min(width);
            let support_span = support_end - support_start;
            let support_ink = (run.ink + 2).min(support_span);
            let span_dip = support_span as f64 / scale;
            let ink_dip = support_ink as f64 / scale;
            let longest_dip = (run.longest_fragment + 2) as f64 / scale;
            if span_dip + f64::EPSILON < config.horizontal_min_length_dip
                || ink_dip + f64::EPSILON < config.text_min_ink_dip
            {
                continue;
            }
            let density = support_ink as f64 / support_span.max(1) as f64;
            let strength = run.strength_sum as f64 / run.ink.max(1) as f64 / 255.0;
            let source = if longest_dip + f64::EPSILON >= config.horizontal_min_length_dip
                || density >= 0.68
            {
                SurfacePlatformSource::PixelEdge
            } else if run.fragments >= 3 && density >= 0.20 && density <= 0.82 {
                SurfacePlatformSource::TextRow
            } else {
                continue;
            };
            let confidence = match source {
                SurfacePlatformSource::PixelEdge => 0.50 + density * 0.30 + strength * 0.20,
                SurfacePlatformSource::TextRow => 0.30 + density * 0.30 + strength * 0.20 + 0.10,
            };
            let candidate = PlatformCandidate {
                source,
                confidence: quantize_confidence(confidence),
                x1: quantize_dip(support_start as f64 / scale),
                x2: quantize_dip(support_end as f64 / scale),
                y: quantize_dip(y as f64 / scale),
            };
            if (candidate.y - frame.floor_y_dip).abs() > config.duplicate_axis_tolerance_dip {
                platforms.push(candidate);
            }
        }
    }
    collapse_platform_edges(&mut platforms, config.duplicate_axis_tolerance_dip);
    bound_platform_candidates(&mut platforms);

    let vertical_gap_px = dip_to_px(config.vertical_gap_tolerance_dip, scale);
    let mut grips = Vec::new();
    let mut column = vec![0u8; height];
    for x in 1..width.saturating_sub(1) {
        for y in 0..height {
            column[y] = vertical[y * width + x];
        }
        for run in merged_runs(&column, vertical_gap_px) {
            let support_start = run.start.saturating_sub(1);
            let support_end = (run.end + 1).min(height);
            let support_span = support_end - support_start;
            let support_ink = (run.ink + 2).min(support_span);
            let density = support_ink as f64 / support_span.max(1) as f64;
            if !vertical_run_meets_minimum(
                &run,
                support_span,
                support_ink,
                scale,
                config.vertical_min_length_dip,
            ) {
                continue;
            }
            let strength = run.strength_sum as f64 / run.ink.max(1) as f64 / 255.0;
            grips.push(GripCandidate {
                confidence: quantize_confidence(0.50 + density * 0.30 + strength * 0.20),
                x: quantize_dip(x as f64 / scale),
                y1: quantize_dip(support_start as f64 / scale),
                y2: quantize_dip(support_end as f64 / scale),
            });
        }
    }
    collapse_grip_edges(&mut grips, config.duplicate_axis_tolerance_dip);
    bound_grip_candidates(&mut grips);

    Ok(GeometryCandidates { platforms, grips })
}

fn vertical_run_meets_minimum(
    run: &Run,
    support_span: usize,
    support_ink: usize,
    scale: f64,
    minimum_dip: f64,
) -> bool {
    let span_dip = support_span as f64 / scale;
    let ink_dip = support_ink as f64 / scale;
    let longest_dip = (run.longest_fragment + 2).min(support_span) as f64 / scale;
    let density = support_ink as f64 / support_span.max(1) as f64;

    if span_dip + f64::EPSILON < minimum_dip || density < 0.80 {
        return false;
    }
    if span_dip + f64::EPSILON >= LEGACY_VERTICAL_MIN_LENGTH_DIP {
        return ink_dip + f64::EPSILON >= minimum_dip.max(LEGACY_VERTICAL_MIN_LENGTH_DIP);
    }

    ink_dip + f64::EPSILON >= minimum_dip
        && longest_dip + f64::EPSILON >= minimum_dip
        && longest_dip / span_dip.max(f64::EPSILON) >= 0.80
}

fn validate_frame(frame: &BgraFrame<'_>, config: &GeometryConfig) -> Result<(), GeometryError> {
    if frame.width_px < 3 || frame.height_px < 3 {
        return Err(GeometryError("desktop frame is too small"));
    }
    if !frame.scale_factor.is_finite() || frame.scale_factor <= 0.0 {
        return Err(GeometryError("invalid display scale factor"));
    }
    if frame.row_pitch < frame.width_px.saturating_mul(4)
        || frame.pixels.len() < frame.row_pitch.saturating_mul(frame.height_px)
    {
        return Err(GeometryError("BGRA buffer is shorter than its dimensions"));
    }
    let (logical_width, logical_height) = logical_dimensions(frame);
    if !frame.width_dip.is_finite()
        || !frame.height_dip.is_finite()
        || !frame.floor_y_dip.is_finite()
        || frame.width_dip <= 0.0
        || frame.height_dip <= 0.0
        || (logical_width as f64 / frame.scale_factor - frame.width_dip).abs() > 1.5
        || (logical_height as f64 / frame.scale_factor - frame.height_dip).abs() > 1.5
    {
        return Err(GeometryError(
            "desktop frame pixels do not match its DIP dimensions",
        ));
    }
    if config.edge_threshold == 0
        || config.horizontal_min_length_dip <= 0.0
        || config.vertical_min_length_dip <= 0.0
        || config.horizontal_merge_gap_dip < 0.0
        || config.vertical_gap_tolerance_dip < 0.0
    {
        return Err(GeometryError("invalid desktop geometry configuration"));
    }
    Ok(())
}

fn logical_dimensions(frame: &BgraFrame<'_>) -> (usize, usize) {
    match frame.rotation {
        FrameRotation::Rotate90 | FrameRotation::Rotate270 => (frame.height_px, frame.width_px),
        FrameRotation::Identity | FrameRotation::Rotate180 => (frame.width_px, frame.height_px),
    }
}

fn sample(frame: &BgraFrame<'_>, logical_x: usize, logical_y: usize) -> [u8; 3] {
    let (x, y) = match frame.rotation {
        FrameRotation::Identity => (logical_x, logical_y),
        FrameRotation::Rotate90 => (logical_y, frame.height_px.saturating_sub(logical_x + 1)),
        FrameRotation::Rotate180 => (
            frame.width_px.saturating_sub(logical_x + 1),
            frame.height_px.saturating_sub(logical_y + 1),
        ),
        FrameRotation::Rotate270 => (frame.width_px.saturating_sub(logical_y + 1), logical_x),
    };
    let index = y * frame.row_pitch + x * 4;
    [
        frame.pixels[index],
        frame.pixels[index + 1],
        frame.pixels[index + 2],
    ]
}

fn channel_distance(a: [u8; 3], b: [u8; 3]) -> u16 {
    a.into_iter()
        .zip(b)
        .map(|(left, right)| u16::from(left.abs_diff(right)))
        .max()
        .unwrap_or(0)
}

fn merged_runs(values: &[u8], max_gap: usize) -> Vec<Run> {
    let fragments = raw_runs(values);
    let mut merged: Vec<Run> = Vec::new();
    for fragment in fragments {
        if let Some(last) = merged.last_mut() {
            if fragment.start.saturating_sub(last.end) <= max_gap {
                last.end = fragment.end;
                last.ink += fragment.ink;
                last.strength_sum += fragment.strength_sum;
                last.fragments += 1;
                last.longest_fragment = last.longest_fragment.max(fragment.longest_fragment);
                continue;
            }
        }
        merged.push(fragment);
    }
    merged
}

fn raw_runs(values: &[u8]) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut index = 0;
    while index < values.len() {
        if values[index] == 0 {
            index += 1;
            continue;
        }
        let start = index;
        let mut strength_sum = 0;
        while index < values.len() && values[index] != 0 {
            strength_sum += usize::from(values[index]);
            index += 1;
        }
        let length = index - start;
        runs.push(Run {
            start,
            end: index,
            ink: length,
            strength_sum,
            fragments: 1,
            longest_fragment: length,
        });
    }
    runs
}

fn collapse_platform_edges(candidates: &mut Vec<PlatformCandidate>, axis_tolerance: f64) {
    candidates.sort_by(|a, b| {
        a.y.total_cmp(&b.y)
            .then_with(|| a.x1.total_cmp(&b.x1))
            .then_with(|| b.confidence.total_cmp(&a.confidence))
    });
    let mut collapsed: Vec<PlatformCandidate> = Vec::new();
    for candidate in candidates.drain(..) {
        let mut duplicate = None;
        for index in (0..collapsed.len()).rev() {
            let existing = &collapsed[index];
            if candidate.y - existing.y > axis_tolerance {
                break;
            }
            if (existing.y - candidate.y).abs() <= axis_tolerance
                && interval_overlap(existing.x1, existing.x2, candidate.x1, candidate.x2) >= 6.0
            {
                duplicate = Some(index);
                break;
            }
        }
        if let Some(index) = duplicate {
            if candidate.confidence > collapsed[index].confidence {
                collapsed[index] = candidate;
            }
        } else {
            collapsed.push(candidate);
        }
    }
    *candidates = collapsed;
}

fn collapse_grip_edges(candidates: &mut Vec<GripCandidate>, axis_tolerance: f64) {
    candidates.sort_by(|a, b| {
        a.x.total_cmp(&b.x)
            .then_with(|| a.y1.total_cmp(&b.y1))
            .then_with(|| b.confidence.total_cmp(&a.confidence))
    });
    let mut collapsed: Vec<GripCandidate> = Vec::new();
    for candidate in candidates.drain(..) {
        let mut duplicate = None;
        for index in (0..collapsed.len()).rev() {
            let existing = &collapsed[index];
            if candidate.x - existing.x > axis_tolerance {
                break;
            }
            if (existing.x - candidate.x).abs() <= axis_tolerance
                && grip_intervals_are_duplicates(
                    existing.y1,
                    existing.y2,
                    candidate.y1,
                    candidate.y2,
                )
            {
                duplicate = Some(index);
                break;
            }
        }
        if let Some(index) = duplicate {
            if candidate.confidence > collapsed[index].confidence {
                collapsed[index] = candidate;
            }
        } else {
            collapsed.push(candidate);
        }
    }
    *candidates = collapsed;
}

fn bound_platform_candidates(candidates: &mut Vec<PlatformCandidate>) {
    if candidates.len() <= MAX_PLATFORM_CANDIDATES {
        return;
    }
    candidates.sort_by(|a, b| {
        b.confidence
            .total_cmp(&a.confidence)
            .then_with(|| (b.x2 - b.x1).total_cmp(&(a.x2 - a.x1)))
            .then_with(|| a.y.total_cmp(&b.y))
            .then_with(|| a.x1.total_cmp(&b.x1))
    });
    candidates.truncate(MAX_PLATFORM_CANDIDATES);
    candidates.sort_by(|a, b| a.y.total_cmp(&b.y).then_with(|| a.x1.total_cmp(&b.x1)));
}

fn bound_grip_candidates(candidates: &mut Vec<GripCandidate>) {
    if candidates.len() <= MAX_GRIP_CANDIDATES {
        return;
    }
    candidates.sort_by(|a, b| {
        b.confidence
            .total_cmp(&a.confidence)
            .then_with(|| (b.y2 - b.y1).total_cmp(&(a.y2 - a.y1)))
            .then_with(|| a.x.total_cmp(&b.x))
            .then_with(|| a.y1.total_cmp(&b.y1))
    });
    candidates.truncate(MAX_GRIP_CANDIDATES);
    candidates.sort_by(|a, b| a.x.total_cmp(&b.x).then_with(|| a.y1.total_cmp(&b.y1)));
}

fn platform_candidates_match(
    a: &PlatformCandidate,
    b: &PlatformCandidate,
    config: &GeometryConfig,
) -> bool {
    (a.y - b.y).abs() <= config.match_axis_tolerance_dip
        && intervals_match(a.x1, a.x2, b.x1, b.x2, config.match_endpoint_tolerance_dip)
}

fn platform_matches_segment(
    candidate: &PlatformCandidate,
    segment: &SurfacePlatformSegment,
    config: &GeometryConfig,
) -> bool {
    (candidate.y - segment.y).abs() <= config.match_axis_tolerance_dip
        && intervals_match(
            candidate.x1,
            candidate.x2,
            segment.x1,
            segment.x2,
            config.match_endpoint_tolerance_dip,
        )
}

fn grip_candidates_match(a: &GripCandidate, b: &GripCandidate, config: &GeometryConfig) -> bool {
    (a.x - b.x).abs() <= config.match_axis_tolerance_dip
        && grip_intervals_match(a.y1, a.y2, b.y1, b.y2, config.match_endpoint_tolerance_dip)
}

fn grip_matches_segment(
    candidate: &GripCandidate,
    segment: &SurfaceGripSegment,
    config: &GeometryConfig,
) -> bool {
    (candidate.x - segment.x).abs() <= config.match_axis_tolerance_dip
        && grip_intervals_match(
            candidate.y1,
            candidate.y2,
            segment.y1,
            segment.y2,
            config.match_endpoint_tolerance_dip,
        )
}

fn grip_intervals_are_duplicates(a1: f64, a2: f64, b1: f64, b2: f64) -> bool {
    let shorter_length = (a2 - a1).min(b2 - b1).max(0.0);
    let required_overlap = if shorter_length + f64::EPSILON < LEGACY_VERTICAL_MIN_LENGTH_DIP {
        shorter_length * 0.75
    } else {
        8.0
    };
    interval_overlap(a1, a2, b1, b2) + f64::EPSILON >= required_overlap
}

fn grip_intervals_match(a1: f64, a2: f64, b1: f64, b2: f64, endpoint_tolerance: f64) -> bool {
    let shorter_length = (a2 - a1).min(b2 - b1).max(0.0);
    if shorter_length + f64::EPSILON >= LEGACY_VERTICAL_MIN_LENGTH_DIP {
        return intervals_match(a1, a2, b1, b2, endpoint_tolerance);
    }

    interval_overlap(a1, a2, b1, b2) + f64::EPSILON >= shorter_length * 0.75
        || (a1 - b1).abs() <= endpoint_tolerance.min(2.0)
        || (a2 - b2).abs() <= endpoint_tolerance.min(2.0)
}

fn intervals_match(a1: f64, a2: f64, b1: f64, b2: f64, tolerance: f64) -> bool {
    interval_overlap(a1, a2, b1, b2) >= 6.0
        || (a1 - b1).abs() <= tolerance
        || (a2 - b2).abs() <= tolerance
}

fn interval_overlap(a1: f64, a2: f64, b1: f64, b2: f64) -> f64 {
    a2.min(b2) - a1.max(b1).min(a2.min(b2))
}

fn platform_distance_to_segment(
    candidate: &PlatformCandidate,
    segment: &SurfacePlatformSegment,
) -> f64 {
    (candidate.y - segment.y).abs()
        + (candidate.x1 - segment.x1).abs() * 0.1
        + (candidate.x2 - segment.x2).abs() * 0.1
}

fn platform_candidate_distance(a: &PlatformCandidate, b: &PlatformCandidate) -> f64 {
    (a.y - b.y).abs() + (a.x1 - b.x1).abs() * 0.1 + (a.x2 - b.x2).abs() * 0.1
}

fn grip_distance_to_segment(candidate: &GripCandidate, segment: &SurfaceGripSegment) -> f64 {
    (candidate.x - segment.x).abs()
        + (candidate.y1 - segment.y1).abs() * 0.1
        + (candidate.y2 - segment.y2).abs() * 0.1
}

fn grip_candidate_distance(a: &GripCandidate, b: &GripCandidate) -> f64 {
    (a.x - b.x).abs() + (a.y1 - b.y1).abs() * 0.1 + (a.y2 - b.y2).abs() * 0.1
}

fn update_platform_if_stable(
    tracked: &mut TrackedPlatform,
    candidate: &PlatformCandidate,
    config: &GeometryConfig,
) {
    if !platform_materially_changed(&tracked.segment, candidate) {
        tracked.pending_update = None;
        return;
    }
    match &mut tracked.pending_update {
        Some(pending)
            if platform_candidates_match(&pending.candidate, candidate, config)
                && platform_candidate_close(&pending.candidate, candidate) =>
        {
            pending.observations += 1;
            pending.candidate = candidate.clone();
            if pending.observations >= 2 {
                tracked.segment.version += 1;
                tracked.segment.source = candidate.source;
                tracked.segment.confidence = candidate.confidence;
                tracked.segment.x1 = candidate.x1;
                tracked.segment.x2 = candidate.x2;
                tracked.segment.y = candidate.y;
                tracked.pending_update = None;
            }
        }
        _ => {
            tracked.pending_update = Some(PendingPlatform {
                candidate: candidate.clone(),
                observations: 1,
            });
        }
    }
}

fn update_grip_if_stable(
    tracked: &mut TrackedGrip,
    candidate: &GripCandidate,
    config: &GeometryConfig,
) {
    if !grip_materially_changed(&tracked.segment, candidate) {
        tracked.pending_update = None;
        return;
    }
    match &mut tracked.pending_update {
        Some(pending)
            if grip_candidates_match(&pending.candidate, candidate, config)
                && grip_candidate_close(&pending.candidate, candidate) =>
        {
            pending.observations += 1;
            pending.candidate = candidate.clone();
            if pending.observations >= 2 {
                tracked.segment.version += 1;
                tracked.segment.confidence = candidate.confidence;
                tracked.segment.x = candidate.x;
                tracked.segment.y1 = candidate.y1;
                tracked.segment.y2 = candidate.y2;
                tracked.pending_update = None;
            }
        }
        _ => {
            tracked.pending_update = Some(PendingGrip {
                candidate: candidate.clone(),
                observations: 1,
            });
        }
    }
}

fn platform_materially_changed(
    segment: &SurfacePlatformSegment,
    candidate: &PlatformCandidate,
) -> bool {
    segment.source != candidate.source
        || (segment.y - candidate.y).abs() > 1.0
        || (segment.x1 - candidate.x1).abs() > 2.0
        || (segment.x2 - candidate.x2).abs() > 2.0
        || (segment.confidence - candidate.confidence).abs() > 0.15
}

fn grip_materially_changed(segment: &SurfaceGripSegment, candidate: &GripCandidate) -> bool {
    (segment.x - candidate.x).abs() > 1.0
        || (segment.y1 - candidate.y1).abs() > 2.0
        || (segment.y2 - candidate.y2).abs() > 2.0
        || (segment.confidence - candidate.confidence).abs() > 0.15
}

fn platform_candidate_close(a: &PlatformCandidate, b: &PlatformCandidate) -> bool {
    a.source == b.source
        && (a.y - b.y).abs() <= 1.0
        && (a.x1 - b.x1).abs() <= 2.0
        && (a.x2 - b.x2).abs() <= 2.0
}

fn grip_candidate_close(a: &GripCandidate, b: &GripCandidate) -> bool {
    (a.x - b.x).abs() <= 1.0 && (a.y1 - b.y1).abs() <= 2.0 && (a.y2 - b.y2).abs() <= 2.0
}

fn dip_to_px(dip: f64, scale: f64) -> usize {
    (dip * scale).round().max(0.0) as usize
}

fn quantize_dip(value: f64) -> f64 {
    (value * 2.0).round() / 2.0
}

fn quantize_confidence(value: f64) -> f64 {
    (value.clamp(0.0, 1.0) * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn platform(x1: f64, x2: f64, y: f64) -> PlatformCandidate {
        PlatformCandidate {
            source: SurfacePlatformSource::PixelEdge,
            confidence: 0.9,
            x1,
            x2,
            y,
        }
    }

    fn grip(x: f64, y1: f64, y2: f64) -> GripCandidate {
        GripCandidate {
            confidence: 0.85,
            x,
            y1,
            y2,
        }
    }

    fn candidates(
        platforms: Vec<PlatformCandidate>,
        grips: Vec<GripCandidate>,
    ) -> GeometryCandidates {
        GeometryCandidates { platforms, grips }
    }

    fn legacy_vertical_config() -> GeometryConfig {
        GeometryConfig {
            vertical_min_length_dip: LEGACY_VERTICAL_MIN_LENGTH_DIP,
            ..GeometryConfig::default()
        }
    }

    #[test]
    fn requires_two_distinct_observations_but_accepts_healthy_static_recheck() {
        let mut tracker = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        tracker.observe_image(
            4,
            10,
            1_000,
            candidates(vec![platform(10.0, 80.0, 100.0)], vec![]),
        );
        assert!(tracker.snapshot().platforms.is_empty());
        let revision = tracker.snapshot().revision;

        tracker.observe_image(
            4,
            10,
            1_100,
            candidates(vec![platform(10.0, 80.0, 100.0)], vec![]),
        );
        assert!(tracker.snapshot().platforms.is_empty());
        assert_eq!(tracker.snapshot().revision, revision);

        tracker.observe_unchanged(4, 11, 1_250);
        assert_eq!(tracker.snapshot().platforms.len(), 1);
        assert_eq!(tracker.snapshot().captured_at_ms, 1_000);
        assert_eq!(tracker.snapshot().verified_at_ms, 1_250);
    }

    #[test]
    fn short_grips_still_require_two_distinct_observations() {
        let mut tracker = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        let set = candidates(vec![], vec![grip(40.0, 20.0, 28.0)]);

        tracker.observe_image(4, 10, 1_000, set.clone());
        assert!(tracker.snapshot().grips.is_empty());

        tracker.observe_image(4, 11, 1_100, set);
        assert_eq!(tracker.snapshot().grips.len(), 1);
        assert_eq!(
            tracker.snapshot().grips[0].y2 - tracker.snapshot().grips[0].y1,
            8.0
        );
    }

    #[test]
    fn a_short_grip_moved_by_eight_dip_gets_a_new_identity() {
        let mut tracker = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        let original = candidates(vec![], vec![grip(40.0, 20.0, 26.0)]);
        tracker.observe_image(7, 1, 100, original.clone());
        tracker.observe_image(7, 2, 200, original);
        let original_id = tracker.snapshot().grips[0].id.clone();

        let moved = candidates(vec![], vec![grip(40.0, 28.0, 34.0)]);
        tracker.observe_image(7, 3, 300, moved.clone());
        assert_eq!(tracker.snapshot().grips.len(), 1);
        assert_eq!(tracker.snapshot().grips[0].id, original_id);
        assert_eq!(tracker.snapshot().grips[0].expires_at_ms, Some(450));

        tracker.observe_image(7, 4, 400, moved);
        assert_eq!(tracker.snapshot().grips.len(), 2);
        let moved_segment = tracker
            .snapshot()
            .grips
            .iter()
            .find(|segment| segment.y1 == 28.0)
            .unwrap();
        assert_ne!(moved_segment.id, original_id);
    }

    #[test]
    fn expires_mismatched_support_at_the_absolute_150ms_deadline() {
        let mut tracker = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        let set = candidates(
            vec![platform(10.0, 80.0, 100.0)],
            vec![grip(40.0, 20.0, 80.0)],
        );
        tracker.observe_image(1, 1, 100, set.clone());
        tracker.observe_image(1, 2, 200, set);
        tracker.observe_image(1, 3, 300, candidates(vec![], vec![]));
        assert_eq!(tracker.snapshot().platforms[0].expires_at_ms, Some(450));
        assert_eq!(tracker.snapshot().grips[0].expires_at_ms, Some(450));
        tracker.advance_time(449);
        assert_eq!(tracker.snapshot().platforms.len(), 1);
        tracker.advance_time(450);
        assert!(tracker.snapshot().platforms.is_empty());
        assert!(tracker.snapshot().grips.is_empty());
    }

    #[test]
    fn a_support_that_returns_during_grace_keeps_its_id_and_version() {
        let mut tracker = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        let set = candidates(vec![platform(10.0, 80.0, 100.0)], vec![]);
        tracker.observe_image(1, 1, 100, set.clone());
        tracker.observe_image(1, 2, 200, set.clone());
        let original = tracker.snapshot().platforms[0].clone();
        tracker.observe_image(1, 3, 300, candidates(vec![], vec![]));
        tracker.observe_image(1, 4, 400, set);
        let restored = &tracker.snapshot().platforms[0];
        assert_eq!(restored.id, original.id);
        assert_eq!(restored.version, original.version);
        assert_eq!(restored.expires_at_ms, None);
    }

    #[test]
    fn scrolling_does_not_relabel_a_distant_line_as_the_old_support() {
        let mut tracker = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        let old = candidates(vec![platform(10.0, 80.0, 100.0)], vec![]);
        tracker.observe_image(1, 1, 100, old.clone());
        tracker.observe_image(1, 2, 200, old);
        let old_id = tracker.snapshot().platforms[0].id.clone();
        let moved = candidates(vec![platform(10.0, 80.0, 140.0)], vec![]);
        tracker.observe_image(1, 3, 300, moved.clone());
        assert_eq!(tracker.snapshot().platforms.len(), 1);
        assert_eq!(tracker.snapshot().platforms[0].id, old_id);
        assert!(tracker.snapshot().platforms[0].expires_at_ms.is_some());
        tracker.observe_image(1, 4, 400, moved);
        assert_eq!(tracker.snapshot().platforms.len(), 2);
        let new_id = tracker
            .snapshot()
            .platforms
            .iter()
            .find(|segment| segment.y == 140.0)
            .unwrap()
            .id
            .clone();
        assert_ne!(new_id, old_id);
        tracker.advance_time(450);
        assert_eq!(tracker.snapshot().platforms.len(), 1);
        assert_eq!(tracker.snapshot().platforms[0].id, new_id);
    }

    #[test]
    fn timestamps_do_not_churn_revision_when_geometry_is_unchanged() {
        let mut tracker = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        let set = candidates(vec![platform(10.0, 80.0, 100.0)], vec![]);
        tracker.observe_image(1, 1, 100, set.clone());
        tracker.observe_image(1, 2, 200, set);
        let revision = tracker.snapshot().revision;
        tracker.observe_unchanged(1, 3, 300);
        assert_eq!(tracker.snapshot().revision, revision);
        assert_eq!(tracker.snapshot().verified_at_ms, 300);
    }

    #[test]
    fn sustained_material_change_increments_segment_version_once() {
        let mut tracker = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        let original = candidates(vec![platform(10.0, 80.0, 100.0)], vec![]);
        tracker.observe_image(1, 1, 100, original.clone());
        tracker.observe_image(1, 2, 200, original);
        let id = tracker.snapshot().platforms[0].id.clone();
        let revision = tracker.snapshot().revision;
        let extended = candidates(vec![platform(10.0, 84.0, 100.0)], vec![]);
        tracker.observe_image(1, 3, 300, extended.clone());
        assert_eq!(tracker.snapshot().platforms[0].version, 1);
        assert_eq!(tracker.snapshot().revision, revision);
        tracker.observe_image(1, 4, 400, extended.clone());
        assert_eq!(tracker.snapshot().platforms[0].id, id);
        assert_eq!(tracker.snapshot().platforms[0].version, 2);
        let changed_revision = tracker.snapshot().revision;
        tracker.observe_image(1, 5, 500, extended);
        assert_eq!(tracker.snapshot().platforms[0].version, 2);
        assert_eq!(tracker.snapshot().revision, changed_revision);
    }

    #[test]
    fn separate_trackers_use_capture_session_in_segment_ids() {
        let set = candidates(
            vec![platform(10.0, 80.0, 100.0)],
            vec![grip(40.0, 20.0, 80.0)],
        );
        let mut first = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        first.observe_image(41, 1, 100, set.clone());
        first.observe_image(41, 2, 200, set.clone());

        let mut second = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        second.observe_image(42, 1, 300, set.clone());
        second.observe_image(42, 2, 400, set);

        assert_eq!(first.snapshot().platforms[0].id, "p-41-1");
        assert_eq!(first.snapshot().grips[0].id, "g-41-1");
        assert_eq!(second.snapshot().platforms[0].id, "p-42-1");
        assert_eq!(second.snapshot().grips[0].id, "g-42-1");
        assert_ne!(
            first.snapshot().platforms[0].id,
            second.snapshot().platforms[0].id
        );
        assert_ne!(first.snapshot().grips[0].id, second.snapshot().grips[0].id);
    }

    #[test]
    fn a_new_capture_session_cannot_confirm_the_previous_sessions_cache() {
        let mut tracker = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        tracker.observe_image(
            1,
            1,
            100,
            candidates(vec![platform(10.0, 80.0, 100.0)], vec![]),
        );
        tracker.observe_unchanged(2, 1, 200);
        assert!(tracker.snapshot().platforms.is_empty());
        tracker.observe_image(
            2,
            2,
            300,
            candidates(vec![platform(10.0, 80.0, 100.0)], vec![]),
        );
        assert!(tracker.snapshot().platforms.is_empty());
    }

    #[test]
    fn pointer_only_refreshes_health_without_confirming_or_reviving_geometry() {
        let mut tracker = SurfaceTracker::new("primary", 800.0, 600.0, 552.0, Default::default());
        let set = candidates(vec![platform(10.0, 80.0, 100.0)], vec![]);
        tracker.verify_pointer_only(1, 50);
        assert_eq!(tracker.snapshot().verified_at_ms, 0);

        tracker.observe_image(1, 1, 100, set.clone());
        let revision = tracker.snapshot().revision;
        tracker.verify_pointer_only(1, 200);
        assert!(tracker.snapshot().platforms.is_empty());
        assert_eq!(tracker.snapshot().verified_at_ms, 200);
        assert_eq!(tracker.snapshot().revision, revision);
        tracker.observe_unchanged(1, 2, 300);
        assert_eq!(tracker.snapshot().platforms.len(), 1);

        tracker.invalidate("capture failed");
        let invalid_revision = tracker.snapshot().revision;
        tracker.verify_pointer_only(1, 400);
        assert!(!tracker.snapshot().valid);
        assert_eq!(tracker.snapshot().verified_at_ms, 300);
        assert_eq!(tracker.snapshot().revision, invalid_revision);
    }

    #[test]
    fn merged_run_includes_an_eight_dip_gap_but_not_a_larger_one() {
        let mut values = vec![0; 80];
        values[0..12].fill(200);
        values[20..32].fill(200);
        assert_eq!(merged_runs(&values, 8).len(), 1);
        assert_eq!(merged_runs(&values, 7).len(), 2);
    }

    #[test]
    fn short_vertical_minimum_cannot_be_assembled_from_fragments() {
        let continuous = Run {
            start: 1,
            end: 5,
            ink: 4,
            strength_sum: 4 * 255,
            fragments: 1,
            longest_fragment: 4,
        };
        assert!(vertical_run_meets_minimum(&continuous, 6, 6, 1.0, 6.0));

        let joined = Run {
            start: 1,
            end: 6,
            ink: 4,
            strength_sum: 4 * 255,
            fragments: 2,
            longest_fragment: 2,
        };
        assert!(!vertical_run_meets_minimum(&joined, 7, 6, 1.0, 6.0));

        let short_stem_with_many_fragments = Run {
            start: 1,
            end: 30,
            ink: 24,
            strength_sum: 24 * 255,
            fragments: 4,
            longest_fragment: 6,
        };
        assert!(!vertical_run_meets_minimum(
            &short_stem_with_many_fragments,
            31,
            26,
            1.0,
            6.0
        ));
    }

    #[test]
    fn legacy_vertical_runs_keep_their_original_ink_requirement() {
        let sparse_long_run = Run {
            start: 1,
            end: 31,
            ink: 24,
            strength_sum: 24 * 255,
            fragments: 4,
            longest_fragment: 8,
        };
        assert!(!vertical_run_meets_minimum(
            &sparse_long_run,
            32,
            26,
            1.0,
            6.0
        ));
        assert!(vertical_run_meets_minimum(
            &sparse_long_run,
            32,
            32,
            1.0,
            6.0
        ));
        assert!(vertical_run_meets_minimum(
            &sparse_long_run,
            32,
            32,
            1.0,
            LEGACY_VERTICAL_MIN_LENGTH_DIP
        ));
    }

    #[test]
    fn short_parallel_edge_responses_collapse_but_separated_stems_do_not_match() {
        let mut duplicate_edges = vec![grip(20.0, 10.0, 16.0), grip(22.0, 10.0, 16.0)];
        collapse_grip_edges(&mut duplicate_edges, 2.0);
        assert_eq!(duplicate_edges.len(), 1);

        let config = GeometryConfig::default();
        assert!(!grip_candidates_match(
            &grip(20.0, 10.0, 16.0),
            &grip(20.0, 18.0, 24.0),
            &config
        ));
        assert!(grip_candidates_match(
            &grip(20.0, 10.0, 42.0),
            &grip(20.0, 18.0, 50.0),
            &config
        ));
    }

    #[test]
    fn exact_horizontal_and_legacy_vertical_minimums_are_inclusive() {
        let config = legacy_vertical_config();
        let h_short = Run {
            start: 0,
            end: 23,
            ink: 23,
            strength_sum: 23 * 255,
            fragments: 1,
            longest_fragment: 23,
        };
        let h_exact = Run {
            end: 24,
            ink: 24,
            strength_sum: 24 * 255,
            longest_fragment: 24,
            ..h_short.clone()
        };
        assert!(((h_short.end - h_short.start) as f64) < config.horizontal_min_length_dip);
        assert!((h_exact.end - h_exact.start) as f64 >= config.horizontal_min_length_dip);
        assert!(31.0 < config.vertical_min_length_dip);
        assert!(32.0 >= config.vertical_min_length_dip);

        let width = 80;
        let height = 80;
        let mut pixels = vec![255; width * height * 4];
        fill_rect(&mut pixels, width, 1.0, 5.0, 20.0, 24.0, 1.0);
        fill_rect(&mut pixels, width, 1.0, 60.0, 5.0, 1.0, 32.0);
        let frame = BgraFrame {
            pixels: &pixels,
            width_px: width,
            height_px: height,
            row_pitch: width * 4,
            scale_factor: 1.0,
            rotation: FrameRotation::Identity,
            width_dip: width as f64,
            height_dip: height as f64,
            floor_y_dip: 72.0,
        };
        let extracted = extract_candidates(&frame, &config).unwrap();
        assert!(
            extracted
                .platforms
                .iter()
                .any(|candidate| candidate.x2 - candidate.x1 >= 24.0)
        );
        assert!(
            extracted
                .grips
                .iter()
                .any(|candidate| candidate.y2 - candidate.y1 >= 32.0)
        );
    }

    #[test]
    fn direct_edges_have_a_higher_confidence_baseline_than_text_rows() {
        let direct = quantize_confidence(0.50 + 0.8 * 0.30 + 0.8 * 0.20);
        let text = quantize_confidence(0.30 + 0.5 * 0.30 + 0.8 * 0.20 + 0.10);
        assert!(direct > text);
        assert!((0.0..=1.0).contains(&direct));
        assert!((0.0..=1.0).contains(&text));
    }

    #[test]
    fn dip_quantization_is_stable_across_common_scale_factors() {
        for scale in [1.0, 1.5, 2.0] {
            let physical = (24.0_f64 * scale).round();
            assert_eq!(quantize_dip(physical / scale), 24.0);
            let short_vertical = (6.0_f64 * scale).round();
            assert_eq!(quantize_dip(short_vertical / scale), 6.0);
            let legacy_vertical = (LEGACY_VERTICAL_MIN_LENGTH_DIP * scale).round();
            assert_eq!(
                quantize_dip(legacy_vertical / scale),
                LEGACY_VERTICAL_MIN_LENGTH_DIP
            );
        }
    }

    fn fill_rect(
        pixels: &mut [u8],
        width_px: usize,
        scale: f64,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) {
        fill_rect_color(pixels, width_px, scale, x, y, width, height, [0, 0, 0]);
    }

    #[allow(clippy::too_many_arguments)]
    fn fill_rect_color(
        pixels: &mut [u8],
        width_px: usize,
        scale: f64,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        color: [u8; 3],
    ) {
        let x1 = (x * scale).round() as usize;
        let y1 = (y * scale).round() as usize;
        let x2 = ((x + width) * scale).round() as usize;
        let y2 = ((y + height) * scale).round() as usize;
        for py in y1..y2.max(y1 + 1) {
            for px in x1..x2.max(x1 + 1) {
                let index = (py * width_px + px) * 4;
                pixels[index..index + 3].copy_from_slice(&color);
                pixels[index + 3] = 255;
            }
        }
    }

    fn small_visual_fixture(scale: f64) -> GeometryCandidates {
        let width_dip = 80.0;
        let height_dip = 60.0;
        let width_px = (width_dip * scale).round() as usize;
        let height_px = (height_dip * scale).round() as usize;
        let mut pixels = vec![255; width_px * height_px * 4];

        // A 12-DIP folder-like icon is 18 physical pixels at 150% scaling.
        // The pale outer pixel band and stronger inner fill approximate an
        // antialiased application icon edge rather than a binary test line.
        fill_rect_color(
            &mut pixels,
            width_px,
            scale,
            20.0,
            18.0,
            12.0,
            12.0,
            [220, 235, 245],
        );
        fill_rect_color(
            &mut pixels,
            width_px,
            scale,
            21.0,
            19.0,
            10.0,
            10.0,
            [40, 155, 230],
        );
        // A seven-DIP glyph stem represents the stronger vertical portion of
        // short Explorer text next to the icon.
        fill_rect(&mut pixels, width_px, scale, 52.0, 21.0, 1.5, 7.0);
        // Exercise the configured boundary with an exactly six-DIP stem.
        fill_rect(&mut pixels, width_px, scale, 66.0, 38.0, 1.5, 6.0);
        // Preserve the physical floor exclusion while exercising short grips.
        fill_rect(&mut pixels, width_px, scale, 2.0, 52.0, 70.0, 1.0);

        let frame = BgraFrame {
            pixels: &pixels,
            width_px,
            height_px,
            row_pitch: width_px * 4,
            scale_factor: scale,
            rotation: FrameRotation::Identity,
            width_dip,
            height_dip,
            floor_y_dip: 52.0,
        };
        extract_candidates(&frame, &GeometryConfig::default()).unwrap()
    }

    fn restored_height_upper_bound(y: f64, height: f64, scale: f64) -> f64 {
        let start_px = (y * scale).round();
        let end_px = ((y + height) * scale).round();
        // Candidate endpoints restore at most one physical pixel per side;
        // quantize each endpoint exactly as extraction does.
        quantize_dip((end_px + 1.0) / scale) - quantize_dip((start_px - 1.0) / scale)
    }

    #[test]
    fn small_antialiased_icon_and_text_edges_extract_at_common_dpi_scales() {
        assert_eq!(GeometryConfig::default().vertical_min_length_dip, 6.0);
        for scale in [1.0, 1.5, 2.0] {
            let result = small_visual_fixture(scale);
            let icon_upper_bound = restored_height_upper_bound(18.0, 12.0, scale);
            assert!(result.grips.iter().any(|candidate| {
                (18.0..=34.0).contains(&candidate.x)
                    && (6.0..=icon_upper_bound).contains(&(candidate.y2 - candidate.y1))
            }));
            let glyph_upper_bound = restored_height_upper_bound(21.0, 7.0, scale);
            assert!(
                result.grips.iter().any(|candidate| {
                    (50.0..=55.0).contains(&candidate.x)
                        && (6.0..=glyph_upper_bound).contains(&(candidate.y2 - candidate.y1))
                }),
                "scale {scale}: {:?}",
                result.grips
            );
            let minimum_upper_bound = restored_height_upper_bound(38.0, 6.0, scale);
            assert!(
                result.grips.iter().any(|candidate| {
                    (64.0..=69.0).contains(&candidate.x)
                        && (6.0..=minimum_upper_bound).contains(&(candidate.y2 - candidate.y1))
                }),
                "exact minimum at scale {scale}: {:?}",
                result.grips
            );
            assert!(
                result
                    .platforms
                    .iter()
                    .all(|candidate| (candidate.y - 52.0).abs() > 2.0)
            );
        }
    }

    #[test]
    fn disconnected_short_edges_stay_separate_and_pixel_noise_is_rejected() {
        let width = 80;
        let height = 80;
        let mut pixels = vec![255; width * height * 4];
        for y in [8.0, 20.0, 32.0] {
            fill_rect(&mut pixels, width, 1.0, 20.0, y, 1.0, 8.0);
        }
        for (y, height) in [(8.0, 1.0), (16.0, 2.0), (24.0, 3.0)] {
            fill_rect(&mut pixels, width, 1.0, 50.0, y, 1.0, height);
        }
        let frame = BgraFrame {
            pixels: &pixels,
            width_px: width,
            height_px: height,
            row_pitch: width * 4,
            scale_factor: 1.0,
            rotation: FrameRotation::Identity,
            width_dip: width as f64,
            height_dip: height as f64,
            floor_y_dip: 72.0,
        };
        let result = extract_candidates(&frame, &GeometryConfig::default()).unwrap();
        let ladder_fragments: Vec<_> = result
            .grips
            .iter()
            .filter(|candidate| (candidate.x - 20.0).abs() <= 2.0)
            .collect();
        assert_eq!(ladder_fragments.len(), 3);
        assert!(
            ladder_fragments
                .iter()
                // The centered gradient plus restored endpoints can extend a
                // binary stroke by one physical pixel on each end.
                .all(|candidate| {
                    candidate.y2 - candidate.y1 <= restored_height_upper_bound(8.0, 8.0, 1.0)
                }),
            "{ladder_fragments:?}"
        );
        assert!(
            !result
                .grips
                .iter()
                .any(|candidate| (candidate.x - 50.0).abs() <= 2.0)
        );
    }

    #[test]
    fn short_grip_candidate_budget_remains_bounded() {
        let mut candidates: Vec<_> = (0..MAX_GRIP_CANDIDATES + 17)
            .map(|index| grip(index as f64, 10.0, 16.0))
            .collect();
        bound_grip_candidates(&mut candidates);
        assert_eq!(candidates.len(), MAX_GRIP_CANDIDATES);
    }

    fn extracted_fixture(scale: f64) -> GeometryCandidates {
        let width_dip = 160.0;
        let height_dip = 120.0;
        let width_px = (width_dip * scale).round() as usize;
        let height_px = (height_dip * scale).round() as usize;
        let mut pixels = vec![255; width_px * height_px * 4];
        // A solid horizontal platform and a continuous vertical grip.
        fill_rect(&mut pixels, width_px, scale, 10.0, 24.0, 50.0, 1.0);
        fill_rect(&mut pixels, width_px, scale, 130.0, 10.0, 1.0, 52.0);
        // Six aligned glyph-like top strokes. Each fragment is too short to be
        // a line, while the merged ink and span form a text-row platform.
        for x in [10.0, 18.0, 26.0, 34.0, 42.0, 50.0] {
            fill_rect(&mut pixels, width_px, scale, x, 70.0, 4.0, 1.0);
        }
        // Eight-DIP texture fragments must not become a 32-DIP grip.
        for y in [72.0, 88.0, 104.0] {
            fill_rect(&mut pixels, width_px, scale, 100.0, y, 1.0, 8.0);
        }
        let frame = BgraFrame {
            pixels: &pixels,
            width_px,
            height_px,
            row_pitch: width_px * 4,
            scale_factor: scale,
            rotation: FrameRotation::Identity,
            width_dip,
            height_dip,
            floor_y_dip: 112.0,
        };
        extract_candidates(&frame, &legacy_vertical_config()).unwrap()
    }

    #[test]
    fn legacy_minimum_extracts_lines_text_rows_and_grips_without_promoting_grid_cells() {
        let result = extracted_fixture(1.0);
        assert!(result.platforms.iter().any(|candidate| {
            candidate.source == SurfacePlatformSource::PixelEdge
                && candidate.x2 - candidate.x1 >= 48.0
                && (candidate.y - 24.0).abs() <= 2.0
        }));
        assert!(result.platforms.iter().any(|candidate| {
            candidate.source == SurfacePlatformSource::TextRow
                && candidate.x2 - candidate.x1 >= 40.0
                && (candidate.y - 70.0).abs() <= 2.0
        }));
        assert!(
            result
                .grips
                .iter()
                .any(|candidate| candidate.y2 - candidate.y1 >= 48.0
                    && (candidate.x - 130.0).abs() <= 2.0)
        );
        assert!(
            !result
                .grips
                .iter()
                .any(|candidate| (candidate.x - 100.0).abs() <= 2.0)
        );
        assert!(result.platforms.iter().all(|candidate| {
            (0.0..=1.0).contains(&candidate.confidence) && (candidate.y - 112.0).abs() > 2.0
        }));
    }

    #[test]
    fn dpi_changes_physical_sampling_but_not_logical_geometry() {
        let baseline = extracted_fixture(1.0);
        for scale in [1.5, 2.0] {
            let scaled = extracted_fixture(scale);
            for source in [
                SurfacePlatformSource::PixelEdge,
                SurfacePlatformSource::TextRow,
            ] {
                let a = baseline
                    .platforms
                    .iter()
                    .find(|candidate| candidate.source == source)
                    .unwrap();
                let b = scaled
                    .platforms
                    .iter()
                    .find(|candidate| candidate.source == source)
                    .unwrap();
                assert!((a.x1 - b.x1).abs() <= 1.0);
                assert!((a.x2 - b.x2).abs() <= 1.0);
                assert!((a.y - b.y).abs() <= 1.0);
            }
            let a = baseline
                .grips
                .iter()
                .max_by(|a, b| (a.y2 - a.y1).total_cmp(&(b.y2 - b.y1)))
                .unwrap();
            let b = scaled
                .grips
                .iter()
                .max_by(|a, b| (a.y2 - a.y1).total_cmp(&(b.y2 - b.y1)))
                .unwrap();
            assert!((a.x - b.x).abs() <= 1.0);
            assert!((a.y1 - b.y1).abs() <= 1.0);
            assert!((a.y2 - b.y2).abs() <= 1.0);
        }
    }

    fn rotate_logical_bgra(
        logical: &[u8],
        logical_width: usize,
        logical_height: usize,
        rotation: FrameRotation,
    ) -> (Vec<u8>, usize, usize) {
        let (physical_width, physical_height) = match rotation {
            FrameRotation::Identity | FrameRotation::Rotate180 => (logical_width, logical_height),
            FrameRotation::Rotate90 | FrameRotation::Rotate270 => (logical_height, logical_width),
        };
        let mut physical = vec![0; physical_width * physical_height * 4];
        for y in 0..logical_height {
            for x in 0..logical_width {
                let (physical_x, physical_y) = match rotation {
                    FrameRotation::Identity => (x, y),
                    FrameRotation::Rotate90 => (y, physical_height - x - 1),
                    FrameRotation::Rotate180 => (physical_width - x - 1, physical_height - y - 1),
                    FrameRotation::Rotate270 => (physical_width - y - 1, x),
                };
                let source = (y * logical_width + x) * 4;
                let target = (physical_y * physical_width + physical_x) * 4;
                physical[target..target + 4].copy_from_slice(&logical[source..source + 4]);
            }
        }
        (physical, physical_width, physical_height)
    }

    #[test]
    fn all_dxgi_rotations_preserve_logical_geometry() {
        let width = 160;
        let height = 120;
        let mut logical = vec![255; width * height * 4];
        fill_rect(&mut logical, width, 1.0, 10.0, 24.0, 50.0, 1.0);
        fill_rect(&mut logical, width, 1.0, 130.0, 10.0, 1.0, 52.0);
        let mut results = Vec::new();
        for rotation in [
            FrameRotation::Identity,
            FrameRotation::Rotate90,
            FrameRotation::Rotate180,
            FrameRotation::Rotate270,
        ] {
            let (pixels, width_px, height_px) =
                rotate_logical_bgra(&logical, width, height, rotation);
            let frame = BgraFrame {
                pixels: &pixels,
                width_px,
                height_px,
                row_pitch: width_px * 4,
                scale_factor: 1.0,
                rotation,
                width_dip: width as f64,
                height_dip: height as f64,
                floor_y_dip: 112.0,
            };
            results.push(extract_candidates(&frame, &GeometryConfig::default()).unwrap());
        }
        assert!(results[0].platforms.len() >= 1);
        assert!(results[0].grips.len() >= 1);
        assert!(results.windows(2).all(|pair| pair[0] == pair[1]));
    }

    #[test]
    fn channel_gradient_keeps_equal_luminance_color_boundaries() {
        // These colors have similar weighted luminance in the former grayscale
        // approach but remain a strong local pixel boundary.
        let cyan = [255, 128, 0];
        let green = [0, 177, 0];
        assert!(
            channel_distance(cyan, green) >= u16::from(GeometryConfig::default().edge_threshold)
        );
    }

    #[test]
    #[ignore = "diagnostic timing varies by machine; run explicitly for extraction evidence"]
    fn extraction_1080p_diagnostic() {
        let width = 1920;
        let height = 1080;
        let mut pixels = vec![255; width * height * 4];
        for y in (80..960).step_by(80) {
            fill_rect(&mut pixels, width, 1.0, 100.0, y as f64, 1200.0, 1.0);
        }
        let frame = BgraFrame {
            pixels: &pixels,
            width_px: width,
            height_px: height,
            row_pitch: width * 4,
            scale_factor: 1.0,
            rotation: FrameRotation::Identity,
            width_dip: width as f64,
            height_dip: height as f64,
            floor_y_dip: 1040.0,
        };
        let started = std::time::Instant::now();
        let result = extract_candidates(&frame, &GeometryConfig::default()).unwrap();
        println!(
            "1080p extraction: {:?}, platforms={}, grips={}",
            started.elapsed(),
            result.platforms.len(),
            result.grips.len()
        );
        assert!(result.platforms.len() >= 10);
    }
}
