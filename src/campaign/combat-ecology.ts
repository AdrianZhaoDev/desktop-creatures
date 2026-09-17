import { addObject, canonicalObjects, hasKey, inventoryLoad, transact, type CampaignObject, type InventoryState, type Point, type Receipt } from './tool-system';
import { createEntityEcology, DEFAULT_ECOLOGY_PLACEMENT, markEcologyDead, stepEcologyCycle } from './ecology-cycle';
import { ECOLOGY_CYCLE, type EcologyPlacement } from './ecology-cycle-types';

export { migrateEcologyCycle } from './ecology-cycle';

export interface KillPort { kill(id: string, kind: 'normal' | 'elite' | 'nest'): void }
export interface EcologyState { stage: number; seconds: number; pollution: number; density: number; peakDensity: number; seed: number; nextId: number; spawnRemaining: number; nestSpawned: boolean; nestDestroyed: boolean; cycleVersion?: 2; openingSpawned?: boolean }
export const OPENING_SPAWN_GRACE_SECONDS = 45;
export const AMBIENT_SPAWN_INTERVAL_SECONDS = 30;
/** Eggs and mobile enemies share one stage budget so unhatched waves cannot bypass it. */
export const STAGE_POPULATION_LIMITS = Object.freeze([0, 4, 12, 60, 200] as const);
export const createEcology = (seed: number): EcologyState => ({ stage: 1, seconds: 0, pollution: 0, density: 0, peakDensity: 0, seed: seed >>> 0, nextId: 1, spawnRemaining: 0, nestSpawned: false, nestDestroyed: false, cycleVersion: ECOLOGY_CYCLE.version, openingSpawned: false });
export function createCampaignObject(id: string, kind: CampaignObject['kind'], point: Point = { x: 0.5, y: 0.5 }): CampaignObject {
  const hp = kind === 'elite' ? 80 : kind === 'nest' ? 300 : kind === 'bug' ? 20 : 0;
  return { id, kind, owner: 'world', x: point.x, y: point.y, weight: 1, cleanValue: kind === 'trash' || kind === 'egg' ? 2 : 1,
    hp, maxHp: hp, armor: kind === 'elite' ? 5 : 0, pollution: kind === 'corpse' ? 0.5 : 1,
    behavior: kind === 'elite' ? 'armored' : kind === 'nest' ? 'nest' : kind === 'bug' ? 'forager' : 'none', age: 0, attackRemaining: 0, controlRemaining: 0,
    ecology: createEntityEcology(id, kind) };
}
export const isLive = (item: CampaignObject): boolean => ['bug', 'elite', 'nest'].includes(item.kind) && item.hp > 0;
/** Enemy budget is 200 mobile bugs plus the single mandatory, stationary objective. */
export const MAX_LIVE_BUGS = 200;
export const MAX_COMBAT_TARGETS = MAX_LIVE_BUGS + 1;
export const isLiveBug = (item: CampaignObject): boolean => (item.kind === 'bug' || item.kind === 'elite') && item.hp > 0;
export function isExposed(state: InventoryState, item: CampaignObject): boolean {
  return ['world', 'corpsePile'].includes(state.containers[item.owner]?.kind);
}
/** Death preserves the original ID and weight; reward and residue are one transition. */
export function damageObject(state: InventoryState, ecology: EcologyState, commandId: string, id: string, damage: number, rewards: KillPort, armorPiercing = 0): Receipt {
  return transact(state, commandId, JSON.stringify(['damage', id, damage, armorPiercing]), () => {
    if (!Number.isFinite(damage) || damage <= 0 || !Number.isFinite(armorPiercing) || armorPiercing < 0) return 'invalid-damage';
    if (!hasKey(state.objects, id)) return 'missing';
    const item = state.objects[id];
    if (!isLive(item) || !isExposed(state, item)) return 'not-live';
    item.hp = Math.max(0, item.hp - Math.max(0, damage - Math.max(0, item.armor - armorPiercing)));
    if (item.hp === 0) {
      rewards.kill(id, item.kind === 'elite' ? 'elite' : item.kind === 'nest' ? 'nest' : 'normal');
      if (item.kind === 'nest') ecology.nestDestroyed = true;
      item.kind = 'corpse'; item.behavior = 'none'; item.armor = 0; item.pollution = Math.max(0.5, item.pollution);
      markEcologyDead(item);
    }
    return null;
  });
}
/** Frog/catcher capture removes a small live bug from ecology and seals its residue in the same transaction. */
export function captureObject(state: InventoryState, commandId: string, id: string, destination: string, rewards: KillPort): Receipt {
  return transact(state, commandId, JSON.stringify(['capture', id, destination]), () => {
    if (!hasKey(state.objects, id) || !hasKey(state.containers, destination)) return 'missing';
    const item = state.objects[id], container = state.containers[destination];
    if (item.kind !== 'bug' || !isLive(item) || item.owner !== 'world') return 'not-capturable';
    if (!['frogPouch', 'trap'].includes(container.kind) || !container.sealed) return 'invalid-container';
    if (inventoryLoad(state, destination) + 1 > container.capacity) return 'capacity';
    item.kind = 'corpse'; item.hp = 0; item.behavior = 'none'; item.owner = destination; item.pollution = 0.5;
    // While sealed in a pouch, age means per-member digestion time; no live timers survive capture.
    item.age = 0; item.attackRemaining = 0; item.controlRemaining = 0; item.armor = 0;
    markEcologyDead(item);
    rewards.kill(id, 'normal');
    return null;
  });
}
export interface DensityConfig { bug: number; corpse: number; trash: number; egg: number; threshold: number }
export const DEFAULT_DENSITY: DensityConfig = { bug: 1, corpse: 0.5, trash: 1, egg: 1, threshold: 2 };
/** Logical 16x9 cells; no display size, visual count or quality argument exists. */
export function infectionDensity(state: InventoryState, config = DEFAULT_DENSITY): number {
  if (!Object.values(config).every(v => Number.isFinite(v) && v >= 0) || config.threshold <= 0) throw new Error('Invalid density config');
  const cells = new Array<number>(144).fill(0);
  for (const item of canonicalObjects(state)) {
    if (!isExposed(state, item)) continue;
    const x = Math.min(15, Math.max(0, Math.floor(item.x * 16))), y = Math.min(8, Math.max(0, Math.floor(item.y * 9)));
    cells[y * 16 + x] += isLive(item) ? config.bug : item.kind === 'corpse' ? config.corpse : item.kind === 'egg' ? config.egg : config.trash;
  }
  return cells.filter(load => load >= config.threshold).length / 144 * 100;
}
function nextRandom(ecology: EcologyState): number { ecology.seed = (Math.imul(ecology.seed, 1664525) + 1013904223) >>> 0; return ecology.seed / 4294967296; }
function requireAvailableIdCounter(ecology: EcologyState): void {
  if (!Number.isSafeInteger(ecology.nextId) || ecology.nextId < 1 || ecology.nextId >= Number.MAX_SAFE_INTEGER) throw new RangeError('Ecology object ID space exhausted or invalid');
}
function nextObjectId(state: InventoryState, ecology: EcologyState): string {
  requireAvailableIdCounter(ecology);
  let candidate = ecology.nextId;
  // Reserve MAX_SAFE - 1 so every successful allocation leaves a V4-saveable counter.
  while (candidate < Number.MAX_SAFE_INTEGER - 1) {
    const id = `ecology:${candidate}`;
    candidate++;
    if (!hasKey(state.objects, id) && !hasKey(state.containers, id)) { ecology.nextId = candidate; return id; }
  }
  throw new RangeError('Ecology object ID space exhausted');
}
export function ensureMainNest(state: InventoryState, ecology: EcologyState): void {
  requireAvailableIdCounter(ecology);
  if (ecology.nestSpawned) return;
  addObject(state, createCampaignObject(nextObjectId(state, ecology), 'nest', { x: 0.5, y: 0.85 }));
  ecology.nestSpawned = true;
}
export const EVOLUTIONS = [ { seconds: 300, behavior: 'armored', message: 'elite-armor' }, { seconds: 420, behavior: 'swift', message: 'swift-wave' } ] as const;
export function upcomingEvolution(seconds: number): typeof EVOLUTIONS[number] | undefined { return EVOLUTIONS.find(event => event.seconds > seconds && event.seconds - seconds <= 15); }
/** Caller supplies fixed dt. Capacity limits delay spawning; existing ledger objects are never dropped. */
function stepLegacyEcology(state: InventoryState, ecology: EcologyState, dt: number, paused: boolean): void {
  if (paused || !Number.isFinite(dt) || dt <= 0 || dt > 0.1 + 1e-9) return;
  requireAvailableIdCounter(ecology);
  ecology.seconds += dt;
  ecology.stage = Math.max(ecology.stage, ecology.seconds >= 600 ? 4 : ecology.seconds >= 300 ? 3 : ecology.seconds >= 120 ? 2 : 1);
  if (ecology.seconds >= 600) ensureMainNest(state, ecology);
  let pressure = 0;
  const exposed = canonicalObjects(state).filter(item => isExposed(state, item));
  let liveCount = exposed.filter(isLiveBug).length;
  let populationCount = exposed.filter(item => item.kind === 'egg' || isLiveBug(item)).length;
  const populationLimit = STAGE_POPULATION_LIMITS[ecology.stage];
  for (const item of exposed) {
    item.age += dt; item.controlRemaining = Math.max(0, item.controlRemaining - dt);
    if (item.kind === 'trash' || item.kind === 'corpse' || item.kind === 'nest') pressure += item.pollution;
    if (item.kind === 'egg' && item.age >= 30 && liveCount < MAX_LIVE_BUGS) {
      item.kind = 'bug'; item.hp = 20; item.maxHp = 20; item.age = 0; liveCount++;
      item.behavior = (['forager', 'breeder', 'swift'] as const)[Math.floor(nextRandom(ecology) * 3)];
    }
    if (isLiveBug(item) && item.controlRemaining === 0 && item.owner === 'world') {
      const speed = item.behavior === 'swift' ? 0.03 : 0.012;
      const food = exposed.find(other => other.kind === 'trash');
      const destination = crawlDestination(item, food, ecology.seconds);
      const distance = Math.hypot(destination.x - item.x, destination.y - item.y);
      if (distance > 0) { const step = Math.min(distance, speed * dt); item.x += (destination.x - item.x) / distance * step; item.y += (destination.y - item.y) / distance * step; }
      if (item.kind === 'bug' && item.behavior === 'breeder' && item.age >= 45 && exposed.length < 400 && populationCount < populationLimit) {
        addObject(state, createCampaignObject(nextObjectId(state, ecology), 'egg', item)); item.age = 0; populationCount++;
      }
    }
  }
  ecology.pollution = Math.min(100, Math.max(0, ecology.pollution + pressure * dt * 0.01));
  ecology.spawnRemaining = Math.max(0, ecology.spawnRemaining - dt);
  if (!ecology.nestDestroyed && ecology.spawnRemaining <= 1e-9) {
    if (exposed.length < 400 && liveCount < MAX_LIVE_BUGS && populationCount < populationLimit) {
      const kind = ecology.seconds >= 300 && !exposed.some(item => item.kind === 'elite') ? 'elite' : 'egg';
      addObject(state, createCampaignObject(nextObjectId(state, ecology), kind, { x: nextRandom(ecology), y: nextRandom(ecology) }));
    }
    // A full stage consumes this attempt instead of accumulating an immediate refill.
    ecology.spawnRemaining = AMBIENT_SPAWN_INTERVAL_SECONDS;
  }
  ecology.density = infectionDensity(state); ecology.peakDensity = Math.max(ecology.peakDensity, ecology.density);
}

/** V2 uses finite trash, lifecycle and mating. Missing version retains deterministic legacy behavior. */
export function stepEcology(state: InventoryState, ecology: EcologyState, dt: number, paused: boolean, placement: EcologyPlacement = DEFAULT_ECOLOGY_PLACEMENT): void {
  if (ecology.cycleVersion !== ECOLOGY_CYCLE.version) {
    stepLegacyEcology(state, ecology, dt, paused);
    return;
  }
  if (paused || !Number.isFinite(dt) || dt <= 0 || dt > 0.1 + 1e-9) return;
  requireAvailableIdCounter(ecology);
  stepEcologyCycle(state, ecology, dt, placement, {
    allocate: (kind, point) => createCampaignObject(nextObjectId(state, ecology), kind, point),
    density: () => infectionDensity(state),
    exposed: item => isExposed(state, item),
  });
}
/** Stable identity and simulation time give each bug its own patrol without consuming
 * the spawn RNG or introducing unserialized timers. Food remains the first destination;
 * nearby insects explore around it instead of stacking forever at its exact center. */
function crawlDestination(item: CampaignObject, food: CampaignObject | undefined, seconds: number): Point {
  if (food && Math.hypot(food.x - item.x, food.y - item.y) > 0.06) return food;
  let hash = 2166136261;
  for (let i = 0; i < item.id.length; i++) hash = Math.imul(hash ^ item.id.charCodeAt(i), 16777619) >>> 0;
  const angle = hash / 4294967296 * Math.PI * 2 + seconds * 0.22;
  const clamp = (n: number) => Math.max(0.02, Math.min(0.98, n));
  return food ? { x: clamp(food.x + Math.cos(angle) * 0.045), y: clamp(food.y + Math.sin(angle) * 0.045) }
    : { x: 0.5 + Math.cos(angle) * 0.46, y: 0.5 + Math.sin(angle) * 0.46 };
}
export interface SwarmCluster { id: string; memberIds: string[] }
export function swarmTotals(state: InventoryState, cluster: SwarmCluster): { count: number; hp: number; weight: number } {
  if (new Set(cluster.memberIds).size !== cluster.memberIds.length) throw new Error('Duplicate swarm membership');
  return [...cluster.memberIds].sort().reduce((sum, id) => {
    if (!hasKey(state.objects, id)) throw new Error('Missing swarm member');
    const item = state.objects[id];
    return { count: sum.count + (isLive(item) && isExposed(state, item) ? 1 : 0), hp: sum.hp + (isLive(item) && isExposed(state, item) ? item.hp : 0), weight: sum.weight + item.weight };
  }, { count: 0, hp: 0, weight: 0 });
}
