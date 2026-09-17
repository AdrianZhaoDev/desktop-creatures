import { requestActorReturnHome, stepActorStamina, type ActorState } from '../actor-state';
import type { AgentTarget } from '../agent-coordinator';
import { FIXED_STEP, isPaused, isTerminal } from '../campaign-controller';
import { ECOLOGY_CYCLE } from '../ecology-cycle-types';
import { deriveRunAttributes, type RunAttributes } from '../economy';
import { beginHomeEntry, stepHomeRoutine } from '../homes';
import type { S07DomainAdapter } from '../integration/s07-domain-adapter';
import { CLEANER_PROFILE, FROG_PROFILE, type MovementProfile } from '../movement';
import { NavigationController, type NavigationTarget } from '../navigation';
import { livePlatforms, stepActor } from '../physics';
import { withScreenBoundaries } from '../screen-boundaries';
import type { SurfaceSnapshotV2 } from '../surface';
import { canonicalById, canonicalObjects, hasKey, inventoryLoad, type CampaignObject } from '../tool-system';
import { approach, canWork, standing, type TongueOccluder } from './geometry';
import { EcologyPlacementPlanner } from './ecology-placement';

export type AgentStrategy = 'clean' | 'nearHome'
  /** @deprecated Reserved for a future combat interface; currently falls back to clean. */
  | 'elite'
  /** @deprecated Reserved for a future maintenance interface; currently falls back to clean. */
  | 'maintenance';
export interface CampaignAgentInput {
  surface: SurfaceSnapshotV2 | null;
  /** Host observation time in the same epoch as surface verified/expiry timestamps. */
  surfaceNowMs: number;
  strategyByActor?: Readonly<Record<string, AgentStrategy>>;
  /** [] explicitly certifies no opaque/non-capturable region; omitted fails closed. */
  tongueOccluders?: readonly TongueOccluder[];
}
export interface AgentDiagnostic { code: string; actorId?: string; targetId?: string }
export interface CampaignAgentStepResult { stepped: boolean; pauseSuggested: boolean; diagnostics: AgentDiagnostic[] }
export interface CampaignAgentDriverOptions {
  readInput?: () => CampaignAgentInput;
  /** Synchronous notification. The host owns applying surface pause to the session. */
  onResult?: (result: CampaignAgentStepResult) => void;
}
interface TransientActor {
  navigator: NavigationController;
  profileKey: string;
  targetId?: string;
  goal?: NavigationTarget;
  targetPosition?: { x: number; y: number };
  cleanSeconds: number;
  nextTongueAtMs: number;
  lastProgressAtMs: number;
  progressPoint?: { x: number; y: number };
  homeFailures: number;
  homeRetryAtMs: number;
  candidateCursor: number;
  patrolDirection?: -1 | 1;
  recoveryAnchor?: { x: number; y: number };
  recoveryAtMs?: number;
  recoveryLevel?: number;
  recoveryOrigin?: { x: number; y: number };
}

/** Injectable live-session hook. Never retains an adapter, actor, RunState, InventoryState,
 * or canonical object. Only navigation/timing state survives calls. The session alone ticks
 * the domain and commits/checkpoints; this driver does no digestion, residue or rewards. */
export class CampaignAgentDriver {
  private input?: CampaignAgentInput;
  private readonly identities = new WeakMap<S07DomainAdapter, number>();
  private identitySequence = 0;
  private activeIdentity = -1;
  private lastTick = -1;
  private nextCoordinateTick = 0;
  private surfaceClockMs = -Infinity;
  private coordinateCount = 0;
  private readonly states = new Map<string, TransientActor>();
  private readonly placementPlanner = new EcologyPlacementPlanner();
  private placementKey?: string;
  private playerHeldIds = new Set<string>();

  constructor(private readonly options: CampaignAgentDriverOptions = {}) {}
  setInput(input: CampaignAgentInput): void { this.input = input; }
  /** Call for explicit hydration/reset. A replacement adapter also resets automatically. */
  reset(): void {
    this.activeIdentity = -1; this.lastTick = -1; this.nextCoordinateTick = 0;
    this.surfaceClockMs = -Infinity; this.coordinateCount = 0; this.states.clear();
    this.placementPlanner.reset(); this.placementKey = undefined;
    this.playerHeldIds.clear();
  }
  snapshot() {
    return { lastTick: this.lastTick, coordinateCount: this.coordinateCount,
      placementPlanningCount: this.placementPlanner.planningCount,
      actors: [...this.states.entries()].map(([actorId, state]) => ({ actorId, targetId: state.targetId,
        cleanSeconds: state.cleanSeconds, nextTongueAtMs: state.nextTongueAtMs,
        navigationStatus: state.navigator.status, planningCount: state.navigator.planningCount,
        homeFailures: state.homeFailures, homeRetryAtMs: state.homeRetryAtMs })) };
  }

  readonly beforeDomainStep = (adapter: S07DomainAdapter, seconds: number): CampaignAgentStepResult => {
    const result = this.step(adapter, seconds);
    this.options.onResult?.(result);
    return result;
  };

  private step(adapter: S07DomainAdapter, seconds: number): CampaignAgentStepResult {
    const result: CampaignAgentStepResult = { stepped: false, pauseSuggested: false, diagnostics: [] };
    const diagnose = (code: string, actorId?: string, targetId?: string) => {
      if (!result.diagnostics.some(d => d.code === code && d.actorId === actorId && d.targetId === targetId)) result.diagnostics.push({ code, actorId, targetId });
    };
    if (!Number.isFinite(seconds) || Math.abs(seconds - FIXED_STEP) > 1e-10) { diagnose('invalid-fixed-step'); return result; }
    if (isPaused(adapter.run) || isTerminal(adapter.run) || adapter.run.phase === 'preparation') return result;
    const input = this.options.readInput?.() ?? this.input;
    let identity = this.identities.get(adapter);
    if (identity === undefined) { identity = ++this.identitySequence; this.identities.set(adapter, identity); }
    if (identity !== this.activeIdentity || adapter.run.tick < this.lastTick) {
      this.reset(); this.activeIdentity = identity;
      // Existing adapters may be deliberately reset; clear their old transient claims too.
      for (const actor of adapter.actors) { adapter.coordinator.releaseActor(actor); adapter.ledger.releaseActorReservations(actor.id); }
    }
    if (adapter.run.tick === this.lastTick) { diagnose('duplicate-tick'); return result; }
    const nowMs = adapter.run.tick * 1000 / 60;
    const surfaceNowMs = Math.max(input?.surfaceNowMs ?? NaN,
      this.surfaceClockMs + Math.max(0, adapter.run.tick - this.lastTick) * 1000 / 60);
    const raw = input?.surface;
    if (!raw || !raw.valid || !validSurface(raw) || !Number.isFinite(surfaceNowMs)
      || surfaceNowMs < raw.verifiedAtMs || surfaceNowMs - raw.verifiedAtMs > 1000
      || raw.width !== adapter.viewport.widthDip || raw.height !== adapter.viewport.heightDip) {
      result.pauseSuggested = true;
      adapter.ecologyPlacement = { points: [], floorY: 1,
        widthDip: adapter.viewport.widthDip, heightDip: adapter.viewport.heightDip };
      diagnose(!raw ? 'surface-missing' : !raw.valid || !validSurface(raw) ? 'surface-invalid'
        : raw.width !== adapter.viewport.widthDip || raw.height !== adapter.viewport.heightDip ? 'viewport-rebuild-required' : 'surface-stale');
      for (const actor of adapter.actors) { this.release(adapter, actor); }
      // Do not accept stale terrain or advance work/stamina/navigation while the host pauses.
      return result;
    }
    this.lastTick = adapter.run.tick; this.surfaceClockMs = surfaceNowMs;
    // Convert absolute segment deadlines into logical time for physics/nav. Neither clock is
    // read locally; logical timers remain frozen over user pause, capture health does not.
    const surface: SurfaceSnapshotV2 = { ...raw,
      platforms: raw.platforms.map(p => ({ ...p, expiresAtMs: p.expiresAtMs === undefined ? undefined : nowMs + p.expiresAtMs - surfaceNowMs })),
      grips: raw.grips.map(g => ({ ...g, expiresAtMs: g.expiresAtMs === undefined ? undefined : nowMs + g.expiresAtMs - surfaceNowMs })) };
    const attributes = deriveRunAttributes(adapter.run.upgrades, adapter.run.researchNodes);
    this.playerHeldIds = new Set(adapter.ledger.frozenEcologyIds());
    const actors = canonicalById(adapter.actors);
    for (const actor of actors) {
      const profile = this.profile(actor, attributes);
      const key = JSON.stringify(profile);
      let state = this.states.get(actor.id);
      if (!state) {
        state = { navigator: new NavigationController(profile), profileKey: key, cleanSeconds: 0,
          nextTongueAtMs: this.restoredCooldown(adapter, actor, attributes), lastProgressAtMs: nowMs,
          homeFailures: 0, homeRetryAtMs: 0, candidateCursor: 0 };
        this.states.set(actor.id, state);
      } else if (key !== state.profileKey) { state.navigator = new NavigationController(profile); state.profileKey = key; state.goal = undefined; }
      actor.body.loadFraction = Math.min(1, inventoryLoad(adapter.run.inventory, adapter.domainInventory(actor.id)) / actor.inventory.capacity);
      if (actor.activity === 'unavailable' || actor.insideHome || adapter.homes.some(h => h.residentId === actor.id && h.routine)) continue;
      const load = inventoryLoad(adapter.run.inventory, adapter.domainInventory(actor.id));
      const work = canonicalObjects(adapter.run.inventory).filter(item => this.item(adapter, actor, item.id));
      const cannotFitNext = load > 0 && work.length > 0 && work.every(item => load + (actor.archetype === 'frog' ? 1 : item.weight) > actor.inventory.capacity);
      if (adapter.run.phase === 'retreat' || actor.body.loadFraction >= 1 || cannotFitNext || actor.stamina <= actor.staminaProfile.returnHomeAt) this.returnHome(adapter, actor);
      if (actor.task && !this.item(adapter, actor, actor.task.targetId)) this.release(adapter, actor);
    }
    const cleaner = actors.find(actor => actor.archetype === 'cleaner');
    if (cleaner) {
      const cleanerState = this.states.get(cleaner.id)!;
      const placementSurface = withScreenBoundaries(surface, cleanerState.navigator.profile);
      const placement = this.placementPlanner.plan(cleaner, placementSurface,
        cleanerState.navigator.profile, nowMs);
      adapter.ecologyPlacement = { points: placement.points, floorY: placement.floorY,
        widthDip: placement.widthDip, heightDip: placement.heightDip };
      if (this.placementKey !== undefined && this.placementKey !== placement.cacheKey) {
        for (const actor of actors) {
          const state = this.states.get(actor.id)!;
          state.goal = undefined;
          state.navigator.setTarget();
        }
      }
      this.placementKey = placement.cacheKey;
    } else {
      adapter.ecologyPlacement = { points: [], floorY: 1,
        widthDip: adapter.viewport.widthDip, heightDip: adapter.viewport.heightDip };
    }
    if (adapter.run.phase === 'running' && adapter.run.tick >= this.nextCoordinateTick) {
      this.nextCoordinateTick = adapter.run.tick + 6; this.coordinateCount++;
      for (const actor of actors) if (actor.task && !adapter.coordinator.renew(actor.id, nowMs)) this.release(adapter, actor);
      const goals = new Map<string, NavigationTarget>();
      adapter.coordinate(this.coordinationTargets(adapter, input!, actors, nowMs), (actor, target) => {
        const state = this.states.get(actor.id)!;
        const item = this.item(adapter, actor, target.id);
        if (!item || inventoryLoad(adapter.run.inventory, adapter.domainInventory(actor.id)) + (actor.archetype === 'frog' ? 1 : item.weight) > actor.inventory.capacity) return false;
        const view = withScreenBoundaries(surface, state.navigator.profile);
        const goal = approach(actor, target, view, state.navigator.profile, attributes, nowMs, input!.tongueOccluders,
          code => diagnose(code, actor.id, target.id));
        if (goal) goals.set(JSON.stringify([actor.id, target.id]), goal);
        else diagnose('target-unreachable-retry', actor.id, target.id);
        return !!goal;
      });
      for (const actor of actors) if (actor.task) {
        const goal = goals.get(JSON.stringify([actor.id, actor.task.targetId]));
        if (goal) this.states.get(actor.id)!.goal = goal;
      }
    }
    for (const actor of actors) {
      const state = this.states.get(actor.id)!;
      const view = withScreenBoundaries(surface, state.navigator.profile);
      const home = adapter.homes.find(h => h.id === actor.homeId)!;
      if (actor.activity === 'unavailable' || actor.archetype === 'frog' && !adapter.run.frogUnlocked) continue;
      if (home.routine && adapter.run.phase === 'running') {
        state.recoveryAnchor = undefined; state.recoveryLevel = 0;
        // stepHomeRoutine owns rest recovery; don't also call stepActorStamina here.
        const update = stepHomeRoutine(actor, home, adapter.s07Ledger, seconds);
        if (update.status === 'blocked') diagnose('home-routine-blocked', actor.id);
        continue;
      }
      if (actor.insideHome) continue;
      if (this.recoverStalledActor(adapter, actor, state, view, nowMs, diagnose)) continue;
      if (actor.activity === 'returning-home' || adapter.run.phase === 'retreat') {
        this.driveHome(adapter, actor, state, view, nowMs, seconds, diagnose); continue;
      }
      const target = actor.task && this.target(adapter, actor, actor.task.targetId);
      if (!target) {
        state.cleanSeconds = 0; state.targetId = undefined; state.goal = undefined; state.navigator.setTarget();
        this.patrol(actor, state, view, nowMs, seconds); continue;
      }
      if (state.targetId !== target.id) {
        state.targetId = target.id; state.cleanSeconds = 0; state.lastProgressAtMs = nowMs; state.progressPoint = undefined;
        state.targetPosition = { x: target.x, y: target.y };
      }
      if (state.targetPosition && Math.hypot(target.x - state.targetPosition.x, target.y - state.targetPosition.y) > 1 && adapter.run.tick % 6 === 0) {
        state.goal = undefined; state.targetPosition = { x: target.x, y: target.y };
      }
      const canAct = () => canWork(actor, target, view, state.navigator.profile, attributes, nowMs, input!.tongueOccluders);
      if (!canAct() && !state.goal && (actor.body.support || actor.body.grip)) {
        state.goal = approach(actor, target, view, state.navigator.profile, attributes, nowMs, input!.tongueOccluders,
          code => diagnose(code, actor.id, target.id));
        if (!state.goal) { this.unreachable(adapter, actor, nowMs, diagnose); }
      }
      state.navigator.setTarget(state.goal);
      const movement = canAct() || !actor.task ? {} : state.navigator.update(actor.body, view, nowMs);
      stepActor(actor.body, movement, view, state.navigator.profile, nowMs, seconds);
      if (!actor.task) continue;
      if (canAct()) {
        state.recoveryAnchor = undefined; state.recoveryLevel = 0;
        actor.activity = 'working'; state.lastProgressAtMs = nowMs;
        if (stepActorStamina(actor, seconds).shouldReturnHome) { this.returnHome(adapter, actor); continue; }
        if (actor.archetype === 'cleaner') {
          state.cleanSeconds += seconds;
          if (state.cleanSeconds + 1e-9 >= attributes.cleanSeconds) {
            const receipt = adapter.coordinator.pickupAssigned(this.commandId(adapter, actor, 'clean'), actor, nowMs);
            state.cleanSeconds = 0;
            if (!receipt.ok) diagnose('pickup-' + receipt.reason, actor.id, target.id);
          }
        } else if (nowMs + 1e-7 >= state.nextTongueAtMs) this.capture(adapter, actor, state, view, attributes, nowMs, input!, diagnose);
      } else {
        state.cleanSeconds = 0; actor.activity = 'travelling';
        if (!state.progressPoint || Math.hypot(actor.body.x - state.progressPoint.x, actor.body.y - state.progressPoint.y) >= 2) {
          state.progressPoint = { x: actor.body.x, y: actor.body.y }; state.lastProgressAtMs = nowMs;
        }
        if (['unreachable', 'blocked', 'arrived'].includes(state.navigator.status) || nowMs - state.lastProgressAtMs >= 8000) this.unreachable(adapter, actor, nowMs, diagnose);
        if (stepActorStamina(actor, seconds).shouldReturnHome) this.returnHome(adapter, actor);
      }
    }
    if (!input!.tongueOccluders && adapter.run.frogUnlocked) diagnose('tongue-visibility-unavailable');
    for (const actor of actors) {
      const strategy = input!.strategyByActor?.[actor.id];
      if (strategy === 'elite') diagnose('elite-attack-interface-unavailable', actor.id);
      if (strategy === 'maintenance') diagnose('maintenance-interface-unavailable', actor.id);
    }
    result.stepped = true;
    return result;
  }

  private profile(actor: ActorState, attributes: RunAttributes): MovementProfile {
    return actor.archetype === 'frog' ? { ...FROG_PROFILE } : { ...CLEANER_PROFILE, speed: attributes.moveSpeed };
  }
  /** Independent of targets: repeated replans and idle patrol must not reset a stall. */
  private recoverStalledActor(adapter: S07DomainAdapter, actor: ActorState, state: TransientActor,
    surface: SurfaceSnapshotV2, nowMs: number, diagnose: (code: string, actorId?: string) => void): boolean {
    const body = actor.body;
    if (actor.activity === 'working') { state.recoveryAnchor = undefined; return false; }
    if (state.recoveryOrigin && Math.hypot(body.x - state.recoveryOrigin.x, body.y - state.recoveryOrigin.y) > 64) {
      state.recoveryLevel = 0; state.recoveryOrigin = undefined;
    }
    if (!state.recoveryAnchor || Math.hypot(body.x - state.recoveryAnchor.x, body.y - state.recoveryAnchor.y) >= 12) {
      state.recoveryAnchor = { x: body.x, y: body.y }; state.recoveryAtMs = nowMs; return false;
    }
    if (nowMs - (state.recoveryAtMs ?? nowMs) < 4000) return false;
    state.recoveryAtMs = nowMs;
    state.recoveryOrigin ??= { x: body.x, y: body.y };
    state.recoveryLevel = (state.recoveryLevel ?? 0) + 1;
    this.release(adapter, actor);
    state.homeRetryAtMs = 0; state.homeFailures = 0;
    state.patrolDirection = body.x > surface.width / 2 ? -1 : 1;
    if (state.recoveryLevel === 1) {
      diagnose('actor-stall-replan', actor.id); return false;
    }
    const oldSupport = body.support;
    const oldGrip = body.grip;
    body.support = undefined; body.grip = undefined;
    body.releasedGrip = oldGrip;
    body.dropThrough = oldSupport ? { id: oldSupport.id, untilMs: nowMs + 1500 } : undefined;
    body.vx = 0; body.vy = 80; body.motion = 'falling';
    if (state.recoveryLevel === 2 && body.y < surface.floorY - 8) {
      body.y = Math.min(surface.floorY, body.y + 4);
      diagnose('actor-stall-drop', actor.id);
    } else {
      const home = adapter.homes.find(candidate => candidate.id === actor.homeId);
      if (!home || home.hp <= 0) return false;
      body.x = Math.max(state.navigator.profile.radius, Math.min(surface.width - state.navigator.profile.radius, home.x));
      body.y = surface.floorY; body.vy = 0; body.dropThrough = undefined; body.releasedGrip = undefined;
      this.returnHome(adapter, actor);
      state.recoveryLevel = 0; state.recoveryOrigin = undefined;
      diagnose('actor-stall-return-home', actor.id);
    }
    state.recoveryAnchor = { x: body.x, y: body.y };
    return true;
  }
  /** Ambient walking stays task-idle so the next coordination pass can interrupt it.
   * Walk only on the currently verified support; scrolling still releases that support
   * through normal physics. This needs no global route search or work reservation. */
  private patrol(actor: ActorState, state: TransientActor, surface: SurfaceSnapshotV2, nowMs: number, seconds: number): void {
    const profile = state.navigator.profile;
    const support = actor.body.support && livePlatforms(surface, nowMs).find(p =>
      p.id === actor.body.support!.id && p.version === actor.body.support!.version && Math.abs(p.y - actor.body.y) < 1e-6);
    if (!support) {
      stepActor(actor.body, { releaseGrip: !!actor.body.grip }, surface, profile, nowMs, seconds);
      return;
    }
    const left = Math.max(profile.radius, support.x1 + profile.radius);
    const right = Math.min(surface.width - profile.radius, support.x2 - profile.radius);
    if (right - left < 12) { stepActor(actor.body, {}, surface, profile, nowMs, seconds); return; }
    state.patrolDirection ??= actor.archetype === 'cleaner' ? 1 : -1;
    if (actor.body.x >= right - 4) state.patrolDirection = -1;
    else if (actor.body.x <= left + 4) state.patrolDirection = 1;
    stepActor(actor.body, { moveX: state.patrolDirection * 0.45 }, surface, profile, nowMs, seconds);
  }
  private item(adapter: S07DomainAdapter, actor: Readonly<ActorState>, id: string): CampaignObject | undefined {
    const item = hasKey(adapter.run.inventory.objects, id) ? adapter.run.inventory.objects[id] : undefined;
    return item?.owner === 'world' && !this.playerHeldIds.has(id)
      && (actor.archetype === 'frog' ? item.kind === 'bug' && item.hp > 0 : ['trash', 'corpse', 'egg'].includes(item.kind)) ? item : undefined;
  }
  private target(adapter: S07DomainAdapter, actor: Readonly<ActorState>, id: string): AgentTarget | undefined {
    const item = this.item(adapter, actor, id);
    return item ? { id, kind: item.kind, x: item.x * adapter.viewport.widthDip, y: item.y * adapter.viewport.heightDip, allowedRoles: [actor.archetype] } : undefined;
  }
  private targets(adapter: S07DomainAdapter, input: CampaignAgentInput): AgentTarget[] {
    return canonicalObjects(adapter.run.inventory).flatMap(item => {
      const actor = adapter.actors.find(a => this.item(adapter, a, item.id));
      if (!actor) return [];
      const target = this.target(adapter, actor, item.id)!;
      const requestedStrategy = input.strategyByActor?.[actor.id];
      const strategy = requestedStrategy === undefined ? (actor.archetype === 'frog' ? 'nearHome' : 'clean')
        : requestedStrategy === 'nearHome' ? 'nearHome' : 'clean';
      const home = adapter.homes.find(h => h.id === actor.homeId)!;
      const priority = actor.archetype === 'cleaner' ? this.cleanerPriority(item)
        : strategy === 'nearHome' ? -Math.hypot(target.x - home.x, target.y - home.y)
          : item.pollution + item.cleanValue;
      return [{ ...target, priority }];
    });
  }
  private cleanerPriority(item: CampaignObject): number {
    if (item.kind !== 'egg') return 1_000_000;
    const growth = item.ecology?.stage === 'egg' ? item.ecology.growthSeconds : item.age;
    const remaining = Math.max(0, ECOLOGY_CYCLE.hatchSeconds - growth);
    // The last ten seconds form an explicit hatch-interception tier. Younger eggs wait
    // behind nearby trash/corpses, whose equal tier is distance-sorted by the coordinator.
    return remaining <= 10 ? 2_000_000 + (10 - remaining) * 1_000 : -1_000_000 - remaining;
  }
  /** Bound each 10Hz coordination pass to four probes per idle actor. Advance a transient
   * cursor so thousands of impossible high-priority items cannot starve later candidates.
   * Items outside this window have not been searched and receive no failure/backoff. */
  private coordinationTargets(adapter: S07DomainAdapter, input: CampaignAgentInput, actors: ActorState[], nowMs: number): AgentTarget[] {
    const targets = this.targets(adapter, input), backoffs = adapter.coordinator.snapshot().backoffs;
    const selected: AgentTarget[] = [];
    for (const actor of actors) {
      if (actor.activity !== 'idle' || actor.insideHome || !actor.body.support && !actor.body.grip) continue;
      const state = this.states.get(actor.id)!;
      const pool = targets.filter(t => t.allowedRoles?.includes(actor.archetype)
        && adapter.ledger.snapshot(t.id)?.owner.kind === 'world'
        && !backoffs.some(b => b.actorId === actor.id && b.targetId === t.id && b.retryAtMs > nowMs))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)
          || Math.hypot(a.x - actor.body.x, a.y - actor.body.y) - Math.hypot(b.x - actor.body.x, b.y - actor.body.y)
          || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (!pool.length) continue;
      const start = state.candidateCursor % pool.length;
      for (let i = 0; i < Math.min(4, pool.length); i++) selected.push(pool[(start + i) % pool.length]);
      state.candidateCursor = (start + 4) % pool.length;
    }
    return selected;
  }
  private release(adapter: S07DomainAdapter, actor: ActorState): void {
    adapter.coordinator.releaseActor(actor); adapter.ledger.releaseActorReservations(actor.id); actor.task = undefined;
    if (actor.activity === 'travelling' || actor.activity === 'working') actor.activity = 'idle';
    const state = this.states.get(actor.id);
    if (state) { state.cleanSeconds = 0; state.goal = undefined; state.targetId = undefined; state.navigator.setTarget(); }
  }
  private returnHome(adapter: S07DomainAdapter, actor: ActorState): void {
    // Repeated full/low/retreat observations must preserve in-flight navigation edges.
    if (actor.activity === 'returning-home' && !actor.task && !this.states.get(actor.id)?.targetId) return;
    this.release(adapter, actor); requestActorReturnHome(actor);
  }
  private unreachable(adapter: S07DomainAdapter, actor: ActorState, nowMs: number, diagnose: (code: string, actorId?: string, targetId?: string) => void): void {
    const targetId = actor.task?.targetId;
    adapter.coordinator.reportUnreachable(actor, nowMs); this.release(adapter, actor);
    diagnose('target-unreachable-retry', actor.id, targetId);
  }
  private commandId(adapter: S07DomainAdapter, actor: ActorState, kind: string): string {
    return JSON.stringify(['campaign-agent', adapter.run.runId, actor.id, kind, adapter.run.tick]);
  }
  private restoredCooldown(adapter: S07DomainAdapter, actor: ActorState, attributes: RunAttributes): number {
    let latest = -Infinity;
    if (actor.archetype !== 'frog') return latest;
    for (const [id, receipt] of Object.entries(adapter.run.inventory.commands)) {
      if (!receipt.ok || !id.startsWith('["campaign-agent",')) continue;
      let parts: unknown;
      try { parts = JSON.parse(id); } catch { continue; }
      if (Array.isArray(parts) && parts.length === 5 && parts[1] === adapter.run.runId && parts[2] === actor.id && parts[3] === 'capture'
        && Number.isSafeInteger(parts[4]) && parts[4] <= adapter.run.tick) latest = Math.max(latest, parts[4] * 1000 / 60 + attributes.attackCooldown * 1000);
    }
    return latest;
  }
  private capture(adapter: S07DomainAdapter, actor: ActorState, state: TransientActor, surface: SurfaceSnapshotV2,
    attributes: RunAttributes, nowMs: number, input: CampaignAgentInput, diagnose: (code: string, actorId?: string, targetId?: string) => void): void {
    const assigned = actor.task!.targetId;
    const limit = Math.min(attributes.tongueBatch, actor.inventory.capacity - inventoryLoad(adapter.run.inventory, adapter.domainInventory(actor.id)));
    const ids: string[] = [];
    const candidates = this.targets(adapter, input).filter(t => this.item(adapter, actor, t.id))
      .sort((a, b) => Number(b.id === assigned) - Number(a.id === assigned) || (b.priority ?? 0) - (a.priority ?? 0)
        || Math.hypot(a.x - actor.body.x, a.y - actor.body.y) - Math.hypot(b.x - actor.body.x, b.y - actor.body.y)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const target of candidates) {
      if (ids.length >= limit) break;
      if (canWork(actor, target, surface, state.navigator.profile, attributes, nowMs, input.tongueOccluders)
        && adapter.ledger.reserve(target.id, actor.id, nowMs, nowMs + 5000)) ids.push(target.id);
    }
    if (!ids.length || !ids.includes(assigned)) { for (const id of ids) adapter.ledger.releaseReservation(id, actor.id); return; }
    const receipt = adapter.ledger.pickup(this.commandId(adapter, actor, 'capture'), actor.id, actor.inventory, ids, nowMs);
    if (receipt.ok) { state.nextTongueAtMs = nowMs + attributes.attackCooldown * 1000; adapter.coordinator.reportReached(actor.id, assigned); }
    else diagnose('capture-' + receipt.reason, actor.id, assigned);
    this.release(adapter, actor);
  }
  private driveHome(adapter: S07DomainAdapter, actor: ActorState, state: TransientActor, surface: SurfaceSnapshotV2,
    nowMs: number, seconds: number, diagnose: (code: string, actorId?: string) => void): void {
    const home = adapter.homes.find(h => h.id === actor.homeId)!;
    state.navigator.setTarget({ x: home.x, y: home.y, kind: 'platform', supportId: 'floor' });
    const input = nowMs < state.homeRetryAtMs ? {} : state.navigator.update(actor.body, surface, nowMs);
    stepActor(actor.body, input, surface, state.navigator.profile, nowMs, seconds);
    if (standing(actor, surface, state.navigator.profile, nowMs) && Math.hypot(actor.body.x - home.x, actor.body.y - home.y) <= 18) {
      if (adapter.run.phase === 'retreat') {
        const receipt = adapter.arriveHome(this.commandId(adapter, actor, 'retreat-home'), actor.id);
        if (!receipt.ok) diagnose('arrive-home-' + receipt.reason, actor.id);
      } else {
        beginHomeEntry(actor, home);
        actor.body.support = undefined; actor.body.grip = undefined; actor.body.dropThrough = undefined; actor.body.releasedGrip = undefined;
      }
      state.homeFailures = 0; state.homeRetryAtMs = 0; state.navigator.setTarget();
    } else if (nowMs >= state.homeRetryAtMs && ['blocked', 'unreachable'].includes(state.navigator.status)) {
      state.homeFailures++; state.homeRetryAtMs = nowMs + Math.min(8000, 500 * 2 ** Math.min(30, state.homeFailures - 1));
      state.navigator.setTarget(); diagnose('home-unreachable-retry', actor.id);
    }
    stepActorStamina(actor, seconds);
  }
}

function validSurface(surface: SurfaceSnapshotV2): boolean {
  return surface.schemaVersion === 2 && !!surface.displayId
    && [surface.width, surface.height, surface.floorY, surface.verifiedAtMs, surface.capturedAtMs].every(Number.isFinite)
    && surface.width >= 48 && surface.height >= 120
    && surface.platforms.every(p => !!p.id && [p.version, p.x1, p.x2, p.y].every(Number.isFinite) && p.x1 <= p.x2 && (p.expiresAtMs === undefined || Number.isFinite(p.expiresAtMs)))
    && surface.grips.every(g => !!g.id && [g.version, g.x, g.y1, g.y2].every(Number.isFinite) && g.y1 <= g.y2 && (g.expiresAtMs === undefined || Number.isFinite(g.expiresAtMs)));
}
