export type SurfacePlatformSource = "pixelEdge" | "textRow" | "screenBoundary";

export interface SurfacePlatformSegment {
  id: string;
  version: number;
  source: SurfacePlatformSource;
  confidence: number;
  x1: number;
  x2: number;
  y: number;
  /** Absolute Unix time. Physics must stop using the segment at this time. */
  expiresAtMs?: number;
}

export interface SurfaceGripSegment {
  id: string;
  version: number;
  source: "pixelEdge" | "screenBoundary";
  confidence: number;
  x: number;
  y1: number;
  y2: number;
  /** Absolute Unix time. Physics must stop using the segment at this time. */
  expiresAtMs?: number;
}

/**
 * Stable desktop geometry in display-local DIP coordinates (Y points down).
 * `floorY` is the permanent system floor and is never repeated in `platforms`.
 */
export interface SurfaceSnapshotV2 {
  schemaVersion: 2;
  displayId: string;
  revision: number;
  /** Time of the most recent real desktop image. */
  capturedAtMs: number;
  /** Time of the most recent real image or healthy unchanged observation. */
  verifiedAtMs: number;
  valid: boolean;
  width: number;
  height: number;
  floorY: number;
  /** Opt-in physical screen enclosure; capture snapshots do not imply this. */
  screenBounds?: boolean;
  platforms: SurfacePlatformSegment[];
  grips: SurfaceGripSegment[];
  error?: string;
}

export function isSurfaceSegmentLive(
  segment: Pick<SurfacePlatformSegment, "expiresAtMs">,
  nowMs: number,
): boolean {
  return segment.expiresAtMs === undefined || nowMs < segment.expiresAtMs;
}
