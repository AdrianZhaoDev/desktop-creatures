import { createActorState, requestActorReturnHome, type ActorState } from '../actor-state';
import { AgentCoordinator, type AgentTarget, type ReachabilityProbe } from '../agent-coordinator';
import { advanceCampaign, disposeBag, isPaused, isTerminal, reportActorHome, stepCampaign, type ActorEffect, type ActorPort, type ActorSnapshot, type HousePort, type HouseState, type RunState } from '../campaign-controller';
import { captureObject, createCampaignObject } from '../combat-ecology';
import { DEFAULT_ECOLOGY_PLACEMENT, markEcologyDead } from '../ecology-cycle';
import type { EcologyPlacement } from '../ecology-cycle-types';
import { deriveRunAttributes, recordClean, recordKill } from '../economy';
import { deriveHomeVisualState, homeExitReadiness, requestHomeExit, type HomeRoutineState, type HomeState, type HomeVisualState } from '../homes';
import type { ObjectOwnershipLedger, InventoryState as S07Inventory, ObjectOwnershipSnapshot, OwnedObject, TransferFailure, TransferResult } from '../inventory';
import { addObject, hasKey, inventoryItems, isAutonomousCommandRetired, transferObjects, type InventoryPort, type Receipt } from '../tool-system';

export interface CampaignViewport { widthDip: number; heightDip: number }
export interface HousePresentation extends HouseState { visual: HomeVisualState; residentId: string }
type Reservation = { actorId: string; expiresAtMs: number };
type PlayerObjectDrag = { claimId: string; objectId: string; original: { x: number; y: number; controlRemaining: number; carrierId: string | null } };
export type PlayerObjectDrop = { kind: 'world'; point: { x: number; y: number }; supported: boolean } | { kind: 'bin' };
export interface S07HomeProgress { runId: string; homes: { id: string; visitSequence: number; routine: HomeRoutineState | null }[] }

function validNormalizedPoint(point: { x: number; y: number }): boolean {
  return [point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1);
}

function directlyDraggable(item: { kind: string; hp: number; owner: string }): boolean {
  return item.owner === 'world' && (['trash', 'corpse', 'egg'].includes(item.kind)
    || (item.kind === 'bug' || item.kind === 'elite') && item.hp > 0);
}

function moveDraftCarrierEggs(run: RunState, carrierId: string, point: { x: number; y: number }): void {
  for (const egg of Object.values(run.inventory.objects)) {
    if (egg.owner === 'world' && egg.kind === 'egg' && egg.ecology?.carrierId === carrierId) {
      egg.x = point.x; egg.y = point.y;
    }
  }
}

function clearDraftCarrierEggs(run: RunState, carrierId: string): void {
  for (const egg of Object.values(run.inventory.objects)) {
    if (egg.owner !== 'world' || egg.kind !== 'egg' || egg.ecology?.carrierId !== carrierId) continue;
    egg.owner = 'disposed'; egg.hp = 0; egg.armor = 0; egg.behavior = 'none';
    egg.attackRemaining = 0; egg.controlRemaining = 0;
    Object.assign(egg.ecology, { disposition: 'carrier-cleared', carrierId: null, food: 0,
      energy: 0, mated: false, breedCooldown: 0, wanderRemaining: 0 });
  }
}

export function validateS07HomeProgress(value: unknown, run: RunState | null): S07HomeProgress | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !run) throw new Error('Invalid S07 home progress');
  const progress = value as S07HomeProgress;
  if (Object.keys(progress).sort().join() !== 'homes,runId' || progress.runId !== run.runId || !Array.isArray(progress.homes)
    || progress.homes.length !== run.houses.length || new Set(progress.homes.map(h => h.id)).size !== progress.homes.length) throw new Error('Invalid S07 home progress');
  for (const home of progress.homes) {
    if (!home || Object.keys(home).sort().join() !== 'id,routine,visitSequence' || !run.houses.some(h => h.id === home.id)
      || !Number.isSafeInteger(home.visitSequence) || home.visitSequence < 0) throw new Error('Invalid S07 home visit');
    const routine = home.routine;
    if (routine !== null) {
      const retiredVisit = run.inventory.retired?.homeVisits[home.id];
      if (!routine || Object.keys(routine).sort().join() !== 'actorId,elapsedSeconds,phase,visit'
        || !run.actors.some(a => a.id === routine.actorId && a.houseId === home.id)
        || !['entering', 'resting', 'exiting'].includes(routine.phase) || !Number.isFinite(routine.elapsedSeconds) || routine.elapsedSeconds < 0
        || !Number.isSafeInteger(routine.visit) || routine.visit < 1 || routine.visit !== home.visitSequence
        || (retiredVisit !== undefined && routine.visit <= retiredVisit)) throw new Error('Invalid S07 home routine');
      const actor = run.actors.find(a => a.id === routine.actorId)!;
      if (run.phase !== 'running' || actor.pose.activity !== (routine.phase === 'entering' ? 'entering-home' : routine.phase === 'exiting' ? 'exiting-home' : 'resting')
        || actor.atHome !== (routine.phase !== 'entering')) throw new Error('Conflicting S07 home routine');
    }
  }
  return structuredClone(progress);
}

/** One object table; S07 inventory/home membership is a live view, never a copied ledger.
 * Construct against a transaction draft. The caller must not publish this adapter before commit.
 */
export class S07DomainAdapter implements ActorPort, HousePort {
  readonly actors: ActorState[];
  readonly homes: HomeState[];
  readonly ledger: CampaignOwnershipAdapter;
  readonly coordinator: AgentCoordinator;
  /** Host-verified placement is frame-local terrain evidence. It is deliberately absent
   * from snapshots, home progress and V4 persistence. */
  ecologyPlacement?: EcologyPlacement;
  private presentations: HousePresentation[] = [];

  constructor(readonly run: RunState, readonly viewport: CampaignViewport, homeProgress: S07HomeProgress | null = null) {
    if (![viewport.widthDip, viewport.heightDip].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid campaign viewport');
    this.actors = run.actors.map(saved => {
      if (saved.inventoryId !== (saved.archetype === 'frog' ? 'frogPouch' : 'cleanerPack')) throw new Error('Conflicting canonical actor inventory');
      const actor = createActorState({ id: saved.id, archetype: saved.archetype, appearanceId: saved.pose.appearanceId,
        homeId: saved.houseId, x: saved.pose.x * viewport.widthDip, y: saved.pose.y * viewport.heightDip });
      actor.insideHome = saved.atHome;
      actor.stamina = saved.pose.stamina;
      // Paths and reservations are intentionally reacquired after hydration.
      actor.activity = saved.pose.activity as ActorState['activity'];
      if (['travelling', 'working'].includes(actor.activity)) actor.activity = 'idle';
      Object.assign(actor.body, { vx: saved.pose.vx * viewport.widthDip, vy: saved.pose.vy * viewport.heightDip, motion: saved.pose.motion });
      Object.defineProperty(actor.inventory, 'objectIds', { enumerable: true, get: () => inventoryItems(run.inventory, saved.inventoryId).map(item => item.id).sort() });
      Object.defineProperty(actor.inventory, 'capacity', { enumerable: true, get: () => {
        const attributes = deriveRunAttributes(run.upgrades, run.researchNodes);
        return actor.archetype === 'frog' ? attributes.frogCapacity : attributes.cleanerCapacity;
      } });
      return actor;
    });
    const restoredHomes = validateS07HomeProgress(homeProgress, run);
    this.homes = run.houses.map(house => {
      const actor = this.actors.find(a => a.homeId === house.id);
      if (!actor) throw new Error('Missing S07 resident');
      const home: HomeState = { id: house.id, kind: actor.archetype === 'frog' ? 'frog-home' : 'cleaner-home', residentId: actor.id,
        maxHp: 1000, hp: 1000, visual: 'intact', x: house.x * viewport.widthDip, y: house.y * viewport.heightDip,
        placementLocked: house.locked, storageObjectIds: [], visitSequence: 0 };
      Object.defineProperty(home, 'storageObjectIds', { enumerable: true, get: () => inventoryItems(run.inventory, home.id).map(item => item.id).sort() });
      const saved = restoredHomes?.homes.find(h => h.id === home.id);
      if (saved) { home.visitSequence = saved.visitSequence; home.routine = saved.routine ? { ...saved.routine } : undefined; }
      const retiredVisit = run.inventory.retired?.homeVisits[home.id];
      if (retiredVisit !== undefined) {
        if (!Number.isSafeInteger(retiredVisit) || retiredVisit < 0) throw new Error('Invalid retired home visit');
        home.visitSequence = Math.max(home.visitSequence, retiredVisit);
      }
      // A plain V4 import has no home routine metadata. Recover the issued visit floor
      // from canonical command receipts so the next visit never reuses an unload ID.
      for (const commandId of Object.keys(run.inventory.commands)) {
        const prefix = `${home.id}:visit:`;
        if (commandId.startsWith(prefix) && commandId.endsWith(':unload')) {
          let signature: unknown;
          try { signature = JSON.parse(run.inventory.commands[commandId].signature); } catch { continue; }
          if (!Array.isArray(signature) || signature[0] !== 's07-domain' || signature[1] !== 'unload' || signature[4] !== home.id) continue;
          const visit = Number(commandId.slice(prefix.length, -':unload'.length));
          if (!Number.isSafeInteger(visit) || visit < 1) throw new Error('Invalid home visit receipt');
          home.visitSequence = Math.max(home.visitSequence, visit);
        }
      }
      if (!home.routine && run.phase === 'running' && (actor.insideHome || actor.activity === 'entering-home')) {
        const entering = !actor.insideHome;
        if (entering || home.visitSequence === 0) {
          if (home.visitSequence === Number.MAX_SAFE_INTEGER) throw new Error('Home visit sequence exhausted');
          home.visitSequence++;
        }
        home.routine = { actorId: actor.id, phase: entering ? 'entering' : actor.activity === 'exiting-home' ? 'exiting' : 'resting', elapsedSeconds: 0, visit: home.visitSequence };
      }
      if (actor.insideHome) { actor.body.x = home.x; actor.body.y = home.y; actor.body.vx = 0; actor.body.vy = 0; }
      return home;
    });
    this.ledger = new CampaignOwnershipAdapter(this);
    // Existing S07 constructor names a nominal class with private members. This adapter
    // implements its complete public contract, without constructing its private maps.
    this.coordinator = new AgentCoordinator(this.s07Ledger);
    this.present(run.houses);
    for (const actor of this.actors) {
      const house = run.houses.find(h => h.id === actor.homeId)!;
      if (house.hp <= 0) this.apply({ type: 'disabled', actorId: actor.id, houseId: house.id });
      else if (actor.insideHome && run.phase !== 'running') this.apply({ type: 'safe-home', actorId: actor.id, houseId: house.id });
      else if (run.phase === 'retreat') this.apply({ type: 'retreat', actorId: actor.id, houseId: house.id });
    }
  }
  get s07Ledger(): ObjectOwnershipLedger { return this.ledger as unknown as ObjectOwnershipLedger; }
  homeProgress(): S07HomeProgress {
    return { runId: this.run.runId, homes: this.homes.map(home => ({ id: home.id, visitSequence: home.visitSequence, routine: home.routine ? { ...home.routine } : null })) };
  }

  snapshot(): ActorSnapshot[] {
    return this.actors.map(actor => ({ id: actor.id, archetype: actor.archetype,
      inventoryId: this.domainInventory(actor.id), houseId: actor.homeId, atHome: actor.insideHome,
      pose: { x: actor.body.x / this.viewport.widthDip, y: actor.body.y / this.viewport.heightDip,
        vx: actor.body.vx / this.viewport.widthDip, vy: actor.body.vy / this.viewport.heightDip,
        stamina: actor.stamina, appearanceId: actor.appearanceId, activity: actor.activity,
        motion: actor.body.motion, taskId: actor.task?.targetId ?? null } }));
  }

  domainInventory(actorId: string): string {
    const saved = this.run.actors.find(actor => actor.id === actorId);
    if (!saved) throw new Error('Unknown actor');
    return saved.inventoryId;
  }

  apply(effect: ActorEffect): void {
    const actor = this.actors.find(value => value.id === effect.actorId);
    const home = this.homes.find(value => value.id === effect.houseId);
    if (!actor || !home || actor.homeId !== home.id || home.residentId !== actor.id) throw new Error('Conflicting actor effect');
    this.coordinator.releaseActor(actor);
    this.ledger.releaseActorReservations(actor.id);
    actor.task = undefined;
    home.placementLocked = true;
    if (effect.type === 'retreat') { home.routine = undefined; requestActorReturnHome(actor); return; }
    actor.body.x = home.x; actor.body.y = home.y; actor.body.vx = 0; actor.body.vy = 0;
    actor.body.support = undefined; actor.body.grip = undefined; actor.body.dropThrough = undefined; actor.body.releasedGrip = undefined;
    actor.body.motion = 'walking'; actor.insideHome = true;
    actor.activity = effect.type === 'disabled' || this.run.houses.find(h => h.id === home.id)!.hp <= 0 ? 'unavailable' : 'resting';
    home.routine = undefined;
  }

  present(houses: readonly HouseState[]): void {
    if (houses.length !== this.homes.length || new Set(houses.map(h => h.id)).size !== houses.length) throw new Error('Conflicting houses');
    this.presentations = houses.map(house => {
      const home = this.homes.find(value => value.id === house.id);
      if (!home) throw new Error('Unknown house');
      home.placementLocked = house.locked;
      return { ...house, residentId: home.residentId, visual: deriveHomeVisualState(house) };
    });
  }
  houseSnapshot(): HousePresentation[] { return structuredClone(this.presentations); }

  /** S07 owns pose/home/inventory identities; S11 owns damage and terminal state. */
  flush(): void {
    for (const actor of this.actors) {
      if (actor.task) {
        const target = hasKey(this.run.inventory.objects, actor.task.targetId) ? this.run.inventory.objects[actor.task.targetId] : undefined;
        if (!target || target.owner !== 'world' || (actor.archetype === 'frog' ? target.kind !== 'bug' : !['trash', 'corpse', 'egg'].includes(target.kind))) {
          this.coordinator.releaseActor(actor); this.ledger.releaseActorReservations(actor.id);
          actor.task = undefined;
          if (actor.activity === 'working' || actor.activity === 'travelling') actor.activity = 'idle';
        }
      }
      if (actor.inventory.objectIds.length !== new Set(actor.inventory.objectIds).size) throw new Error('Duplicate S07 inventory');
      const items = inventoryItems(this.run.inventory, this.domainInventory(actor.id));
      const load = actor.inventory.measure === 'units' ? items.length : items.reduce((n, item) => n + item.weight, 0);
      if (load > actor.inventory.capacity) throw new Error('S07 inventory capacity exceeded');
      this.run.inventory.containers[this.domainInventory(actor.id)].capacity = actor.inventory.capacity;
    }
    this.run.actors = this.snapshot();
    for (const home of this.homes) {
      if (this.run.phase !== 'running') home.routine = undefined;
      const house = this.run.houses.find(h => h.id === home.id)!;
      house.x = home.x / this.viewport.widthDip;
      // S07 home y is immutable and supplied by the hydrated battlefield.
      house.y = home.y / this.viewport.heightDip;
    }
  }

  coordinate(targets: readonly AgentTarget[], canReach: ReachabilityProbe): ReturnType<AgentCoordinator['coordinate']> {
    if (this.run.phase !== 'running' || isPaused(this.run)) return { assigned: [], releasedTargetIds: [], returningHomeActorIds: [] };
    return this.coordinator.coordinate(this.actors.filter(a => a.archetype !== 'frog' || this.run.frogUnlocked), targets, this.run.tick * 1000 / 60, canReach);
  }

  arriveHome(commandId: string, actorId: string): Receipt {
    const actor = this.actors.find(a => a.id === actorId);
    if (!actor) return { signature: '', ok: false, reason: 'missing-actor' };
    const home = this.homes.find(h => h.id === actor.homeId)!;
    return this.ledger.command(commandId, ['arrive-home', actorId], draft => {
      if (isPaused(draft) || isTerminal(draft) || !['running', 'retreat'].includes(draft.phase)) return 'campaign-frozen';
      if (draft.phase === 'running' && home.visitSequence === Number.MAX_SAFE_INTEGER) return 'home-visit-exhausted';
      if (Math.hypot(actor.body.x - home.x, actor.body.y - home.y) > 18) return 'not-at-entrance';
      const items = inventoryItems(draft.inventory, this.domainInventory(actorId)).map(item => item.id);
      if (draft.phase === 'retreat') return reportActorHome(draft, JSON.stringify([commandId, 'home']), actorId).reason === 'ok' ? null : 'home-transfer';
      return items.length ? transferObjects(draft.inventory, JSON.stringify([commandId, 'unload']), items, this.domainInventory(actorId), home.id).reason === 'ok' ? null : 'home-transfer' : null;
    }, () => {
      this.apply({ type: 'safe-home', actorId, houseId: home.id });
      if (this.run.phase === 'running') {
        home.routine = { actorId, phase: 'resting', elapsedSeconds: 0, visit: ++home.visitSequence };
      }
    });
  }

  /** Request the resident through the same receipt-backed domain transaction as other S07 actions. */
  callResidentOut(commandId: string, houseId: string): Receipt {
    const signature = JSON.stringify(['s07-domain', 'call-resident-out', houseId]);
    const home = this.homes.find(candidate => candidate.id === houseId);
    const actor = home && this.actors.find(candidate => candidate.id === home.residentId);
    if (!home || !actor || actor.homeId !== home.id) return { signature, ok: false, reason: 'wrong-house' };
    return this.ledger.command(commandId, ['call-resident-out', houseId], draft => {
      if (draft.phase !== 'running' || isPaused(draft) || isTerminal(draft)) return 'campaign-frozen';
      const savedHouse = draft.houses.find(candidate => candidate.id === houseId);
      const savedActor = draft.actors.find(candidate => candidate.id === actor.id);
      if (!savedHouse || !savedActor || savedActor.houseId !== houseId) return 'wrong-house';
      if (savedHouse.hp <= 0 || savedActor.pose.activity === 'unavailable' || actor.activity === 'unavailable') return 'house-destroyed';
      const readiness = homeExitReadiness(actor, home);
      if (readiness.status === 'waiting') return 'home-entry-pending';
      if (readiness.status === 'blocked') return readiness.reason ?? 'invalid-state';
      return null;
    }, () => { requestHomeExit(actor, home); });
  }

  /** Begin a direct mouse claim. The claim itself is adapter-local; releasing an actor
   * assignment is flushed through the enclosing Session command boundary. */
  beginPlayerObjectDrag(claimId: string, objectId: string): Receipt {
    const signature = JSON.stringify(['s07-domain', 'begin-player-object-drag', claimId, objectId]);
    if (!claimId || !objectId) return { signature, ok: false, reason: 'invalid-command' };
    if (this.run.phase !== 'running' || isPaused(this.run) || isTerminal(this.run)) return { signature, ok: false, reason: 'campaign-frozen' };
    if (!hasKey(this.run.inventory.objects, objectId)) return { signature, ok: false, reason: 'object-missing' };
    const item = this.run.inventory.objects[objectId];
    if (!directlyDraggable(item)) {
      return { signature, ok: false, reason: 'not-draggable' };
    }
    if (!this.ledger.claimForPlayer(claimId, objectId)) return { signature, ok: false, reason: 'object-claimed' };
    for (const actor of this.actors) if (actor.task?.targetId === objectId) {
      this.coordinator.releaseActor(actor); this.ledger.releaseActorReservations(actor.id); actor.task = undefined;
      if (actor.activity === 'travelling' || actor.activity === 'working') actor.activity = 'idle';
    }
    this.ledger.releaseObjectReservation(objectId);
    return { signature, ok: true, reason: 'ok' };
  }

  /** Move only the claimed canonical object. Input supplies normalized viewport points;
   * carrier eggs follow immediately so presentation and persistence never disagree. */
  movePlayerObjectDrag(claimId: string, objectId: string, point: { x: number; y: number }): boolean {
    if (!this.ledger.playerClaimMatches(claimId, objectId) || !validNormalizedPoint(point)
      || !hasKey(this.run.inventory.objects, objectId)) return false;
    const item = this.run.inventory.objects[objectId];
    if (item.owner !== 'world') return false;
    item.x = point.x; item.y = point.y;
    if (item.kind === 'egg' && item.ecology) item.ecology.carrierId = null;
    this.moveCarrierEggs(objectId, point);
    return true;
  }

  cancelPlayerObjectDrag(claimId: string, objectId: string): boolean {
    const claim = this.ledger.playerClaim(claimId, objectId);
    if (!claim || !hasKey(this.run.inventory.objects, objectId)) return false;
    const item = this.run.inventory.objects[objectId];
    if (item.owner === 'world') {
      Object.assign(item, { x: claim.original.x, y: claim.original.y, controlRemaining: claim.original.controlRemaining });
      if (item.ecology) item.ecology.carrierId = claim.original.carrierId;
      this.moveCarrierEggs(objectId, claim.original);
    }
    this.ledger.releasePlayerClaim(claimId, objectId);
    return true;
  }

  /** Commit the final supported point or an atomic kill/clean at the trash bin. */
  dropPlayerObject(commandId: string, claimId: string, objectId: string, destination: PlayerObjectDrop): Receipt {
    return this.ledger.command(commandId, ['drop-player-object', claimId, objectId, destination], draft => {
      if (draft.phase !== 'running' || isPaused(draft) || isTerminal(draft)) return 'campaign-frozen';
      if (!this.ledger.playerClaimMatches(claimId, objectId)) return 'not-player-claimed';
      if (!hasKey(draft.inventory.objects, objectId)) return 'object-missing';
      const item = draft.inventory.objects[objectId];
      if (!directlyDraggable(item)) return 'not-draggable';
      if (destination.kind === 'world') {
        if (!destination.supported || !validNormalizedPoint(destination.point)) return 'unsupported-drop';
        item.x = destination.point.x; item.y = destination.point.y;
        if (item.kind === 'egg' && item.ecology) item.ecology.carrierId = null;
        moveDraftCarrierEggs(draft, objectId, destination.point);
        return null;
      }
      if (destination.kind !== 'bin') return 'invalid-drop';
      if (item.kind === 'bug' || item.kind === 'elite') {
        const reward = item.kind === 'elite' ? 'elite' : 'normal';
        if (!recordKill(draft.economy, item.id, reward)) return 'reward-conflict';
        item.kind = 'corpse'; item.hp = 0; item.behavior = 'none'; item.armor = 0;
        item.attackRemaining = 0; item.controlRemaining = 0; item.pollution = Math.max(0.5, item.pollution);
        markEcologyDead(item);
      }
      if (!recordClean(draft.economy, item.id, item.weight, item.cleanValue)) return 'reward-conflict';
      if (item.ecology) item.ecology.carrierId = null;
      item.owner = 'disposed';
      draft.ecology.pollution = Math.max(0, draft.ecology.pollution - item.weight * 2);
      clearDraftCarrierEggs(draft, objectId);
      return null;
    }, () => { this.ledger.releasePlayerClaim(claimId, objectId); });
  }

  cancelAllPlayerObjectDrags(): void {
    for (const claim of this.ledger.playerClaims()) this.cancelPlayerObjectDrag(claim.claimId, claim.objectId);
  }

  /** Persistence can sanitize its detached clone without interrupting the live pointer.
   * A restart resumes the last committed supported point, never a mid-air move sample. */
  restorePlayerObjectDragsForSnapshot(snapshot: RunState): void {
    if (snapshot.runId !== this.run.runId) throw new Error('Player drag snapshot belongs to another run');
    for (const claim of this.ledger.playerClaims()) {
      if (!hasKey(snapshot.inventory.objects, claim.objectId)) continue;
      const item = snapshot.inventory.objects[claim.objectId];
      if (item.owner !== 'world') continue;
      Object.assign(item, { x: claim.original.x, y: claim.original.y, controlRemaining: claim.original.controlRemaining });
      if (item.ecology) item.ecology.carrierId = claim.original.carrierId;
      moveDraftCarrierEggs(snapshot, claim.objectId, claim.original);
    }
  }

  private moveCarrierEggs(carrierId: string, point: { x: number; y: number }): void {
    moveDraftCarrierEggs(this.run, carrierId, point);
  }

  private ecologyPlacementWithClaims(): EcologyPlacement | undefined {
    const frozenObjectIds = this.ledger.frozenEcologyIds();
    if (!frozenObjectIds.length) return this.ecologyPlacement;
    return { ...(this.ecologyPlacement ?? DEFAULT_ECOLOGY_PLACEMENT), frozenObjectIds };
  }

  step(): ActorEffect[] {
    this.flush();
    const effects = stepCampaign(this.run, this.viewport, this.ecologyPlacementWithClaims());
    for (const effect of effects) this.apply(effect);
    this.present(this.run.houses); this.flush();
    return effects;
  }
  advance(elapsedSeconds: number, remainder = 0): ReturnType<typeof advanceCampaign> {
    this.flush();
    const result = advanceCampaign(this.run, elapsedSeconds, remainder, this.viewport, this.ecologyPlacementWithClaims());
    for (const effect of result.effects) this.apply(effect);
    this.present(this.run.houses); this.flush();
    return result;
  }
}

/** Implements the complete S07 public contract so the unchanged AgentCoordinator can consume it.
 * Reservations are transient claims on world objects, not a second owner table.
 */
export class CampaignOwnershipAdapter implements Pick<ObjectOwnershipLedger, keyof ObjectOwnershipLedger>, InventoryPort {
  private readonly reservations = new Map<string, Reservation>();
  private readonly directDrags = new Map<string, PlayerObjectDrag>();
  constructor(private readonly adapter: S07DomainAdapter) {}
  private get run(): RunState { return this.adapter.run; }
  register(object: OwnedObject): void {
    if (object.units !== 1) throw new Error('Register individual object IDs; aggregated units are unsupported');
    const kind = object.kind === 'residue' ? 'corpse' : object.kind;
    if (!['trash', 'egg', 'bug', 'elite', 'nest', 'corpse'].includes(kind)) throw new Error('Unknown campaign object kind');
    addObject(this.run.inventory, { ...createCampaignObject(object.id, kind as 'trash'), weight: object.weight });
  }
  snapshot(id: string): ObjectOwnershipSnapshot | undefined {
    if (!hasKey(this.run.inventory.objects, id)) return undefined;
    const item = this.run.inventory.objects[id];
    const base = { id, kind: item.kind === 'corpse' ? 'residue' : item.kind, units: 1, weight: item.weight };
    if (item.owner === 'world') {
      const direct = this.directDrags.get(id);
      if (direct) return { ...base, owner: { kind: 'reserved', actorId: `player:${direct.claimId}`, expiresAtMs: Number.MAX_SAFE_INTEGER } };
      const reservation = this.reservations.get(id);
      return { ...base, owner: reservation ? { kind: 'reserved', ...reservation } : { kind: 'world' } };
    }
    const actor = this.adapter.actors.find(a => this.adapter.domainInventory(a.id) === item.owner);
    if (actor) return { ...base, owner: { kind: 'inventory', actorId: actor.id, inventoryId: actor.inventory.id } };
    if (this.adapter.homes.some(home => home.id === item.owner)) return { ...base, owner: { kind: 'home', homeId: item.owner } };
    // S07 has no bag/trap/disposed owner variant. Omit these objects from its work view.
    return undefined;
  }
  snapshots(): ObjectOwnershipSnapshot[] { return Object.keys(this.run.inventory.objects).sort().flatMap(id => { const value = this.snapshot(id); return value ? [value] : []; }); }
  reserve(id: string, actorId: string, _nowMs: number, expiresAtMs: number): boolean {
    const nowMs = this.run.tick * 1000 / 60;
    this.releaseExpiredReservations(nowMs);
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs
      || this.run.phase !== 'running' || isPaused(this.run) || !this.adapter.actors.some(a => a.id === actorId && !a.insideHome && a.activity !== 'unavailable')
      || this.directDrags.has(id) || !hasKey(this.run.inventory.objects, id) || this.run.inventory.objects[id].owner !== 'world') return false;
    const prior = this.reservations.get(id);
    if (prior && prior.actorId !== actorId) return false;
    this.reservations.set(id, { actorId, expiresAtMs }); return true;
  }
  releaseReservation(id: string, actorId: string): boolean {
    return this.reservations.get(id)?.actorId === actorId && this.reservations.delete(id);
  }
  releaseActorReservations(actorId: string): void { for (const [id, claim] of this.reservations) if (claim.actorId === actorId) this.reservations.delete(id); }
  releaseObjectReservation(id: string): void { this.reservations.delete(id); }
  claimForPlayer(claimId: string, objectId: string): boolean {
    if ([...this.directDrags.values()].some(claim => claim.claimId === claimId || claim.objectId === objectId)
      || !hasKey(this.run.inventory.objects, objectId) || this.run.inventory.objects[objectId].owner !== 'world') return false;
    const item = this.run.inventory.objects[objectId];
    this.directDrags.set(objectId, { claimId, objectId, original: { x: item.x, y: item.y,
      controlRemaining: item.controlRemaining, carrierId: item.ecology?.carrierId ?? null } });
    return true;
  }
  playerClaimMatches(claimId: string, objectId: string): boolean { return this.directDrags.get(objectId)?.claimId === claimId; }
  playerClaim(claimId: string, objectId: string): PlayerObjectDrag | undefined {
    const claim = this.directDrags.get(objectId);
    return claim?.claimId === claimId ? claim : undefined;
  }
  playerClaims(): PlayerObjectDrag[] { return [...this.directDrags.values()]; }
  releasePlayerClaim(claimId: string, objectId: string): boolean {
    return this.directDrags.get(objectId)?.claimId === claimId && this.directDrags.delete(objectId);
  }
  frozenEcologyIds(): string[] {
    if (!this.directDrags.size) return [];
    const carriers = new Set(this.directDrags.keys());
    return Object.values(this.run.inventory.objects).filter(item => carriers.has(item.id)
      || item.kind === 'egg' && !!item.ecology?.carrierId && carriers.has(item.ecology.carrierId)).map(item => item.id).sort();
  }
  releaseExpiredReservations(_nowMs: number): string[] {
    const nowMs = this.run.tick * 1000 / 60;
    const released: string[] = [];
    if (!Number.isFinite(nowMs)) return released;
    for (const [id, claim] of this.reservations) if (claim.expiresAtMs <= nowMs || this.run.inventory.objects[id]?.owner !== 'world') { this.reservations.delete(id); released.push(id); }
    return released.sort();
  }

  /** Whole-run rollback includes kill/clean economics. All operations share domain command IDs. */
  command(commandId: string, fields: unknown[], action: (draft: RunState) => string | null, committed?: () => void): Receipt {
    const signature = JSON.stringify(['s07-domain', ...fields]);
    if (!commandId) return { signature, ok: false, reason: 'invalid-command' };
    const prior = hasKey(this.run.inventory.commands, commandId) ? this.run.inventory.commands[commandId] : undefined;
    if (prior) return prior.signature === signature ? { ...prior } : { signature, ok: false, reason: 'command-conflict' };
    if (isAutonomousCommandRetired(this.run.inventory, commandId)) return { signature, ok: false, reason: 'command-expired' };
    const draft = structuredClone(this.run);
    const reason = action(draft);
    const receipt = { signature, ok: reason === null, reason: reason ?? 'ok' };
    if (reason === null) Object.assign(this.run, draft);
    Object.defineProperty(this.run.inventory.commands, commandId, { value: receipt, enumerable: true, writable: true, configurable: true });
    if (receipt.ok) committed?.();
    return { ...receipt };
  }

  transfer(commandId: string, ids: string[], from: string, to: string): Receipt {
    const alias = (id: string) => { const actor = this.adapter.actors.find(a => a.inventory.id === id); return actor ? this.adapter.domainInventory(actor.id) : id; };
    return this.command(commandId, ['transfer', ids, from, to], draft => {
      if (isPaused(draft) || isTerminal(draft) || draft.phase === 'preparation') return 'campaign-frozen';
      if (ids.some(id => this.directDrags.has(id))) return 'object-claimed';
      const dest = alias(to), actor = this.adapter.actors.find(a => this.adapter.domainInventory(a.id) === dest);
      if (actor && actor.inventory.measure === 'units' && inventoryItems(draft.inventory, dest).length + ids.length > actor.inventory.capacity) return 'capacity-exceeded';
      const receipt = transferObjects(draft.inventory, JSON.stringify([commandId, 'transfer']), ids, alias(from), dest);
      return receipt.ok ? null : receipt.reason;
    }, () => { for (const id of ids) this.reservations.delete(id); });
  }

  pickup(commandId: string, actorId: string, inventory: S07Inventory, objectIds: readonly string[], _nowMs: number): TransferResult {
    const nowMs = this.run.tick * 1000 / 60;
    const ids = [...objectIds].sort(), repeated = hasKey(this.run.inventory.commands, commandId);
    const actor = this.adapter.actors.find(a => a.id === actorId);
    const receipt = this.command(commandId, ['pickup', actorId, inventory.id, ids], draft => {
      if (draft.phase !== 'running' || isPaused(draft) || !actor || actor.insideHome || actor.activity === 'unavailable') return 'not-reserved';
      if (inventory !== actor.inventory || inventory.actorId !== actorId) return 'wrong-owner';
      if (!ids.length) return 'object-missing';
      if (new Set(ids).size !== ids.length) return 'duplicate-object';
      if (ids.some(id => this.directDrags.has(id))) return 'not-reserved';
      if (!Number.isFinite(nowMs)) return 'not-reserved';
      for (const id of ids) {
        const claim = this.reservations.get(id);
        if (!hasKey(draft.inventory.objects, id)) return 'object-missing';
        if (claim && claim.expiresAtMs <= nowMs) return 'reservation-expired';
        if (!claim || claim.actorId !== actorId || draft.inventory.objects[id].owner !== 'world') return 'not-reserved';
      }
      const destination = this.adapter.domainInventory(actorId), current = inventoryItems(draft.inventory, destination);
      const incoming = ids.map(id => draft.inventory.objects[id]);
      if ((inventory.measure === 'units' ? current.length + incoming.length : [...current, ...incoming].reduce((n, item) => n + item.weight, 0)) > inventory.capacity) return 'capacity-exceeded';
      if (actor.archetype === 'frog') {
        if (!draft.frogUnlocked || incoming.some(item => item.kind !== 'bug')) return 'wrong-owner';
        for (const id of ids) {
          const result = captureObject(draft.inventory, JSON.stringify([commandId, 'capture', id]), id, destination, { kill: (target, kind) => { recordKill(draft.economy, target, kind); } });
          if (!result.ok) return 'wrong-owner';
        }
      } else if (!transferObjects(draft.inventory, JSON.stringify([commandId, 'pickup']), ids, 'world', destination).ok) return 'wrong-owner';
      return null;
    }, () => { for (const id of ids) this.reservations.delete(id); });
    this.releaseExpiredReservations(nowMs);
    return this.toS07(commandId, receipt, ids, repeated);
  }
  unload(commandId: string, actorId: string, inventory: S07Inventory, homeId: string, _homeStorage: string[], objectIds: readonly string[] = inventory.objectIds): TransferResult {
    const ids = [...objectIds].sort(), repeated = hasKey(this.run.inventory.commands, commandId);
    const receipt = this.command(commandId, ['unload', actorId, inventory.id, homeId, ids], draft => {
      const actor = this.adapter.actors.find(a => a.id === actorId);
      if (!actor || inventory !== actor.inventory || actor.homeId !== homeId) return 'wrong-owner';
      if (isPaused(draft) || isTerminal(draft)) return 'wrong-owner';
      if (new Set(ids).size !== ids.length) return 'duplicate-object';
      if (!ids.length) return null;
      const result = transferObjects(draft.inventory, JSON.stringify([commandId, 'unload']), ids, this.adapter.domainInventory(actorId), homeId);
      if (!result.ok) return 'wrong-owner';
      if (draft.ecology.cycleVersion === 2 && actor.archetype === 'cleaner') {
        const disposed = disposeBag(draft, JSON.stringify([commandId, 'dispose']), true, homeId);
        if (!disposed.ok) return disposed.reason;
      }
      return null;
    });
    return this.toS07(commandId, receipt, ids, repeated);
  }
  private toS07(commandId: string, receipt: Receipt, ids: string[], repeated: boolean): TransferResult {
    return { commandId, ok: receipt.ok, repeated, reason: receipt.ok ? 'none' : receipt.reason === 'invalid-command' ? 'command-conflict' : receipt.reason as TransferFailure, objectIds: ids };
  }
}
