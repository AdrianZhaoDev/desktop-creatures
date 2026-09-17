import { CLEANER_PROFILE, FROG_PROFILE, type ActorBody, type MovementProfile } from "./movement";
import { livePlatforms, supportsFeet } from "./physics";
import type { SurfacePlatformSegment, SurfaceSnapshotV2 } from "./surface";

export type RoleKind = "cleaner" | "frog";
export type WorkItemKind = "trash" | "bug" | "residue";

export interface WorkItem {
  id: string;
  kind: WorkItemKind;
  /** World targets are fixed screen positions; gravity integrates ActorBody only. */
  readonly x: number;
  readonly y: number;
  units: number;
  removed?: boolean;
}

export interface RoleUpgrades {
  tongueBatch?: number;
  pouchCapacity?: number;
}

export type RoleUpgradeKind = keyof RoleUpgrades;

export interface RoleAttributes {
  movement: Readonly<MovementProfile>;
  cleanReach: number;
  cleanVerticalTolerance: number;
  cleanSeconds: number;
  tongueReach: number;
  /** Mouth height above the feet as a fraction of the movement capsule height. */
  tongueMouthHeightRatio: number;
  tongueBatch: number;
  pouchCapacity: number;
  tongueCooldownSeconds: number;
  digestionSeconds: number;
}

export type RoleAbilityStatus =
  | "idle"
  | "working"
  | "cleaned"
  | "captured"
  | "digesting"
  | "ejected"
  | "blocked";

export type RoleAbilityReason =
  | "none"
  | "wrong-role"
  | "target-missing"
  | "invalid-target"
  | "out-of-range"
  | "unsupported"
  | "gripping"
  | "cooldown"
  | "pouch-full";

export interface AbilityPoint { x: number; y: number }

export interface TongueEvent {
  sequence: number;
  atMs: number;
  mouth: AbilityPoint;
  targets: Array<AbilityPoint & { id: string }>;
}

export interface RoleAbilityUpdate {
  status: RoleAbilityStatus;
  reason: RoleAbilityReason;
  cleanProgress: number;
  pouchUsed: number;
  lastTongue?: TongueEvent;
  capturedTotal: number;
  cleanedTotal: number;
  cleanedTargetId?: string;
  capturedTargetIds?: string[];
  residueId?: string;
}

const MAX_UPGRADE_LEVEL = 3;
const POSITION_EPSILON = 1e-6;

function upgradeLevel(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_UPGRADE_LEVEL, Math.floor(value ?? 0)));
}

function safeDelta(dt: number): number {
  return Number.isFinite(dt) && dt > 0 ? dt : 0;
}

export function createRoleAttributes(role: RoleKind, upgrades: RoleUpgrades = {}): RoleAttributes {
  const batchLevel = upgradeLevel(upgrades.tongueBatch);
  const capacityLevel = upgradeLevel(upgrades.pouchCapacity);
  return {
    movement: role === "frog" ? FROG_PROFILE : CLEANER_PROFILE,
    cleanReach: 26,
    cleanVerticalTolerance: 12,
    cleanSeconds: 1.2,
    tongueReach: 140,
    tongueMouthHeightRatio: 0.8,
    tongueBatch: 1 + batchLevel,
    pouchCapacity: 4 + 2 * capacityLevel,
    tongueCooldownSeconds: 1.2,
    digestionSeconds: 8,
  };
}

function validItem(item: WorkItem): boolean {
  return !item.removed && item.id.length > 0 && Number.isFinite(item.x) && Number.isFinite(item.y)
    && Number.isFinite(item.units) && item.units > 0;
}

function matchingSupport(
  body: ActorBody,
  surface: SurfaceSnapshotV2,
  nowMs: number,
  profile: Readonly<MovementProfile>,
): SurfacePlatformSegment | undefined {
  if (body.grip || !body.support || !Number.isFinite(nowMs)) return undefined;
  const support = livePlatforms(surface, nowMs).find(candidate =>
    candidate.id === body.support!.id && candidate.version === body.support!.version,
  );
  if (!support || !supportsFeet(body.x, profile.radius, support)) return undefined;
  if (Math.abs(body.y - support.y) > POSITION_EPSILON) return undefined;
  return support;
}

function distanceSquared(a: AbilityPoint, b: AbilityPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function tongueMouth(body: ActorBody, attributes: RoleAttributes): AbilityPoint {
  return {
    x: body.x,
    y: body.y - attributes.movement.height * attributes.tongueMouthHeightRatio,
  };
}

export class RoleAbilityController {
  readonly role: RoleKind;
  status: RoleAbilityStatus = "idle";
  reason: RoleAbilityReason = "none";
  cleanProgress = 0;
  pouchUsed = 0;
  lastTongue?: TongueEvent;
  capturedTotal = 0;
  cleanedTotal = 0;

  private readonly upgrades: Required<RoleUpgrades>;
  private cleanTargetId?: string;
  private cleanElapsedSeconds = 0;
  private tongueCooldownRemaining = 0;
  private digestionElapsedSeconds = 0;
  private tongueSequence = 0;
  private residueSequence = 0;
  private readonly handledItemIds = new Set<string>();

  constructor(role: RoleKind, upgrades: RoleUpgrades = {}) {
    this.role = role;
    this.upgrades = {
      tongueBatch: upgradeLevel(upgrades.tongueBatch),
      pouchCapacity: upgradeLevel(upgrades.pouchCapacity),
    };
  }

  get attributes(): RoleAttributes {
    return createRoleAttributes(this.role, this.upgrades);
  }

  /** Gray-box tuning hook. Charging currency and persistence belong to the economy layer. */
  upgrade(kind: RoleUpgradeKind): RoleAttributes {
    if (this.role === "frog") {
      this.upgrades[kind] = Math.min(MAX_UPGRADE_LEVEL, this.upgrades[kind] + 1);
    }
    return this.attributes;
  }

  /** Capability/contact query for navigation; intentionally ignores cooldown and pouch capacity. */
  canActOn(body: ActorBody, surface: SurfaceSnapshotV2, nowMs: number, item: WorkItem): boolean {
    if (this.handledItemIds.has(item.id) || !validItem(item)
        || !matchingSupport(body, surface, nowMs, this.attributes.movement)) return false;
    if (this.role === "cleaner") {
      return (item.kind === "trash" || item.kind === "residue")
        && Math.abs(item.x - body.x) <= this.attributes.cleanReach
        && Math.abs(item.y - body.y) <= this.attributes.cleanVerticalTolerance;
    }
    if (item.kind !== "bug") return false;
    const mouth = tongueMouth(body, this.attributes);
    return distanceSquared(mouth, item) <= this.attributes.tongueReach ** 2;
  }

  update(
    body: ActorBody,
    surface: SurfaceSnapshotV2,
    nowMs: number,
    dt: number,
    items: WorkItem[],
    requestedTargetId?: string,
  ): RoleAbilityUpdate {
    const elapsed = safeDelta(dt);
    if (elapsed === 0) return this.snapshot();

    this.tongueCooldownRemaining = Math.max(0, this.tongueCooldownRemaining - elapsed);
    if (this.role === "frog" && this.pouchUsed > 0) {
      this.digestionElapsedSeconds = Math.min(
        this.attributes.digestionSeconds,
        this.digestionElapsedSeconds + elapsed,
      );
      if (this.digestionElapsedSeconds >= this.attributes.digestionSeconds
          && matchingSupport(body, surface, nowMs, this.attributes.movement)) {
        const residueId = `${body.id}:residue:${++this.residueSequence}`;
        items.push({ id: residueId, kind: "residue", x: body.x, y: body.y, units: this.pouchUsed });
        this.pouchUsed = 0;
        this.digestionElapsedSeconds = 0;
        this.status = "ejected";
        this.reason = "none";
        return this.snapshot({ residueId });
      }
    }

    if (!requestedTargetId) {
      this.resetCleaning();
      this.status = this.role === "frog" && this.pouchUsed > 0 ? "digesting" : "idle";
      this.reason = this.status === "digesting"
        && this.digestionElapsedSeconds >= this.attributes.digestionSeconds ? "unsupported" : "none";
      return this.snapshot();
    }

    const target = this.handledItemIds.has(requestedTargetId)
      ? undefined
      : items.find(item => item.id === requestedTargetId && !item.removed);
    if (!target) return this.blocked("target-missing", true);
    if (!validItem(target)) return this.blocked("invalid-target", true);
    if (this.role === "cleaner") return this.updateCleaner(body, surface, nowMs, elapsed, target);
    return this.updateFrog(body, surface, nowMs, items, target);
  }

  private updateCleaner(
    body: ActorBody,
    surface: SurfaceSnapshotV2,
    nowMs: number,
    elapsed: number,
    target: WorkItem,
  ): RoleAbilityUpdate {
    if (target.kind === "bug") return this.blocked("wrong-role", true);
    if (body.grip) return this.blocked("gripping", true);
    if (!matchingSupport(body, surface, nowMs, this.attributes.movement)) {
      return this.blocked("unsupported", true);
    }
    if (Math.abs(target.x - body.x) > this.attributes.cleanReach
        || Math.abs(target.y - body.y) > this.attributes.cleanVerticalTolerance) {
      return this.blocked("out-of-range", true);
    }
    if (this.cleanTargetId !== target.id) {
      this.cleanTargetId = target.id;
      this.cleanElapsedSeconds = 0;
    }
    this.cleanElapsedSeconds = Math.min(this.attributes.cleanSeconds, this.cleanElapsedSeconds + elapsed);
    this.cleanProgress = this.cleanElapsedSeconds / this.attributes.cleanSeconds;
    if (this.cleanElapsedSeconds < this.attributes.cleanSeconds) {
      this.status = "working";
      this.reason = "none";
      return this.snapshot();
    }
    this.handledItemIds.add(target.id);
    target.removed = true;
    this.cleanedTotal++;
    const cleanedTargetId = target.id;
    this.resetCleaning();
    this.status = "cleaned";
    this.reason = "none";
    return this.snapshot({ cleanedTargetId });
  }

  private updateFrog(
    body: ActorBody,
    surface: SurfaceSnapshotV2,
    nowMs: number,
    items: WorkItem[],
    target: WorkItem,
  ): RoleAbilityUpdate {
    this.resetCleaning();
    if (target.kind !== "bug") return this.blocked("wrong-role", false);
    if (body.grip) return this.blocked("gripping", false);
    if (!matchingSupport(body, surface, nowMs, this.attributes.movement)) {
      return this.blocked("unsupported", false);
    }
    const mouth = tongueMouth(body, this.attributes);
    if (distanceSquared(mouth, target) > this.attributes.tongueReach ** 2) {
      return this.blocked("out-of-range", false);
    }
    if (this.pouchUsed >= this.attributes.pouchCapacity) return this.blocked("pouch-full", false);
    if (this.tongueCooldownRemaining > 0) return this.blocked("cooldown", false);

    const remainingCapacity = this.attributes.pouchCapacity - this.pouchUsed;
    const maximum = Math.min(this.attributes.tongueBatch, remainingCapacity);
    const candidates = items
      .filter(item => item.kind === "bug" && validItem(item) && item.id !== target.id
        && !this.handledItemIds.has(item.id)
        && distanceSquared(mouth, item) <= this.attributes.tongueReach ** 2)
      .sort((a, b) => distanceSquared(mouth, a) - distanceSquared(mouth, b) || a.id.localeCompare(b.id));
    const selected: WorkItem[] = [target];
    const selectedIds = new Set([target.id]);
    for (const candidate of candidates) {
      if (selected.length >= maximum) break;
      if (selectedIds.has(candidate.id)) continue;
      selected.push(candidate);
      selectedIds.add(candidate.id);
    }
    for (const item of selected) {
      this.handledItemIds.add(item.id);
    }
    // IDs are world identities. Remove malformed duplicate records without counting them twice.
    for (const item of items) if (selectedIds.has(item.id)) item.removed = true;
    this.pouchUsed += selected.length;
    this.capturedTotal += selected.length;
    if (this.pouchUsed === selected.length) this.digestionElapsedSeconds = 0;
    this.tongueCooldownRemaining = this.attributes.tongueCooldownSeconds;
    this.lastTongue = {
      sequence: ++this.tongueSequence,
      atMs: Number.isFinite(nowMs) ? nowMs : 0,
      mouth,
      targets: selected.map(item => ({ id: item.id, x: item.x, y: item.y })),
    };
    this.status = "captured";
    this.reason = "none";
    return this.snapshot({ capturedTargetIds: selected.map(item => item.id) });
  }

  private resetCleaning(): void {
    this.cleanTargetId = undefined;
    this.cleanElapsedSeconds = 0;
    this.cleanProgress = 0;
  }

  private blocked(reason: RoleAbilityReason, resetCleaning: boolean): RoleAbilityUpdate {
    if (resetCleaning) this.resetCleaning();
    this.status = "blocked";
    this.reason = reason;
    return this.snapshot();
  }

  private snapshot(events: Partial<RoleAbilityUpdate> = {}): RoleAbilityUpdate {
    return {
      status: this.status,
      reason: this.reason,
      cleanProgress: this.cleanProgress,
      pouchUsed: this.pouchUsed,
      lastTongue: this.lastTongue,
      capturedTotal: this.capturedTotal,
      cleanedTotal: this.cleanedTotal,
      ...events,
    };
  }
}
