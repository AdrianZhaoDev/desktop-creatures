import type { ActorState } from '../actor-state';
import type { EcologyPlacement } from '../ecology-cycle-types';
import type { ActorBody, MovementProfile } from '../movement';
import { buildNavigationGraph, findRoute } from '../navigation';
import { livePlatforms, supportsFeet } from '../physics';
import { isSurfaceSegmentLive, type SurfacePlatformSegment, type SurfaceSnapshotV2 } from '../surface';

const EPSILON = 1e-7;
const DEFAULT_MAX_SUPPORTS = 48;
/** Loose objects are placed just above route-proven supports, but they never fall toward
 * them. These insets keep sprites away from clipped screen edges and the four corners. */
export const ECOLOGY_SCATTER_SIDE_INSET_DIP = 48;
export const ECOLOGY_SCATTER_VERTICAL_INSET_DIP = 8;

export interface ReachableEcologySupport {
  readonly id: string;
  readonly version: number;
  /** Physical support interval in display-local DIP. */
  readonly x1: number;
  readonly x2: number;
  readonly y: number;
  /** Feet interval that retains the cleaner's required support overlap. */
  readonly feetX1: number;
  readonly feetX2: number;
}

/** The public ecology fields are normalized and transient. Supports are driver-only
 * evidence used to settle loose objects without adding terrain data to the save. */
export interface ReachableEcologyPlacement extends EcologyPlacement {
  readonly supports: readonly ReachableEcologySupport[];
  readonly cacheKey: string;
  readonly surfaceRevision: number;
}

export interface EcologyPlacementPlannerOptions {
  readonly maxSupports?: number;
  readonly onDiagnostic?: (code: string, supportId?: string) => void;
}

interface CachedPlacement {
  key: string;
  geometryKey: string;
  expiresAtMs: number;
  value: ReachableEcologyPlacement;
}

/** Builds a finite set of cleaner-reachable support points. A support is admitted only
 * after the existing navigation graph finds a complete physically rolled-out route.
 * Once one point on a horizontal support is reached, its feet interval is traversable by
 * the graph's ordinary walk edge, so publishing a few points on that interval adds no
 * unproved movement capability. */
export function computeReachableEcologyPlacement(
  actor: Readonly<ActorState>,
  surface: SurfaceSnapshotV2,
  profile: MovementProfile,
  nowMs: number,
  options: EcologyPlacementPlannerOptions = {},
): ReachableEcologyPlacement {
  const maxSupports = options.maxSupports ?? DEFAULT_MAX_SUPPORTS;
  if (!Number.isSafeInteger(maxSupports) || maxSupports < 1) throw new RangeError('Invalid ecology placement support budget');
  const cacheKey = placementCacheKey(actor, surface, profile, nowMs);
  const empty = (): ReachableEcologyPlacement => Object.freeze({
    points: Object.freeze([]), supports: Object.freeze([]),
    floorY: normalize(surface.floorY, surface.height), widthDip: surface.width, heightDip: surface.height,
    cacheKey, surfaceRevision: surface.revision,
  });
  if (!surface.valid || !validDimensions(surface) || !Number.isFinite(nowMs)
    || actor.archetype !== 'cleaner' || actor.activity === 'unavailable') return empty();

  const start = supportedStart(actor.body, surface, profile, nowMs);
  if (!start) return empty();
  const currentId = start.grip?.id ?? start.support?.id;
  const overlap = Math.min(12, profile.radius * 2);
  const candidates = livePlatforms(surface, nowMs).flatMap(platform => {
    if (platform.y < profile.height || platform.y > surface.floorY + EPSILON) return [];
    const feetX1 = Math.max(profile.radius, platform.x1 + overlap - profile.radius);
    const feetX2 = Math.min(surface.width - profile.radius, platform.x2 - overlap + profile.radius);
    if (feetX1 > feetX2) return [];
    return [{ platform, feetX1, feetX2 }];
  }).sort((a, b) => Number(b.platform.id === currentId) - Number(a.platform.id === currentId)
    || supportDistance(start, a.feetX1, a.feetX2, a.platform.y) - supportDistance(start, b.feetX1, b.feetX2, b.platform.y)
    || a.platform.y - b.platform.y || a.platform.x1 - b.platform.x1 || compareText(a.platform.id, b.platform.id));

  const supports: ReachableEcologySupport[] = [];
  for (const candidate of candidates.slice(0, maxSupports)) {
    const x = clamp(start.x, candidate.feetX1, candidate.feetX2);
    const target = { x, y: candidate.platform.y, kind: 'platform' as const, supportId: candidate.platform.id };
    const graph = buildNavigationGraph(surface, profile, nowMs, start, target);
    if (!findRoute(graph)) {
      if (graph.budgetExhausted) options.onDiagnostic?.('ecology-placement-budget-exhausted', candidate.platform.id);
      continue;
    }
    supports.push(Object.freeze({ id: candidate.platform.id, version: candidate.platform.version,
      x1: candidate.platform.x1, x2: candidate.platform.x2, y: candidate.platform.y,
      feetX1: candidate.feetX1, feetX2: candidate.feetX2 }));
  }
  if (candidates.length > maxSupports) options.onDiagnostic?.('ecology-placement-support-budget-exhausted');

  return placementFromSupports(start.x, surface, supports, cacheKey);
}

/** Avoids route searches on healthy capture refreshes. Geometry, the cleaner's current
 * support/grip, load and movement profile are the real reachability dependencies. */
export class EcologyPlacementPlanner {
  private cached?: CachedPlacement;
  planningCount = 0;

  constructor(private readonly options: EcologyPlacementPlannerOptions = {}) {}

  plan(actor: Readonly<ActorState>, surface: SurfaceSnapshotV2, profile: MovementProfile,
    nowMs: number): ReachableEcologyPlacement {
    const key = placementCacheKey(actor, surface, profile, nowMs);
    const geometryKey = placementGeometryKey(actor, surface, profile, nowMs);
    if (this.cached?.key === key && nowMs < this.cached.expiresAtMs) return this.cached.value;
    // A jump/drop has no contact reference for a few frames. The last proof remains valid
    // while geometry is unchanged. If geometry changes mid-flight, retain only supports
    // that still physically exist; landing triggers a full reachability rebuild.
    if (!supportedStart(actor.body, surface, profile, nowMs) && this.cached
      && nowMs < this.cached.expiresAtMs && actor.activity !== 'unavailable') {
      if (this.cached.geometryKey === geometryKey) return this.cached.value;
      const live = livePlatforms(surface, nowMs);
      const supports = this.cached.value.supports.filter(support => live.some(platform =>
        platform.id === support.id && platform.version === support.version
        && platform.x1 === support.x1 && platform.x2 === support.x2 && platform.y === support.y));
      const retained = placementFromSupports(actor.body.x, surface, supports, key);
      this.cached = { key, geometryKey, expiresAtMs: nextExpiry(surface, nowMs), value: retained };
      return retained;
    }
    const value = computeReachableEcologyPlacement(actor, surface, profile, nowMs, this.options);
    this.cached = { key, geometryKey, expiresAtMs: nextExpiry(surface, nowMs), value };
    this.planningCount++;
    return value;
  }

  reset(): void { this.cached = undefined; this.planningCount = 0; }
}

function supportedStart(body: Readonly<ActorBody>, surface: SurfaceSnapshotV2,
  profile: MovementProfile, nowMs: number): ActorBody | undefined {
  const start: ActorBody = { ...body,
    support: body.support ? { ...body.support } : undefined,
    grip: body.grip ? { ...body.grip } : undefined,
    releasedGrip: body.releasedGrip ? { ...body.releasedGrip } : undefined,
    dropThrough: body.dropThrough ? { ...body.dropThrough } : undefined };
  if (start.grip && surface.grips.some(grip => grip.id === start.grip!.id && grip.version === start.grip!.version
    && isSurfaceSegmentLive(grip, nowMs) && Math.abs(start.x - grip.x) <= 6
    && start.y >= grip.y1 && start.y <= Math.min(surface.floorY, grip.y2 + profile.height))) return start;
  const platforms = livePlatforms(surface, nowMs);
  if (start.support && platforms.some(platform => platform.id === start.support!.id && platform.version === start.support!.version
    && Math.abs(start.y - platform.y) <= EPSILON && supportsFeet(start.x, profile.radius, platform))) return start;
  const inferred = platforms.find(platform => Math.abs(start.y - platform.y) <= EPSILON
    && supportsFeet(start.x, profile.radius, platform));
  if (!inferred) return;
  start.grip = undefined;
  start.support = { id: inferred.id, version: inferred.version, revision: surface.revision };
  start.vy = 0;
  return start;
}

function placementCacheKey(actor: Readonly<ActorState>, surface: SurfaceSnapshotV2,
  profile: MovementProfile, nowMs: number): string {
  const geometry = placementGeometryKey(actor, surface, profile, nowMs);
  const contact = actor.body.grip ? ['grip', actor.body.grip.id, actor.body.grip.version]
    : actor.body.support ? ['platform', actor.body.support.id, actor.body.support.version]
      : ['airborne'];
  return JSON.stringify([geometry, contact]);
}

function placementGeometryKey(actor: Readonly<ActorState>, surface: SurfaceSnapshotV2,
  profile: MovementProfile, nowMs: number): string {
  const platforms = livePlatforms(surface, nowMs).map(segment => platformKey(segment)).sort();
  const grips = surface.valid && profile.canClimb ? surface.grips.filter(segment => isSurfaceSegmentLive(segment, nowMs))
    .map(segment => [segment.id, segment.version, segment.x, segment.y1, segment.y2]).sort(compareTuple) : [];
  return JSON.stringify([surface.displayId, surface.valid, surface.width, surface.height, surface.floorY,
    platforms, grips, actor.activity === 'unavailable', rounded(actor.body.loadFraction), profile]);
}

function placementFromSupports(actorX: number, surface: SurfaceSnapshotV2,
  supports: readonly ReachableEcologySupport[], cacheKey: string): ReachableEcologyPlacement {
  const points: { x: number; y: number }[] = [];
  const pointKeys = new Set<string>();
  const sideInset = Math.min(ECOLOGY_SCATTER_SIDE_INSET_DIP, surface.width * 0.08);
  const verticalInset = Math.min(ECOLOGY_SCATTER_VERTICAL_INSET_DIP, surface.height * 0.02);
  for (const support of supports) {
    const safeX1 = Math.max(support.feetX1, sideInset);
    const safeX2 = Math.min(support.feetX2, surface.width - sideInset);
    if (safeX1 > safeX2) continue;
    const span = safeX2 - safeX1;
    const samples = [clamp(actorX, safeX1, safeX2), ...[0, 1 / 6, 1 / 3, 1 / 2, 2 / 3, 5 / 6, 1]
      .map(fraction => safeX1 + span * fraction)];
    const itemY = clamp(support.y - verticalInset, verticalInset, surface.height - verticalInset);
    for (const x of samples) {
      const point = { x: normalize(x, surface.width), y: normalize(itemY, surface.height) };
      const key = `${point.x.toFixed(7)}:${point.y.toFixed(7)}`;
      if (!pointKeys.has(key)) { pointKeys.add(key); points.push(Object.freeze(point)); }
    }
  }
  return Object.freeze({ points: Object.freeze(points), supports: Object.freeze([...supports]),
    floorY: normalize(surface.floorY, surface.height), widthDip: surface.width, heightDip: surface.height,
    cacheKey, surfaceRevision: surface.revision });
}

function nextExpiry(surface: SurfaceSnapshotV2, nowMs: number): number {
  const deadlines = [
    ...surface.platforms.map(segment => segment.expiresAtMs),
    ...surface.grips.map(segment => segment.expiresAtMs),
  ].filter((deadline): deadline is number => deadline !== undefined && deadline > nowMs);
  return deadlines.length ? Math.min(...deadlines) : Infinity;
}

function platformKey(segment: SurfacePlatformSegment): (string | number)[] {
  return [segment.id, segment.version, segment.x1, segment.x2, segment.y];
}
function supportDistance(body: Readonly<ActorBody>, x1: number, x2: number, y: number): number {
  return Math.hypot(body.x - clamp(body.x, x1, x2), body.y - y);
}
function validDimensions(surface: SurfaceSnapshotV2): boolean {
  return [surface.width, surface.height, surface.floorY].every(Number.isFinite)
    && surface.width > 0 && surface.height > 0 && surface.floorY >= 0 && surface.floorY <= surface.height;
}
function normalize(value: number, extent: number): number { return extent > 0 ? clamp(value / extent, 0, 1) : 0; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function rounded(value: number): number { return Math.round(value * 1000) / 1000; }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function compareTuple(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
}
