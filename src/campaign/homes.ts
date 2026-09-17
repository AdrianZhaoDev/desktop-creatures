import { shouldActorReturnHome, type ActorState } from "./actor-state";
import { ObjectOwnershipLedger, type TransferResult } from "./inventory";

export type HomeKind = "cleaner-home" | "frog-home";
export type HomeVisualState = "intact" | "light-damaged" | "heavy-damaged" | "destroyed";
export type HomeRoutinePhase = "entering" | "resting" | "exiting";

export interface HomeAnchor { readonly x: number; readonly y: number }

export interface HomeRoutineState {
  readonly actorId: string;
  phase: HomeRoutinePhase;
  elapsedSeconds: number;
  readonly visit: number;
}

export interface HomeState {
  readonly id: string;
  readonly kind: HomeKind;
  readonly residentId: string;
  readonly maxHp: number;
  readonly hp: number;
  readonly visual: HomeVisualState;
  x: number;
  readonly y: number;
  placementLocked: boolean;
  storageObjectIds: string[];
  routine?: HomeRoutineState;
  visitSequence: number;
}

export interface HomeStateSnapshot {
  readonly id: string;
  readonly kind: HomeKind;
  readonly residentId: string;
  readonly maxHp: number;
  readonly hp: number;
  readonly visual: HomeVisualState;
  readonly x: number;
  readonly y: number;
  readonly placementLocked: boolean;
  readonly storageObjectIds: readonly string[];
  readonly routine?: Readonly<HomeRoutineState>;
}

export interface HomeRoutineConfig {
  readonly entrySeconds: number;
  readonly exitSeconds: number;
  readonly arrivalTolerance: number;
}

export const NORMAL_HOME_ROUTINE: Readonly<HomeRoutineConfig> = Object.freeze({
  entrySeconds: 1.2,
  exitSeconds: 1,
  arrivalTolerance: 18,
});

export type HomeRoutineStatus =
  | "waiting"
  | "entering"
  | "unloaded"
  | "resting"
  | "exiting"
  | "departed"
  | "blocked";

export interface HomeRoutineUpdate {
  readonly status: HomeRoutineStatus;
  readonly unload?: TransferResult;
  readonly reason?: "wrong-home" | "occupied" | "not-returning" | "not-at-entrance" | "invalid-delta"
    | "too-tired" | "unavailable" | "invalid-state";
}

export interface CampaignHomes {
  readonly cleaner: HomeState;
  readonly frog: HomeState;
}

/**
 * The single HP-to-art-state boundary shared by domain presentation and rendering.
 * A non-positive HP value always means the player has been breached. A positive HP
 * paired with invalid maximum HP cannot establish a percentage, so it stays on the
 * neutral intact state instead of inventing damage or a breach.
 */
export function deriveHomeVisualState(
  home: Readonly<{ hp: number; maxHp: number }>,
): HomeVisualState {
  if (home.hp <= 0) return "destroyed";
  if (!Number.isFinite(home.hp) || !Number.isFinite(home.maxHp) || home.maxHp <= 0) return "intact";
  const fraction = home.hp / home.maxHp;
  if (fraction < 0.4) return "heavy-damaged";
  if (fraction < 0.7) return "light-damaged";
  return "intact";
}

/** S07 normal-state homes only. Siege damage and destruction belong to S11. */
export function createCampaignHomes(options: {
  cleanerResidentId: string;
  frogResidentId: string;
  floorY: number;
  cleanerX?: number;
  frogX?: number;
}): CampaignHomes {
  if (!options.cleanerResidentId || !options.frogResidentId
      || options.cleanerResidentId === options.frogResidentId) {
    throw new Error("campaign homes require two distinct residents");
  }
  if (!Number.isFinite(options.floorY)) throw new RangeError("home floor must be finite");
  return {
    cleaner: createHome("home.cleaner", "cleaner-home", options.cleanerResidentId,
      options.cleanerX ?? 140, options.floorY),
    frog: createHome("home.frog", "frog-home", options.frogResidentId,
      options.frogX ?? 330, options.floorY),
  };
}

export function snapshotHome(home: HomeState): HomeStateSnapshot {
  return {
    id: home.id,
    kind: home.kind,
    residentId: home.residentId,
    maxHp: home.maxHp,
    hp: home.hp,
    visual: deriveHomeVisualState(home),
    x: home.x,
    y: home.y,
    placementLocked: home.placementLocked,
    storageObjectIds: [...home.storageObjectIds],
    routine: home.routine ? { ...home.routine } : undefined,
  };
}

export function moveHome(home: HomeState, x: number): boolean {
  if (home.placementLocked || home.routine || !Number.isFinite(x)) return false;
  home.x = x;
  return true;
}

export function setHomePlacementLocked(home: HomeState, locked: boolean): void {
  home.placementLocked = locked;
}

export function beginHomeEntry(actor: ActorState, home: HomeState,
  config: Readonly<HomeRoutineConfig> = NORMAL_HOME_ROUTINE): HomeRoutineUpdate {
  if (actor.homeId !== home.id || actor.id !== home.residentId) return { status: "blocked", reason: "wrong-home" };
  if (home.routine && home.routine.actorId !== actor.id) return { status: "blocked", reason: "occupied" };
  if (actor.activity !== "returning-home") return { status: "blocked", reason: "not-returning" };
  if (Math.hypot(actor.body.x - home.x, actor.body.y - home.y) > config.arrivalTolerance) {
    return { status: "blocked", reason: "not-at-entrance" };
  }
  if (!home.routine) {
    home.routine = { actorId: actor.id, phase: "entering", elapsedSeconds: 0, visit: ++home.visitSequence };
  }
  home.placementLocked = true;
  actor.activity = "entering-home";
  actor.body.x = home.x;
  actor.body.y = home.y;
  actor.body.vx = 0;
  actor.body.vy = 0;
  actor.task = undefined;
  return { status: "entering" };
}

export function stepHomeRoutine(actor: ActorState, home: HomeState, ledger: ObjectOwnershipLedger,
  dtSeconds: number, paused = false,
  config: Readonly<HomeRoutineConfig> = NORMAL_HOME_ROUTINE): HomeRoutineUpdate {
  const routine = home.routine;
  if (!routine || routine.actorId !== actor.id) return { status: "waiting" };
  if (paused) return { status: routine.phase };
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return { status: "blocked", reason: "invalid-delta" };

  if (routine.phase === "entering") {
    routine.elapsedSeconds += dtSeconds;
    if (routine.elapsedSeconds + Number.EPSILON < config.entrySeconds) return { status: "entering" };
    const unload = ledger.unload(
      `${home.id}:visit:${routine.visit}:unload`, actor.id, actor.inventory,
      home.id, home.storageObjectIds, [...actor.inventory.objectIds],
    );
    if (!unload.ok) return { status: "blocked", unload };
    routine.phase = "resting";
    routine.elapsedSeconds = 0;
    actor.insideHome = true;
    actor.activity = "resting";
    return { status: "unloaded", unload };
  }

  if (routine.phase === "resting") {
    actor.stamina = Math.min(actor.staminaProfile.maximum,
      actor.stamina + actor.staminaProfile.restRecoveryPerSecond * dtSeconds);
    if (actor.stamina + Number.EPSILON < actor.staminaProfile.maximum) return { status: "resting" };
    actor.stamina = actor.staminaProfile.maximum;
    actor.activity = "exiting-home";
    routine.phase = "exiting";
    routine.elapsedSeconds = 0;
    return { status: "exiting" };
  }

  routine.elapsedSeconds += dtSeconds;
  if (routine.elapsedSeconds + Number.EPSILON < config.exitSeconds) return { status: "exiting" };
  actor.insideHome = false;
  actor.activity = "idle";
  actor.body.x = home.x;
  actor.body.y = home.y;
  home.routine = undefined;
  home.placementLocked = false;
  return { status: "departed" };
}

/** Read-only decision shared by application validation and the committed transition. */
export function homeExitReadiness(actor: ActorState, home: HomeState): HomeRoutineUpdate {
  if (actor.homeId !== home.id || actor.id !== home.residentId) return { status: "blocked", reason: "wrong-home" };
  if (home.routine && home.routine.actorId !== actor.id) return { status: "blocked", reason: "occupied" };
  if (actor.activity === "unavailable") return { status: "blocked", reason: "unavailable" };
  if (actor.activity === "returning-home" || actor.activity === "entering-home" || home.routine?.phase === "entering") {
    return { status: "waiting" };
  }
  if (actor.activity === "exiting-home" || home.routine?.phase === "exiting") return { status: "exiting" };
  if (shouldActorReturnHome(actor)) return { status: "blocked", reason: "too-tired" };
  if (!actor.insideHome) return { status: "departed" };
  if (actor.activity !== "resting" || home.routine?.phase !== "resting") return { status: "blocked", reason: "invalid-state" };
  return { status: "resting" };
}

/** Start the existing timed exit without moving the resident or changing stamina. */
export function requestHomeExit(actor: ActorState, home: HomeState): HomeRoutineUpdate {
  const readiness = homeExitReadiness(actor, home);
  if (readiness.status !== "resting") return readiness;
  home.routine!.phase = "exiting";
  home.routine!.elapsedSeconds = 0;
  home.placementLocked = true;
  actor.activity = "exiting-home";
  return { status: "exiting" };
}

function createHome(id: string, kind: HomeKind, residentId: string, x: number, y: number): HomeState {
  if (!Number.isFinite(x)) throw new RangeError("home x must be finite");
  return {
    id,
    kind,
    residentId,
    maxHp: 1000,
    hp: 1000,
    visual: "intact",
    x,
    y,
    placementLocked: false,
    storageObjectIds: [],
    visitSequence: 0,
  };
}
