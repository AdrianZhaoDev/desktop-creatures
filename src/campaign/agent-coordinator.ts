import {
  assignActorTask,
  clearActorTask,
  requestActorReturnHome,
  shouldActorReturnHome,
  type ActorState,
} from "./actor-state";
import { ObjectOwnershipLedger, type TransferResult } from "./inventory";
import type { RoleKind, WorkItemKind } from "./role-abilities";

export interface AgentTarget {
  readonly id: string;
  readonly kind: WorkItemKind | string;
  readonly x: number;
  readonly y: number;
  readonly priority?: number;
  readonly allowedRoles?: readonly RoleKind[];
}

export interface AgentAssignment {
  readonly actorId: string;
  readonly targetId: string;
  readonly assignedAtMs: number;
  readonly reservationExpiresAtMs: number;
}

export interface UnreachableBackoff {
  readonly actorId: string;
  readonly targetId: string;
  readonly failures: number;
  readonly retryAtMs: number;
}

export interface AgentCoordinatorSnapshot {
  readonly assignments: readonly AgentAssignment[];
  readonly backoffs: readonly UnreachableBackoff[];
}

export interface CoordinationResult {
  readonly assigned: readonly AgentAssignment[];
  readonly releasedTargetIds: readonly string[];
  readonly returningHomeActorIds: readonly string[];
}

export interface AgentCoordinatorConfig {
  readonly reservationMs: number;
  readonly unreachableBaseMs: number;
  readonly unreachableMaxMs: number;
}

export const DEFAULT_COORDINATOR_CONFIG: Readonly<AgentCoordinatorConfig> = Object.freeze({
  reservationMs: 5_000,
  unreachableBaseMs: 500,
  unreachableMaxMs: 8_000,
});

export type ReachabilityProbe = (actor: Readonly<ActorState>, target: Readonly<AgentTarget>) => boolean;

/**
 * Deterministic S07 task coordinator. It reserves object identity in the shared
 * ownership ledger before publishing a task, so cleaner, frog, and later mouse
 * commands cannot all own the same object.
 */
export class AgentCoordinator {
  private readonly assignments = new Map<string, AgentAssignment>();
  private readonly backoffs = new Map<string, UnreachableBackoff>();
  private readonly pickupCommands = new Map<string, string>();

  constructor(
    private readonly ledger: ObjectOwnershipLedger,
    private readonly config: Readonly<AgentCoordinatorConfig> = DEFAULT_COORDINATOR_CONFIG,
  ) {
    if (!(config.reservationMs > 0) || !(config.unreachableBaseMs > 0)
        || config.unreachableMaxMs < config.unreachableBaseMs) {
      throw new RangeError("invalid coordinator timing configuration");
    }
  }

  coordinate(actors: readonly ActorState[], targets: readonly AgentTarget[], nowMs: number,
    canReach: ReachabilityProbe): CoordinationResult {
    if (!Number.isFinite(nowMs)) return { assigned: [], releasedTargetIds: [], returningHomeActorIds: [] };
    const releasedTargetIds = this.ledger.releaseExpiredReservations(nowMs);
    const returningHomeActorIds: string[] = [];
    const uniqueActors = [...new Map(actors.map(actor => [actor.id, actor])).values()]
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const actor of uniqueActors) {
      const assignment = this.assignments.get(actor.id);
      if (assignment && !this.isReservationLive(assignment, nowMs)) {
        this.assignments.delete(actor.id);
        if (actor.task?.targetId === assignment.targetId) clearActorTask(actor);
      }
      if (shouldActorReturnHome(actor) && !actor.insideHome
          && actor.activity !== "entering-home" && actor.activity !== "resting"
          && actor.activity !== "exiting-home" && actor.activity !== "unavailable") {
        if (this.releaseActor(actor)) releasedTargetIds.push(assignment?.targetId ?? "");
        requestActorReturnHome(actor);
        returningHomeActorIds.push(actor.id);
      }
    }

    const targetById = new Map<string, AgentTarget>();
    for (const target of targets) if (!targetById.has(target.id)) targetById.set(target.id, target);
    const orderedTargets = [...targetById.values()].filter(validTarget);
    const assigned: AgentAssignment[] = [];

    for (const actor of uniqueActors) {
      if (this.assignments.has(actor.id) || actor.task || actor.insideHome
          || actor.activity !== "idle" || shouldActorReturnHome(actor)) continue;
      const candidates = orderedTargets
        .filter(target => this.roleCanHandle(actor.archetype, target)
          && this.isWorldAvailable(target.id)
          && !this.inBackoff(actor.id, target.id, nowMs))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)
          || distanceSquared(actor, a) - distanceSquared(actor, b)
          || a.id.localeCompare(b.id));

      for (const target of candidates) {
        if (!canReach(actor, target)) {
          this.noteUnreachable(actor.id, target.id, nowMs);
          continue;
        }
        const expiresAtMs = nowMs + this.config.reservationMs;
        if (!this.ledger.reserve(target.id, actor.id, nowMs, expiresAtMs)) continue;
        if (!assignActorTask(actor, { targetId: target.id, kind: target.kind, assignedAtMs: nowMs })) {
          this.ledger.releaseReservation(target.id, actor.id);
          continue;
        }
        const assignment = { actorId: actor.id, targetId: target.id,
          assignedAtMs: nowMs, reservationExpiresAtMs: expiresAtMs };
        this.assignments.set(actor.id, assignment);
        assigned.push(assignment);
        break;
      }
    }

    return {
      assigned,
      releasedTargetIds: releasedTargetIds.filter(Boolean).sort((a, b) => a.localeCompare(b)),
      returningHomeActorIds,
    };
  }

  renew(actorId: string, nowMs: number): AgentAssignment | undefined {
    const assignment = this.assignments.get(actorId);
    if (!assignment || !this.isReservationLive(assignment, nowMs)) return undefined;
    const reservationExpiresAtMs = nowMs + this.config.reservationMs;
    if (!this.ledger.reserve(assignment.targetId, actorId, nowMs, reservationExpiresAtMs)) return undefined;
    const renewed = { ...assignment, reservationExpiresAtMs };
    this.assignments.set(actorId, renewed);
    return renewed;
  }

  reportUnreachable(actor: ActorState, nowMs: number): UnreachableBackoff | undefined {
    const assignment = this.assignments.get(actor.id);
    if (!assignment || !Number.isFinite(nowMs)) return undefined;
    this.ledger.releaseReservation(assignment.targetId, actor.id);
    this.assignments.delete(actor.id);
    clearActorTask(actor);
    return this.noteUnreachable(actor.id, assignment.targetId, nowMs);
  }

  reportReached(actorId: string, targetId: string): void {
    this.backoffs.delete(backoffKey(actorId, targetId));
  }

  pickupAssigned(commandId: string, actor: ActorState, nowMs: number): TransferResult {
    const assignment = this.assignments.get(actor.id);
    const liveTargetId = assignment?.targetId ?? actor.task?.targetId ?? "";
    const targetId = this.pickupCommands.get(commandId) ?? liveTargetId;
    if (commandId && !this.pickupCommands.has(commandId)) this.pickupCommands.set(commandId, targetId);
    const result = this.ledger.pickup(commandId, actor.id, actor.inventory,
      targetId ? [targetId] : [], nowMs);
    if (result.ok) {
      this.assignments.delete(actor.id);
      this.backoffs.delete(backoffKey(actor.id, targetId));
      clearActorTask(actor);
    } else if (result.reason === "not-reserved" || result.reason === "reservation-expired") {
      this.assignments.delete(actor.id);
      clearActorTask(actor);
    }
    return result;
  }

  releaseActor(actor: ActorState): boolean {
    const assignment = this.assignments.get(actor.id);
    if (!assignment) return false;
    this.ledger.releaseReservation(assignment.targetId, actor.id);
    this.assignments.delete(actor.id);
    clearActorTask(actor);
    return true;
  }

  snapshot(): AgentCoordinatorSnapshot {
    return {
      assignments: [...this.assignments.values()]
        .sort((a, b) => a.actorId.localeCompare(b.actorId)).map(value => ({ ...value })),
      backoffs: [...this.backoffs.values()]
        .sort((a, b) => a.actorId.localeCompare(b.actorId) || a.targetId.localeCompare(b.targetId))
        .map(value => ({ ...value })),
    };
  }

  private roleCanHandle(role: RoleKind, target: AgentTarget): boolean {
    if (target.allowedRoles) return target.allowedRoles.includes(role);
    return role === "frog" ? target.kind === "bug"
      : target.kind === "trash" || target.kind === "residue" || target.kind === "corpse" || target.kind === "egg";
  }

  private isWorldAvailable(targetId: string): boolean {
    return this.ledger.snapshot(targetId)?.owner.kind === "world";
  }

  private isReservationLive(assignment: AgentAssignment, nowMs: number): boolean {
    const owner = this.ledger.snapshot(assignment.targetId)?.owner;
    return assignment.reservationExpiresAtMs > nowMs && owner?.kind === "reserved"
      && owner.actorId === assignment.actorId && owner.expiresAtMs > nowMs;
  }

  private inBackoff(actorId: string, targetId: string, nowMs: number): boolean {
    return (this.backoffs.get(backoffKey(actorId, targetId))?.retryAtMs ?? -Infinity) > nowMs;
  }

  private noteUnreachable(actorId: string, targetId: string, nowMs: number): UnreachableBackoff {
    const key = backoffKey(actorId, targetId);
    const failures = (this.backoffs.get(key)?.failures ?? 0) + 1;
    const delay = Math.min(this.config.unreachableMaxMs,
      this.config.unreachableBaseMs * 2 ** Math.min(30, failures - 1));
    const backoff = { actorId, targetId, failures, retryAtMs: nowMs + delay };
    this.backoffs.set(key, backoff);
    return backoff;
  }
}

function validTarget(target: AgentTarget): boolean {
  return target.id.length > 0 && Number.isFinite(target.x) && Number.isFinite(target.y)
    && (target.priority === undefined || Number.isFinite(target.priority));
}

function distanceSquared(actor: ActorState, target: AgentTarget): number {
  return (actor.body.x - target.x) ** 2 + (actor.body.y - target.y) ** 2;
}

function backoffKey(actorId: string, targetId: string): string { return `${actorId}\u0000${targetId}`; }
