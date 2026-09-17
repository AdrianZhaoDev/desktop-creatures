import type { MovementProfile } from "./movement";
import type { SurfaceSnapshotV2 } from "./surface";

export const SCREEN_LEFT_ID = "screen-boundary:left";
export const SCREEN_RIGHT_ID = "screen-boundary:right";
export const SCREEN_TOP_ID = "screen-boundary:top";

export function isScreenBoundaryId(id: string): boolean {
  return id === SCREEN_LEFT_ID || id === SCREEN_RIGHT_ID || id === SCREEN_TOP_ID;
}

// Versions describe geometry, not capture health, revisions, or elapsed time.
// Interning gives distinct geometry exact versions without a lossy hash.
const geometryVersions = new Map<string, number>();
function geometryVersion(coordinates: number[]): number {
  const key = JSON.stringify(coordinates);
  let version = geometryVersions.get(key);
  if (version === undefined) {
    version = geometryVersions.size + 1;
    geometryVersions.set(key, version);
  }
  return version;
}

/**
 * Per-actor collision/navigation view of the permanent screen frame, in DIP.
 * Keep the raw snapshot separately for capture diagnostics: this view is valid
 * even when capture fails, but never retains invalid captured terrain.
 * The ceiling support uses feet coordinates for a body hanging below y=0;
 * render the real screen border at y=0, not this virtual support height.
 */
export function withScreenBoundaries(surface: SurfaceSnapshotV2, profile: MovementProfile): SurfaceSnapshotV2 {
  const platforms = surface.valid ? surface.platforms.filter(p => !isScreenBoundaryId(p.id) && p.y >= profile.height && p.y <= surface.height) : [];
  const grips = surface.valid ? surface.grips.filter(g => !isScreenBoundaryId(g.id) && g.y1 <= surface.height && g.y2 >= 0)
    .map(g => ({ ...g, y1: Math.max(profile.height, g.y1) })) : [];
  if (profile.canClimb) {
    platforms.push({ id: SCREEN_TOP_ID, source: "screenBoundary", confidence: 1,
      version: geometryVersion([0, surface.width, profile.height]), x1: 0, x2: surface.width, y: profile.height });
    for (const [id, x] of [[SCREEN_LEFT_ID, profile.radius], [SCREEN_RIGHT_ID, surface.width - profile.radius]] as const) {
      grips.push({ id, source: "screenBoundary", confidence: 1,
        version: geometryVersion([x, profile.height, surface.height]), x, y1: profile.height, y2: surface.height });
    }
  }
  return { ...surface, valid: true, screenBounds: true, floorY: surface.height, platforms, grips };
}
