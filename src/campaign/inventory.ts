import type { RoleKind } from "./role-abilities";

export type InventoryKind = "cleaner-bag" | "frog-pouch";
export type InventoryMeasure = "weight" | "units";

export interface InventoryState {
  readonly id: string;
  readonly actorId: string;
  readonly kind: InventoryKind;
  readonly measure: InventoryMeasure;
  capacity: number;
  objectIds: string[];
}

export interface OwnedObject {
  readonly id: string;
  readonly kind: string;
  readonly units: number;
  readonly weight: number;
}

export type ObjectOwner =
  | { readonly kind: "world" }
  | { readonly kind: "reserved"; readonly actorId: string; readonly expiresAtMs: number }
  | { readonly kind: "inventory"; readonly inventoryId: string; readonly actorId: string }
  | { readonly kind: "home"; readonly homeId: string };

export interface ObjectOwnershipSnapshot extends OwnedObject {
  readonly owner: ObjectOwner;
}

export type TransferFailure =
  | "none"
  | "command-conflict"
  | "duplicate-object"
  | "object-missing"
  | "not-reserved"
  | "reservation-expired"
  | "wrong-owner"
  | "capacity-exceeded";

export interface TransferResult {
  readonly commandId: string;
  readonly ok: boolean;
  readonly repeated: boolean;
  readonly reason: TransferFailure;
  readonly objectIds: readonly string[];
}

interface StoredObject extends OwnedObject { owner: ObjectOwner }
interface StoredCommand { fingerprint: string; result: TransferResult }

function validPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function uniqueSorted(ids: readonly string[]): string[] | undefined {
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  if (sorted.some((id, index) => id.length === 0 || index > 0 && id === sorted[index - 1])) return undefined;
  return sorted;
}

function commandFingerprint(operation: string, fields: readonly (string | number)[]): string {
  return JSON.stringify([operation, ...fields]);
}

function cloneOwner(owner: ObjectOwner): ObjectOwner { return { ...owner }; }

/**
 * Authoritative object-ownership ledger for S07 logistics.
 *
 * Every world object has exactly one owner. Mutations validate the full command
 * before changing any object, and command IDs make successful and failed retries
 * deterministic. Persistence is deliberately left to the V4 save layer.
 */
export class ObjectOwnershipLedger {
  private readonly objects = new Map<string, StoredObject>();
  private readonly commands = new Map<string, StoredCommand>();

  register(object: OwnedObject): void {
    if (!object.id || this.objects.has(object.id)) throw new Error(`duplicate object id: ${object.id}`);
    if (!validPositive(object.units) || !validPositive(object.weight)) {
      throw new RangeError(`object ${object.id} must have positive units and weight`);
    }
    this.objects.set(object.id, { ...object, owner: { kind: "world" } });
  }

  snapshot(objectId: string): ObjectOwnershipSnapshot | undefined {
    const object = this.objects.get(objectId);
    return object ? { ...object, owner: cloneOwner(object.owner) } : undefined;
  }

  snapshots(): ObjectOwnershipSnapshot[] {
    return [...this.objects.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(object => ({ ...object, owner: cloneOwner(object.owner) }));
  }

  reserve(objectId: string, actorId: string, nowMs: number, expiresAtMs: number): boolean {
    const object = this.objects.get(objectId);
    if (!object || !actorId || !Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false;
    if (object.owner.kind === "reserved" && object.owner.expiresAtMs <= nowMs) object.owner = { kind: "world" };
    if (object.owner.kind === "reserved" && object.owner.actorId === actorId) {
      object.owner = { kind: "reserved", actorId, expiresAtMs };
      return true;
    }
    if (object.owner.kind !== "world") return false;
    object.owner = { kind: "reserved", actorId, expiresAtMs };
    return true;
  }

  releaseReservation(objectId: string, actorId: string): boolean {
    const object = this.objects.get(objectId);
    if (object?.owner.kind !== "reserved" || object.owner.actorId !== actorId) return false;
    object.owner = { kind: "world" };
    return true;
  }

  releaseExpiredReservations(nowMs: number): string[] {
    if (!Number.isFinite(nowMs)) return [];
    const released: string[] = [];
    for (const object of this.objects.values()) {
      if (object.owner.kind === "reserved" && object.owner.expiresAtMs <= nowMs) {
        object.owner = { kind: "world" };
        released.push(object.id);
      }
    }
    return released.sort((a, b) => a.localeCompare(b));
  }

  pickup(commandId: string, actorId: string, inventory: InventoryState,
    objectIds: readonly string[], nowMs: number): TransferResult {
    const ids = uniqueSorted(objectIds);
    const fingerprint = commandFingerprint("pickup", [actorId, inventory.id, ...(ids ?? objectIds)]);
    const repeated = this.repeat(commandId, fingerprint);
    if (repeated) return repeated;
    if (!commandId) return this.remember(commandId, fingerprint, false, "command-conflict", []);
    if (!ids) return this.remember(commandId, fingerprint, false, "duplicate-object", []);
    if (ids.length === 0) return this.remember(commandId, fingerprint, false, "object-missing", []);

    let reason: TransferFailure = "none";
    for (const id of ids) {
      const object = this.objects.get(id);
      if (!object) { reason = "object-missing"; break; }
      if (object.owner.kind === "reserved" && object.owner.expiresAtMs <= nowMs) {
        // Expiry is an authoritative clock transition, not part of the failed transfer.
        object.owner = { kind: "world" };
        reason = "reservation-expired";
        break;
      }
      if (object.owner.kind !== "reserved" || object.owner.actorId !== actorId) {
        reason = "not-reserved";
        break;
      }
    }
    if (reason === "none" && inventory.actorId !== actorId) reason = "wrong-owner";
    if (reason === "none" && inventoryLoad(inventory, this) + this.measure(ids, inventory.measure) > inventory.capacity) {
      reason = "capacity-exceeded";
    }
    if (reason !== "none") return this.remember(commandId, fingerprint, false, reason, ids);

    for (const id of ids) {
      this.objects.get(id)!.owner = { kind: "inventory", inventoryId: inventory.id, actorId };
      inventory.objectIds.push(id);
    }
    inventory.objectIds.sort((a, b) => a.localeCompare(b));
    return this.remember(commandId, fingerprint, true, "none", ids);
  }

  unload(commandId: string, actorId: string, inventory: InventoryState,
    homeId: string, homeStorage: string[], objectIds: readonly string[] = inventory.objectIds): TransferResult {
    const ids = uniqueSorted(objectIds);
    const fingerprint = commandFingerprint("unload", [actorId, inventory.id, homeId, ...(ids ?? objectIds)]);
    const repeated = this.repeat(commandId, fingerprint);
    if (repeated) return repeated;
    if (!commandId) return this.remember(commandId, fingerprint, false, "command-conflict", []);
    if (!ids) return this.remember(commandId, fingerprint, false, "duplicate-object", []);

    let reason: TransferFailure = inventory.actorId === actorId ? "none" : "wrong-owner";
    for (const id of ids) {
      if (reason !== "none") break;
      const object = this.objects.get(id);
      if (!object) { reason = "object-missing"; break; }
      if (object.owner.kind !== "inventory" || object.owner.actorId !== actorId
          || object.owner.inventoryId !== inventory.id || !inventory.objectIds.includes(id)) {
        reason = "wrong-owner";
      }
    }
    if (reason !== "none") return this.remember(commandId, fingerprint, false, reason, ids);

    const moved = new Set(ids);
    for (const id of ids) {
      this.objects.get(id)!.owner = { kind: "home", homeId };
      if (!homeStorage.includes(id)) homeStorage.push(id);
    }
    inventory.objectIds = inventory.objectIds.filter(id => !moved.has(id));
    homeStorage.sort((a, b) => a.localeCompare(b));
    return this.remember(commandId, fingerprint, true, "none", ids);
  }

  private measure(ids: readonly string[], measure: InventoryMeasure): number {
    return ids.reduce((total, id) => total + (measure === "weight"
      ? this.objects.get(id)?.weight ?? 0 : this.objects.get(id)?.units ?? 0), 0);
  }

  private repeat(commandId: string, fingerprint: string): TransferResult | undefined {
    const prior = this.commands.get(commandId);
    if (!prior) return undefined;
    if (prior.fingerprint !== fingerprint) {
      return { commandId, ok: false, repeated: true, reason: "command-conflict", objectIds: [] };
    }
    return { ...prior.result, repeated: true };
  }

  private remember(commandId: string, fingerprint: string, ok: boolean,
    reason: TransferFailure, objectIds: readonly string[]): TransferResult {
    if (!commandId) return { commandId, ok: false, repeated: false, reason: "command-conflict", objectIds: [] };
    const result: TransferResult = { commandId, ok, repeated: false, reason, objectIds: [...objectIds] };
    this.commands.set(commandId, { fingerprint, result });
    return result;
  }
}

export function createActorInventory(actorId: string, role: RoleKind, capacity?: number): InventoryState {
  const frog = role === "frog";
  const resolvedCapacity = capacity ?? (frog ? 4 : 6);
  if (!actorId) throw new Error("inventory actor id is required");
  if (!validPositive(resolvedCapacity)) throw new RangeError("inventory capacity must be positive");
  return {
    id: `${actorId}:${frog ? "pouch" : "bag"}`,
    actorId,
    kind: frog ? "frog-pouch" : "cleaner-bag",
    measure: frog ? "units" : "weight",
    capacity: resolvedCapacity,
    objectIds: [],
  };
}

export function inventoryLoad(inventory: InventoryState, ledger: ObjectOwnershipLedger): number {
  return inventory.objectIds.reduce((total, id) => {
    const object = ledger.snapshot(id);
    return total + (inventory.measure === "weight" ? object?.weight ?? 0 : object?.units ?? 0);
  }, 0);
}

export function validateInventoryOwnership(inventory: InventoryState, ledger: ObjectOwnershipLedger): boolean {
  if (new Set(inventory.objectIds).size !== inventory.objectIds.length) return false;
  return inventory.objectIds.every(id => {
    const owner = ledger.snapshot(id)?.owner;
    return owner?.kind === "inventory" && owner.inventoryId === inventory.id && owner.actorId === inventory.actorId;
  });
}
