/** All positions and dimensions are display-local DIP; y is the capsule's feet. */
export interface MovementProfile {
  speed: number;
  /** Horizontal airborne speed in DIP/s; walking retains speed. */
  airSpeed?: number;
  jumpVelocity: number;
  climbSpeed: number;
  canClimb: boolean;
  radius: number;
  height: number;
  maxLoadPenalty: number;
}

export const CLEANER_PROFILE: Readonly<MovementProfile> = Object.freeze({
  speed: 120, jumpVelocity: -360, climbSpeed: 90, canClimb: true,
  radius: 14, height: 120, maxLoadPenalty: 0.2,
});
export const FROG_PROFILE: Readonly<MovementProfile> = Object.freeze({
  speed: 150, jumpVelocity: -540, climbSpeed: 0, canClimb: false,
  radius: 24, height: 60, maxLoadPenalty: 0.2,
});

export type MovementState = "walking" | "climbing" | "jumping" | "falling" | "landing";
export interface SupportReference { id: string; version: number; revision: number }
export interface ActorBody {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  motion: MovementState;
  support?: SupportReference;
  grip?: SupportReference;
  /** A released grip cannot catch again until its contact volume has been exited. */
  releasedGrip?: SupportReference;
  lastGroundedAtMs: number;
  loadFraction: number;
  /** Prevents immediate re-contact with a deliberately dropped-through platform. */
  dropThrough?: { id: string; untilMs: number };
}
export interface MovementInput {
  moveX?: number;
  climb?: number;
  jump?: boolean;
  drop?: boolean;
  gripId?: string;
  /** Opt into catching a nearby live grip while airborne. */
  autoGrab?: boolean;
  releaseGrip?: boolean;
}
export function createActorBody(id: string, x: number, y: number): ActorBody {
  return { id, x, y, vx: 0, vy: 0, motion: "falling", lastGroundedAtMs: -Infinity, loadFraction: 0 };
}
export function movementScale(profile: MovementProfile, loadFraction: number): number {
  return 1 - Math.max(0, Math.min(0.2, profile.maxLoadPenalty)) * Math.max(0, Math.min(1, loadFraction));
}
