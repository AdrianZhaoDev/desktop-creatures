import { movementScale, type ActorBody, type MovementInput, type MovementProfile, type SupportReference } from "./movement";
import { isSurfaceSegmentLive, type SurfacePlatformSegment, type SurfaceSnapshotV2 } from "./surface";

export const FIXED_DT = 1 / 60;
export const GRAVITY = 1200;
export const MAX_FALL_SPEED = 900;
export const COYOTE_MS = 80;
/** S03 publishes expiresAtMs; this duration MUST NOT be added again by physics. */
export const CONTACT_TOLERANCE_MS = 150;
export const FLOOR_ID = "floor";
const EPSILON = 1e-7;

/** Ballistic limits at equal takeoff/landing height; terrain still decides contact. */
export function jumpReach(profile: MovementProfile, loadFraction = 0): { maxHeight: number; sameHeightDistance: number } {
  const scale = movementScale(profile, loadFraction);
  const impulse = Math.abs(profile.jumpVelocity) * scale;
  return { maxHeight: impulse * impulse / (2 * GRAVITY),
    sameHeightDistance: 2 * impulse * (profile.airSpeed ?? profile.speed) * scale / GRAVITY };
}

export function standingOverlap(x: number, radius: number, platform: Pick<SurfacePlatformSegment, "x1" | "x2">): number {
  return Math.max(0, Math.min(x + radius, platform.x2) - Math.max(x - radius, platform.x1));
}
export function supportsFeet(x: number, radius: number, platform: Pick<SurfacePlatformSegment, "x1" | "x2">): boolean {
  return standingOverlap(x, radius, platform) + EPSILON >= Math.min(12, radius * 2);
}
export function livePlatforms(surface: SurfaceSnapshotV2, nowMs: number): SurfacePlatformSegment[] {
  return [
    { id: FLOOR_ID, version: 0, x1: 0, x2: surface.width, y: surface.floorY, source: "pixelEdge", confidence: 1 },
    ...(surface.valid ? surface.platforms.filter(p => isSurfaceSegmentLive(p, nowMs)) : []),
  ];
}
function reference(id: string, version: number, revision: number): SupportReference { return { id, version, revision }; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

/** Exact displacement with a terminal-speed phase, shared by navigation's rollout. */
export function verticalDisplacement(velocity: number, seconds: number): number {
  const v = Math.min(velocity, MAX_FALL_SPEED);
  const accelerating = Math.min(seconds, Math.max(0, (MAX_FALL_SPEED - v) / GRAVITY));
  return v * accelerating + GRAVITY * accelerating * accelerating / 2 + MAX_FALL_SPEED * (seconds - accelerating);
}
/** First downward intersection with a horizontal line, including the apex within a step. */
function downwardCrossing(y: number, velocity: number, lineY: number, seconds: number): number | undefined {
  const v = Math.min(velocity, MAX_FALL_SPEED);
  const terminalAt = Math.max(0, (MAX_FALL_SPEED - v) / GRAVITY);
  const discriminant = v * v + 2 * GRAVITY * (lineY - y);
  if (discriminant < -EPSILON) return;
  const acceleratedTime = (-v + Math.sqrt(Math.max(0, discriminant))) / GRAVITY;
  let time = acceleratedTime;
  if (acceleratedTime > terminalAt) {
    const terminalY = y + verticalDisplacement(v, terminalAt);
    time = terminalAt + (lineY - terminalY) / MAX_FALL_SPEED;
  }
  if (time < -EPSILON || time > seconds + EPSILON || v + GRAVITY * time < -EPSILON) return;
  return clamp(time, 0, seconds);
}

/** Mutates one body. No animation or species names enter the collision solver. */
export function stepActor(
  body: ActorBody, input: MovementInput, surface: SurfaceSnapshotV2,
  profile: MovementProfile, nowMs: number, dt = FIXED_DT,
): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  // Public callers cannot bypass continuous fixed-step integration with a large frame delta.
  if (dt > FIXED_DT + EPSILON) throw new RangeError("stepActor requires a fixed step of at most 1/60 second");
  const scale = movementScale(profile, body.loadFraction);
  const moveX = clamp(input.moveX ?? 0, -1, 1);
  const platforms = livePlatforms(surface, nowMs).filter(p => !surface.screenBounds || p.y >= profile.height);
  if (body.dropThrough && nowMs >= body.dropThrough.untilMs) body.dropThrough = undefined;
  let support = body.support && platforms.find(p => p.id === body.support!.id && p.version === body.support!.version);
  // A changed version or expired segment releases now. No second 150ms grace window.
  if (!support || !supportsFeet(body.x, profile.radius, support) || Math.abs(body.y - support.y) > EPSILON) {
    body.support = undefined;
    support = undefined;
  }
  let grip = surface.valid && profile.canClimb
    ? surface.grips.find(g => g.id === body.grip?.id && g.version === body.grip.version && isSurfaceSegmentLive(g, nowMs))
    : undefined;
  if (grip && (Math.abs(body.x - grip.x) > 6 || body.y < grip.y1 || body.y - profile.height > grip.y2)) grip = undefined;
  if (body.releasedGrip && (!surface.valid || !surface.grips.some(g => g.id === body.releasedGrip!.id
    && g.version === body.releasedGrip!.version && isSurfaceSegmentLive(g, nowMs)
    && Math.abs(body.x - g.x) <= 6 && body.y >= g.y1 && body.y - profile.height <= g.y2))) body.releasedGrip = undefined;
  if (input.releaseGrip || input.drop) {
    if (grip) body.releasedGrip = reference(grip.id, grip.version, surface.revision);
    grip = undefined;
  }
  if (!grip) body.grip = undefined;

  if (support) body.lastGroundedAtMs = nowMs;
  if (input.drop && support && support.id !== FLOOR_ID) {
    body.dropThrough = { id: support.id, untilMs: nowMs + 250 };
    body.support = undefined;
    support = undefined;
    body.lastGroundedAtMs = -Infinity;
  }
  if (input.jump && (support || grip || nowMs - body.lastGroundedAtMs <= COYOTE_MS)) {
    if (grip) body.releasedGrip = reference(grip.id, grip.version, surface.revision);
    body.vy = profile.jumpVelocity * scale;
    body.motion = "jumping";
    body.support = undefined;
    body.grip = undefined;
    body.lastGroundedAtMs = -Infinity;
    support = undefined;
    grip = undefined;
  } else if (!input.releaseGrip && !input.drop && profile.canClimb && surface.valid
    && (input.gripId || input.climb || input.autoGrab && !support)) {
    let candidate = grip && (!input.gripId || input.gripId === grip.id) ? grip : undefined;
    if (!candidate) {
      for (const g of surface.grips) {
        if (input.gripId && g.id !== input.gripId
          || g.id === body.releasedGrip?.id && g.version === body.releasedGrip.version
          || !isSurfaceSegmentLive(g, nowMs) || Math.abs(body.x - g.x) > 6
          || body.y < g.y1 || body.y - profile.height > g.y2) continue;
        if (!candidate || Math.abs(body.x - g.x) < Math.abs(body.x - candidate.x)) candidate = g;
        if (input.gripId || !input.autoGrab) break;
      }
    }
    if (candidate) {
      grip = candidate;
      body.grip = reference(grip.id, grip.version, surface.revision);
      body.support = undefined;
      support = undefined;
    }
  }
  if (grip) {
    body.vx = 0;
    body.vy = clamp(input.climb ?? 0, -1, 1) * profile.climbSpeed * scale;
    const minimumFeetY = surface.screenBounds ? Math.max(profile.height, grip.y1) : grip.y1;
    body.y = clamp(body.y + body.vy * dt, minimumFeetY, Math.min(surface.floorY, grip.y2 + profile.height));
    body.motion = "climbing";
    return;
  }

  body.vx = moveX * (support ? profile.speed : profile.airSpeed ?? profile.speed) * scale;
  const startX = body.x;
  const endX = clamp(startX + body.vx * dt, profile.radius, Math.max(profile.radius, surface.width - profile.radius));
  if (support && supportsFeet(endX, profile.radius, support)) {
    body.x = endX;
    body.vy = 0;
    body.motion = "walking";
    return;
  }
  body.support = undefined;
  // Screen edges constrain horizontal motion, but never move an actor to a target.
  const horizontalVelocity = (endX - startX) / dt;
  let collision: { platform: SurfacePlatformSegment; time: number } | undefined;
  for (const platform of platforms) {
    if (body.dropThrough?.id === platform.id) continue;
    const time = downwardCrossing(body.y, body.vy, platform.y, dt);
    if (time === undefined || !supportsFeet(startX + horizontalVelocity * time, profile.radius, platform)) continue;
    if (!collision || time < collision.time) collision = { platform, time };
  }
  if (collision) {
    body.x = endX;
    body.y = collision.platform.y;
    body.vy = 0;
    body.support = reference(collision.platform.id, collision.platform.version, surface.revision);
    body.lastGroundedAtMs = nowMs;
    body.motion = "landing";
    // Moving beyond a very narrow platform after impact cannot leave floating support.
    if (!supportsFeet(endX, profile.radius, collision.platform)) {
      body.support = undefined;
      const remaining = dt - collision.time;
      body.y += verticalDisplacement(0, remaining);
      body.vy = Math.min(MAX_FALL_SPEED, GRAVITY * remaining);
      body.motion = "falling";
    }
  } else {
    body.x = endX;
    body.y += verticalDisplacement(body.vy, dt);
    body.vy = Math.min(MAX_FALL_SPEED, body.vy + GRAVITY * dt);
    body.motion = body.vy < 0 ? "jumping" : "falling";
  }
  if (body.y > surface.floorY) {
    body.y = surface.floorY;
    body.vy = 0;
    body.support = reference(FLOOR_ID, 0, surface.revision);
    body.lastGroundedAtMs = nowMs;
    body.motion = "landing";
  }
  // In the explicit screen-boundary world, the top edge stops the capsule's head.
  // A frog can collide with it but gains no ceiling support or climbing ability.
  if (surface.screenBounds && body.y < profile.height) {
    body.y = profile.height;
    body.vy = Math.max(0, body.vy);
    body.support = undefined;
    body.motion = "falling";
  }
}

export interface FixedStepResult { steps: number; alpha: number; droppedSeconds: number }
export class FixedStepClock {
  private accumulator = 0;
  private wasPaused = false;
  advance(frameSeconds: number, paused: boolean, update: (dt: number) => void): FixedStepResult {
    if (paused) {
      this.accumulator = 0;
      this.wasPaused = true;
      return { steps: 0, alpha: 0, droppedSeconds: 0 };
    }
    if (this.wasPaused) {
      this.wasPaused = false;
      return { steps: 0, alpha: 0, droppedSeconds: 0 };
    }
    this.accumulator += Number.isFinite(frameSeconds) ? Math.max(0, frameSeconds) : 0;
    let steps = 0;
    while (this.accumulator + EPSILON >= FIXED_DT && steps < 6) {
      update(FIXED_DT);
      this.accumulator = Math.max(0, this.accumulator - FIXED_DT);
      steps++;
    }
    const droppedSeconds = Math.floor((this.accumulator + EPSILON) / FIXED_DT) * FIXED_DT;
    this.accumulator = Math.max(0, this.accumulator - droppedSeconds);
    return { steps, alpha: this.accumulator / FIXED_DT, droppedSeconds };
  }
  reset(): void { this.accumulator = 0; this.wasPaused = false; }
}
