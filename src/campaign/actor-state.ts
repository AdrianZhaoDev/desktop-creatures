import { createActorBody, type ActorBody, type MovementState } from "./movement";
import { createActorInventory, type InventoryState } from "./inventory";
import type { RoleKind } from "./role-abilities";

export type ActorActivity =
  | "idle"
  | "travelling"
  | "working"
  | "returning-home"
  | "entering-home"
  | "resting"
  | "exiting-home"
  | "unavailable";

export interface ActorTask {
  readonly targetId: string;
  readonly kind: string;
  readonly assignedAtMs: number;
}

export interface StaminaProfile {
  readonly maximum: number;
  readonly returnHomeAt: number;
  readonly travelDrainPerSecond: number;
  readonly workDrainPerSecond: number;
  readonly restRecoveryPerSecond: number;
}

export const CLEANER_STAMINA: Readonly<StaminaProfile> = Object.freeze({
  maximum: 100,
  returnHomeAt: 20,
  travelDrainPerSecond: 3,
  workDrainPerSecond: 9,
  restRecoveryPerSecond: 24,
});

export const FROG_STAMINA: Readonly<StaminaProfile> = Object.freeze({
  maximum: 100,
  returnHomeAt: 20,
  travelDrainPerSecond: 4,
  workDrainPerSecond: 10,
  restRecoveryPerSecond: 28,
});

export interface ActorState {
  readonly id: string;
  readonly archetype: RoleKind;
  readonly appearanceId: string;
  readonly homeId: string;
  readonly body: ActorBody;
  readonly inventory: InventoryState;
  readonly staminaProfile: Readonly<StaminaProfile>;
  stamina: number;
  activity: ActorActivity;
  task?: ActorTask;
  insideHome: boolean;
}

export interface ActorStateSnapshot {
  readonly id: string;
  readonly archetype: RoleKind;
  readonly appearanceId: string;
  readonly homeId: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly motion: MovementState;
  readonly stamina: number;
  readonly staminaMaximum: number;
  readonly activity: ActorActivity;
  readonly task?: ActorTask;
  readonly insideHome: boolean;
  readonly inventory: Readonly<InventoryState>;
}

export interface StaminaUpdate {
  readonly previous: number;
  readonly current: number;
  readonly shouldReturnHome: boolean;
  readonly exhausted: boolean;
}

export type S06ActionSemantic =
  | "idle"
  | "walk"
  | "climb"
  | "jump_air"
  | "fall"
  | "clean"
  | "tongue_fire"
  | "carry"
  | "enter_home"
  | "sleep"
  | "wake";

export interface S06VisualAdapter {
  readonly source: "s06-asset" | "s06-placeholder";
  bind(actorId: string): void;
  apply(action: S06ActionSemantic, normalizedProgress: number): void;
  dispose(): void;
}

/** Explicit gray-box adapter used only until S06 supplies the real GLB actions. */
export class S06PlaceholderVisualAdapter implements S06VisualAdapter {
  readonly source = "s06-placeholder" as const;
  boundActorId?: string;
  action: S06ActionSemantic = "idle";
  normalizedProgress = 0;
  disposed = false;

  bind(actorId: string): void {
    if (this.disposed) throw new Error("placeholder adapter is disposed");
    this.boundActorId = actorId;
  }

  apply(action: S06ActionSemantic, normalizedProgress: number): void {
    if (this.disposed) return;
    this.action = action;
    this.normalizedProgress = Math.max(0, Math.min(1,
      Number.isFinite(normalizedProgress) ? normalizedProgress : 0));
  }

  dispose(): void { this.disposed = true; }
}

export function createActorState(options: {
  id: string;
  archetype: RoleKind;
  appearanceId: string;
  homeId: string;
  x: number;
  y: number;
  staminaProfile?: Readonly<StaminaProfile>;
  inventoryCapacity?: number;
}): ActorState {
  if (!options.id || !options.homeId || !options.appearanceId) throw new Error("actor identity, appearance, and home are required");
  if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) throw new RangeError("actor position must be finite");
  const profile = options.staminaProfile ?? (options.archetype === "frog" ? FROG_STAMINA : CLEANER_STAMINA);
  if (!validStaminaProfile(profile)) throw new RangeError("invalid stamina profile");
  const body = createActorBody(options.id, options.x, options.y);
  // Spawn coordinates are supplied by the campaign/home layer; physics validates
  // support on its first fixed step instead of showing a placeholder fall pose.
  body.motion = "walking";
  return {
    id: options.id,
    archetype: options.archetype,
    appearanceId: options.appearanceId,
    homeId: options.homeId,
    body,
    inventory: createActorInventory(options.id, options.archetype, options.inventoryCapacity),
    staminaProfile: { ...profile },
    stamina: profile.maximum,
    activity: "idle",
    insideHome: false,
  };
}

export function snapshotActor(actor: ActorState): ActorStateSnapshot {
  return {
    id: actor.id,
    archetype: actor.archetype,
    appearanceId: actor.appearanceId,
    homeId: actor.homeId,
    x: actor.body.x,
    y: actor.body.y,
    vx: actor.body.vx,
    vy: actor.body.vy,
    motion: actor.body.motion,
    stamina: actor.stamina,
    staminaMaximum: actor.staminaProfile.maximum,
    activity: actor.activity,
    task: actor.task ? { ...actor.task } : undefined,
    insideHome: actor.insideHome,
    inventory: { ...actor.inventory, objectIds: [...actor.inventory.objectIds] },
  };
}

export function assignActorTask(actor: ActorState, task: ActorTask): boolean {
  if (actor.insideHome || actor.activity === "unavailable" || shouldActorReturnHome(actor)) return false;
  actor.task = { ...task };
  actor.activity = "travelling";
  return true;
}

export function clearActorTask(actor: ActorState): void {
  actor.task = undefined;
  if (!actor.insideHome && actor.activity !== "unavailable" && actor.activity !== "returning-home") {
    actor.activity = "idle";
  }
}

export function requestActorReturnHome(actor: ActorState): void {
  actor.task = undefined;
  if (!actor.insideHome && actor.activity !== "unavailable") actor.activity = "returning-home";
}

export function shouldActorReturnHome(actor: ActorState): boolean {
  return actor.stamina <= actor.staminaProfile.returnHomeAt;
}

/** Advances only logical stamina. Paused or invalid deltas never change state. */
export function stepActorStamina(actor: ActorState, dtSeconds: number, paused = false): StaminaUpdate {
  const previous = actor.stamina;
  if (!paused && Number.isFinite(dtSeconds) && dtSeconds > 0) {
    let rate = 0;
    if (actor.activity === "travelling" || actor.activity === "returning-home") {
      rate = -actor.staminaProfile.travelDrainPerSecond;
    } else if (actor.activity === "working") {
      rate = -actor.staminaProfile.workDrainPerSecond;
    } else if (actor.activity === "resting") {
      rate = actor.staminaProfile.restRecoveryPerSecond;
    }
    actor.stamina = Math.max(0, Math.min(actor.staminaProfile.maximum, actor.stamina + rate * dtSeconds));
    if (actor.stamina <= actor.staminaProfile.returnHomeAt
        && (actor.activity === "travelling" || actor.activity === "working")) {
      requestActorReturnHome(actor);
    }
  }
  return {
    previous,
    current: actor.stamina,
    shouldReturnHome: shouldActorReturnHome(actor),
    exhausted: actor.stamina <= 0,
  };
}

export function resolveS06Action(actor: ActorState): S06ActionSemantic {
  if (actor.activity === "working") return actor.archetype === "frog" ? "tongue_fire" : "clean";
  if (actor.activity === "entering-home") return "enter_home";
  if (actor.activity === "resting") return "sleep";
  if (actor.activity === "exiting-home") return "wake";
  if (actor.body.grip || actor.body.motion === "climbing") return "climb";
  if (actor.body.motion === "jumping") return "jump_air";
  if (actor.body.motion === "falling") return "fall";
  if (actor.inventory.objectIds.length > 0 && actor.activity === "returning-home") return "carry";
  if (actor.activity === "travelling" || actor.activity === "returning-home" || Math.abs(actor.body.vx) > 1e-6) return "walk";
  return "idle";
}

/** Integration-friendly name; the S06-prefixed export remains explicit for asset work. */
export const resolveActorAction = resolveS06Action;

function validStaminaProfile(profile: Readonly<StaminaProfile>): boolean {
  return Number.isFinite(profile.maximum) && profile.maximum > 0
    && Number.isFinite(profile.returnHomeAt) && profile.returnHomeAt >= 0 && profile.returnHomeAt < profile.maximum
    && validRate(profile.travelDrainPerSecond) && validRate(profile.workDrainPerSecond)
    && validRate(profile.restRecoveryPerSecond);
}

function validRate(value: number): boolean { return Number.isFinite(value) && value >= 0; }
