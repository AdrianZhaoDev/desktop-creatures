import { addObject, canonicalObjects, hasKey, type CampaignObject, type InventoryState, type Point } from './tool-system';
import { ECOLOGY_CYCLE, type EcologyPlacement, type EntityEcology } from './ecology-cycle-types';

export interface EcologyCycleClock {
  stage: number;
  seconds: number;
  pollution: number;
  density: number;
  peakDensity: number;
  seed: number;
  nextId: number;
  spawnRemaining: number;
  nestSpawned: boolean;
  nestDestroyed: boolean;
  cycleVersion?: 2;
  openingSpawned?: boolean;
}

export interface EcologyCyclePorts {
  allocate(kind: CampaignObject['kind'], point: Point): CampaignObject;
  density(): number;
  exposed(item: CampaignObject): boolean;
}

const EDGE = 0.02;
const FEED_DISTANCE = 0.028;
const MATING_DISTANCE = 0.065;
const MATING_POSE_DISTANCE = 0.024;
const MATING_POSE_DISTANCE_DIP = 46;
const SEPARATION_DISTANCE = 0.04;
const NORMAL_SPEED = 0.012;
const DEFAULT_BOTTOM_POINTS = Object.freeze([
  { x: 0.1, y: 1 }, { x: 0.3, y: 1 }, { x: 0.5, y: 1 }, { x: 0.7, y: 1 }, { x: 0.9, y: 1 },
] as const);

/** Omitted placement is reserved for pure domain callers. Production supplies verified points. */
export const DEFAULT_ECOLOGY_PLACEMENT: EcologyPlacement = Object.freeze({ points: DEFAULT_BOTTOM_POINTS, floorY: 1 });

function hashId(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619) >>> 0;
  return hash >>> 0;
}

function lifeStage(kind: CampaignObject['kind']): EntityEcology['stage'] {
  return kind === 'egg' ? 'egg' : kind === 'bug' || kind === 'elite' ? 'adult' : 'none';
}

function deterministicSex(id: string): EntityEcology['sex'] {
  return (hashId(id) & 1) === 0 ? 'female' : 'male';
}

/** Every object has a complete serialized ecology record; direct bugs are legacy/test adults. */
export function createEntityEcology(id: string, kind: CampaignObject['kind']): EntityEcology {
  const hash = hashId(id);
  const stage = lifeStage(kind);
  const living = stage === 'small' || stage === 'medium' || stage === 'adult';
  return {
    stage,
    sex: stage === 'egg' || living ? deterministicSex(id) : 'none',
    energy: living ? ECOLOGY_CYCLE.maxEnergy : 0,
    growthSeconds: 0,
    breedCooldown: 0,
    mated: false,
    food: kind === 'trash' ? ECOLOGY_CYCLE.trashNutrition : kind === 'corpse' ? ECOLOGY_CYCLE.corpseNutrition : 0,
    carrierId: null,
    disposition: 'none',
    wanderX: EDGE + ((hash >>> 8) & 0xffff) / 0xffff * (1 - EDGE * 2),
    wanderY: EDGE + ((hash >>> 16) & 0xffff) / 0xffff * (1 - EDGE * 2),
    wanderRemaining: 0,
    wanderSeed: (hash ^ 0x9e3779b9) >>> 0,
    heading: hash / 0x1_0000_0000 * Math.PI * 2,
  };
}

function clearAction(ecology: EntityEcology): void {
  delete ecology.action;
  delete ecology.actionElapsed;
  delete ecology.actionTargetId;
}

function beginAction(ecology: EntityEcology, action: NonNullable<EntityEcology['action']>, targetId: string | null): void {
  ecology.action = action;
  ecology.actionElapsed = 0;
  ecology.actionTargetId = targetId;
}

function elapsedAction(ecology: EntityEcology): number {
  return Number.isFinite(ecology.actionElapsed) && ecology.actionElapsed! >= 0 ? ecology.actionElapsed! : 0;
}

/** Preserve corpse scale from the living stage while removing every active-life flag. */
export function markEcologyDead(item: CampaignObject): void {
  const previous = item.ecology ?? createEntityEcology(item.id, item.kind);
  const preservesBody = previous.stage === 'small' || previous.stage === 'medium' || previous.stage === 'adult';
  item.ecology = {
    ...previous,
    stage: preservesBody ? previous.stage : 'none',
    sex: preservesBody ? previous.sex : 'none',
    energy: 0,
    breedCooldown: 0,
    mated: false,
    food: ECOLOGY_CYCLE.corpseNutrition,
    carrierId: null,
    disposition: 'none',
    wanderRemaining: 0,
  };
  clearAction(item.ecology);
}

function isCycleBug(item: CampaignObject): boolean {
  return item.owner === 'world' && (item.kind === 'bug' || item.kind === 'elite') && item.hp > 0
    && !!item.ecology && (item.ecology.stage === 'small' || item.ecology.stage === 'medium' || item.ecology.stage === 'adult');
}

function isCycleFood(item: CampaignObject): boolean {
  return item.owner === 'world' && (item.kind === 'trash' || item.kind === 'corpse') && (item.ecology?.food ?? 0) > 1e-9;
}

function isWorldEgg(item: CampaignObject): boolean {
  return item.owner === 'world' && item.kind === 'egg' && item.ecology?.stage === 'egg';
}

function populationCount(state: InventoryState): number {
  return canonicalObjects(state).filter(item => isWorldEgg(item) || isCycleBug(item)).length;
}

function nextCycleRandom(clock: EcologyCycleClock): number {
  clock.seed = (Math.imul(clock.seed, 1664525) + 1013904223) >>> 0;
  return clock.seed / 0x1_0000_0000;
}

function nextEntityRandom(ecology: EntityEcology): number {
  ecology.wanderSeed = (Math.imul(ecology.wanderSeed >>> 0, 1664525) + 1013904223) >>> 0;
  return ecology.wanderSeed / 0x1_0000_0000;
}

function nextTrashInterval(clock: EcologyCycleClock): number {
  return ECOLOGY_CYCLE.trashIntervalMin
    + nextCycleRandom(clock) * (ECOLOGY_CYCLE.trashIntervalMax - ECOLOGY_CYCLE.trashIntervalMin);
}

function validPoints(placement: EcologyPlacement): Point[] {
  return placement.points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1).map(point => ({ x: point.x, y: point.y }));
}

function chooseSpawnPoint(clock: EcologyCycleClock, placement: EcologyPlacement): Point | undefined {
  const points = validPoints(placement);
  if (!points.length) return undefined;
  return points[Math.floor(nextCycleRandom(clock) * points.length)];
}

function addSpawn(state: InventoryState, ports: EcologyCyclePorts, kind: CampaignObject['kind'], point: Point): CampaignObject {
  const item = ports.allocate(kind, point);
  addObject(state, item);
  return item;
}

function attachEgg(state: InventoryState, ports: EcologyCyclePorts, carrier: CampaignObject): CampaignObject {
  const egg = addSpawn(state, ports, 'egg', carrier);
  egg.ecology!.carrierId = carrier.id;
  return egg;
}

function spawnOpening(state: InventoryState, clock: EcologyCycleClock, placement: EcologyPlacement, ports: EcologyCyclePorts): void {
  if (clock.openingSpawned) return;
  const availablePoint = chooseSpawnPoint(clock, placement);
  if (!availablePoint) return;
  const trashRoom = Math.max(0, ECOLOGY_CYCLE.maxWorldTrash
    - canonicalObjects(state).filter(item => item.owner === 'world' && item.kind === 'trash').length);
  const count = Math.min(ECOLOGY_CYCLE.openingTrash, trashRoom);
  const spawned: CampaignObject[] = [];
  for (let index = 0; index < count; index++) {
    const point = index === 0 ? availablePoint : chooseSpawnPoint(clock, placement)!;
    spawned.push(addSpawn(state, ports, 'trash', point));
  }
  if (spawned.length && populationCount(state) < ECOLOGY_CYCLE.maxPopulation) attachEgg(state, ports, spawned[0]);
  clock.openingSpawned = true;
  clock.spawnRemaining = nextTrashInterval(clock);
}

function synchronizeCarrierEggs(state: InventoryState): void {
  for (const egg of canonicalObjects(state)) {
    const carrierId = egg.ecology?.carrierId;
    if (egg.kind !== 'egg' || !carrierId) continue;
    const carrier = hasKey(state.objects, carrierId) ? state.objects[carrierId] : undefined;
    if (egg.owner === 'world' && carrier?.owner === 'world' && carrier.kind === 'trash' && (carrier.ecology?.food ?? 0) > 1e-9) {
      egg.x = carrier.x;
      egg.y = carrier.y;
      continue;
    }
    egg.ecology = {
      ...egg.ecology!, energy: 0, growthSeconds: 0, breedCooldown: 0, mated: false,
      food: 0, carrierId: null, disposition: 'carrier-cleared', wanderRemaining: 0,
    };
    egg.owner = 'disposed';
  }
}

function hatchEgg(item: CampaignObject): void {
  const ecology = item.ecology!;
  item.kind = 'bug';
  item.hp = 20;
  item.maxHp = 20;
  item.armor = 0;
  item.behavior = (['forager', 'breeder', 'swift'] as const)[ecology.wanderSeed % 3];
  item.age = 0;
  ecology.stage = 'small';
  ecology.energy = ECOLOGY_CYCLE.maxEnergy;
  ecology.growthSeconds = 0;
  ecology.breedCooldown = 0;
  ecology.mated = false;
  ecology.food = 0;
  ecology.carrierId = null;
  ecology.disposition = 'none';
  clearAction(ecology);
}

function grow(item: CampaignObject, dt: number): void {
  const ecology = item.ecology!;
  if ((ecology.stage !== 'small' && ecology.stage !== 'medium') || ecology.energy < ECOLOGY_CYCLE.growthEnergyThreshold) return;
  ecology.growthSeconds += dt;
  const required = ecology.stage === 'small' ? ECOLOGY_CYCLE.smallGrowthSeconds : ECOLOGY_CYCLE.mediumGrowthSeconds;
  if (ecology.growthSeconds + 1e-9 < required) return;
  ecology.stage = ecology.stage === 'small' ? 'medium' : 'adult';
  ecology.growthSeconds = 0;
}

function beginWander(item: CampaignObject): void {
  const ecology = item.ecology!;
  ecology.wanderX = EDGE + nextEntityRandom(ecology) * (1 - EDGE * 2);
  ecology.wanderY = EDGE + nextEntityRandom(ecology) * (1 - EDGE * 2);
  ecology.wanderRemaining = 28 + nextEntityRandom(ecology) * 52;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function displayHeading(dx: number, dy: number, placement: EcologyPlacement): number {
  return Math.atan2(dy * (placement.heightDip ?? 1), dx * (placement.widthDip ?? 1));
}

function foodAssignments(bugs: CampaignObject[], foods: CampaignObject[]): Map<string, CampaignObject> {
  const result = new Map<string, CampaignObject>();
  const slots = new Map<string, number>();
  const byId = new Map(foods.map(food => [food.id, food]));
  for (const bug of bugs) {
    const ecology = bug.ecology!;
    if (ecology.action !== 'feeding') continue;
    const target = typeof ecology.actionTargetId === 'string' ? byId.get(ecology.actionTargetId) : undefined;
    if (!target || ecology.energy >= ECOLOGY_CYCLE.maxEnergy - 1e-9
      || distance(bug, target) > FEED_DISTANCE || (slots.get(target.id) ?? 0) >= ECOLOGY_CYCLE.feedingSlots) {
      clearAction(ecology);
      continue;
    }
    slots.set(target.id, (slots.get(target.id) ?? 0) + 1);
    result.set(bug.id, target);
  }
  for (const bug of bugs) {
    const ecology = bug.ecology!;
    if (result.has(bug.id) || ecology.action) continue;
    const continuingMeal = foods.some(food => distance(bug, food) <= FEED_DISTANCE * 1.5
      && distance({ x: ecology.wanderX, y: ecology.wanderY }, food) <= 1e-9);
    if (ecology.energy >= ECOLOGY_CYCLE.hungerThreshold && !(continuingMeal && ecology.energy < ECOLOGY_CYCLE.maxEnergy - 1e-9)) continue;
    const nearest = [...foods].sort((left, right) => {
      const delta = distance(bug, left) - distance(bug, right);
      return Math.abs(delta) > 1e-12 ? delta : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    }).find(food => (slots.get(food.id) ?? 0) < ECOLOGY_CYCLE.feedingSlots);
    if (!nearest) continue;
    slots.set(nearest.id, (slots.get(nearest.id) ?? 0) + 1);
    ecology.wanderX = nearest.x;
    ecology.wanderY = nearest.y;
    result.set(bug.id, nearest);
  }
  return result;
}

function separationVector(item: CampaignObject, bugs: CampaignObject[], positions: Map<string, Point>): Point {
  const origin = positions.get(item.id)!;
  let x = 0;
  let y = 0;
  for (const other of bugs) {
    if (other.id === item.id) continue;
    const point = positions.get(other.id)!;
    let dx = origin.x - point.x;
    let dy = origin.y - point.y;
    let separation = Math.hypot(dx, dy);
    if (separation >= SEPARATION_DISTANCE) continue;
    const overlapping = separation < 1e-9;
    if (overlapping) {
      const angle = hashId(`${item.id}\u0000${other.id}`) / 0x1_0000_0000 * Math.PI * 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      separation = 1;
    }
    const strength = overlapping ? 1 : (SEPARATION_DISTANCE - separation) / SEPARATION_DISTANCE;
    x += dx / separation * strength;
    y += dy / separation * strength;
  }
  return { x, y };
}

function moveBug(item: CampaignObject, target: Point, bugs: CampaignObject[], positions: Map<string, Point>, dt: number): void {
  if (item.controlRemaining > 0) return;
  const ecology = item.ecology!;
  let dx = target.x - item.x;
  let dy = target.y - item.y;
  const separation = separationVector(item, bugs, positions);
  dx += separation.x * 0.18;
  dy += separation.y * 0.18;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude <= 1e-12) return;
  const speed = item.behavior === 'swift' ? 0.03 : ecology.stage === 'small' ? 0.016 : ecology.stage === 'medium' ? 0.014 : NORMAL_SPEED;
  const step = Math.min(speed * dt, magnitude);
  const moveX = dx / magnitude * step;
  const moveY = dy / magnitude * step;
  item.x = Math.max(0, Math.min(1, item.x + moveX));
  item.y = Math.max(0, Math.min(1, item.y + moveY));
  ecology.heading = Math.atan2(moveY, moveX);
}

interface NurseryTarget { id: string; point: Point }

function placementTargetId(point: Point): string {
  return `placement:${point.x}:${point.y}`;
}

function nurserySites(placement: EcologyPlacement, foods: CampaignObject[]): NurseryTarget[] {
  const verified = validPoints(placement);
  if (!verified.length) return [];
  const reachableFoods = foods.filter(food => verified.some(point => distance(food, point) <= 0.08));
  return [
    ...verified.map(point => ({ id: placementTargetId(point), point })),
    ...reachableFoods.map(food => ({ id: `food:${food.id}`, point: { x: food.x, y: food.y } })),
  ];
}

function nurserySite(female: CampaignObject, placement: EcologyPlacement, foods: CampaignObject[]): NurseryTarget | undefined {
  const candidates = nurserySites(placement, foods);
  candidates.sort((left, right) => {
    const delta = distance(female, left.point) - distance(female, right.point);
    return Math.abs(delta) > 1e-12 ? delta : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return candidates[0];
}

function matingEligible(item: CampaignObject, controlled: ReadonlySet<string>): boolean {
  const ecology = item.ecology!;
  return isCycleBug(item) && ecology.stage === 'adult' && (ecology.sex === 'female' || ecology.sex === 'male')
    && ecology.energy >= ECOLOGY_CYCLE.breedingEnergy && !controlled.has(item.id)
    && (ecology.sex !== 'female' || (!ecology.mated && ecology.breedCooldown <= 1e-9));
}

/** Heads point away from the shared tail contact; only an overlap gets a small deterministic pose nudge. */
function faceMatingPair(female: CampaignObject, male: CampaignObject, placement: EcologyPlacement): void {
  let dx = female.x - male.x;
  let dy = female.y - male.y;
  let magnitude = Math.hypot(dx, dy);
  if (magnitude < 1e-9) {
    const ordered = female.id < male.id ? `${female.id}\u0000${male.id}` : `${male.id}\u0000${female.id}`;
    const angle = hashId(ordered) / 0x1_0000_0000 * Math.PI * 2;
    dx = Math.cos(angle);
    dy = Math.sin(angle);
    magnitude = 1;
  }
  const axisX = dx / magnitude;
  const axisY = dy / magnitude;
  const dipScale = placement.widthDip && placement.heightDip
    ? Math.hypot(axisX * placement.widthDip, axisY * placement.heightDip) : 0;
  const poseDistance = dipScale > 1e-9 ? Math.min(MATING_DISTANCE, MATING_POSE_DISTANCE_DIP / dipScale) : MATING_POSE_DISTANCE;
  if (distance(female, male) < poseDistance) {
    const midpointX = (female.x + male.x) / 2;
    const midpointY = (female.y + male.y) / 2;
    female.x = Math.max(0, Math.min(1, midpointX + axisX * poseDistance / 2));
    female.y = Math.max(0, Math.min(1, midpointY + axisY * poseDistance / 2));
    male.x = Math.max(0, Math.min(1, midpointX - axisX * poseDistance / 2));
    male.y = Math.max(0, Math.min(1, midpointY - axisY * poseDistance / 2));
  }
  female.ecology!.heading = displayHeading(axisX, axisY, placement);
  male.ecology!.heading = displayHeading(-axisX, -axisY, placement);
}

function processMatingActions(bugs: CampaignObject[], controlled: ReadonlySet<string>, placement: EcologyPlacement, dt: number): Set<string> {
  const handled = new Set<string>();
  const byId = new Map(bugs.map(bug => [bug.id, bug]));
  for (const bug of bugs) {
    if (bug.ecology!.action !== 'mating' || handled.has(bug.id)) continue;
    const partner = typeof bug.ecology!.actionTargetId === 'string' ? byId.get(bug.ecology!.actionTargetId) : undefined;
    const pair = partner && partner.ecology!.action === 'mating' && partner.ecology!.actionTargetId === bug.id
      && matingEligible(bug, controlled) && matingEligible(partner, controlled)
      && bug.ecology!.sex !== partner.ecology!.sex && distance(bug, partner) <= MATING_DISTANCE + 1e-9;
    if (!pair) {
      clearAction(bug.ecology!);
      handled.add(bug.id);
      continue;
    }
    const female = bug.ecology!.sex === 'female' ? bug : partner;
    const male = female === bug ? partner : bug;
    faceMatingPair(female, male, placement);
    const elapsed = Math.min(elapsedAction(female.ecology!), elapsedAction(male.ecology!)) + dt;
    handled.add(female.id);
    handled.add(male.id);
    if (elapsed + 1e-9 >= ECOLOGY_CYCLE.matingSeconds) {
      female.ecology!.mated = true;
      clearAction(female.ecology!);
      clearAction(male.ecology!);
    } else {
      female.ecology!.actionElapsed = elapsed;
      male.ecology!.actionElapsed = elapsed;
    }
  }
  return handled;
}

function startMatingActions(bugs: CampaignObject[], controlled: ReadonlySet<string>, placement: EcologyPlacement, handled: Set<string>): void {
  const claimed = new Set(handled);
  for (const female of bugs) {
    if (claimed.has(female.id) || female.ecology!.action || female.ecology!.sex !== 'female'
      || !matingEligible(female, controlled)) continue;
    const male = bugs.filter(candidate => !claimed.has(candidate.id) && !candidate.ecology!.action
      && candidate.ecology!.sex === 'male' && matingEligible(candidate, controlled)
      && distance(female, candidate) <= MATING_DISTANCE).sort((left, right) => {
        const delta = distance(female, left) - distance(female, right);
        return Math.abs(delta) > 1e-12 ? delta : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })[0];
    if (!male) continue;
    faceMatingPair(female, male, placement);
    beginAction(female.ecology!, 'mating', male.id);
    beginAction(male.ecology!, 'mating', female.id);
    claimed.add(female.id);
    claimed.add(male.id);
    handled.add(female.id);
    handled.add(male.id);
  }
}

function resolveNurseryTarget(ecology: EntityEcology, placement: EcologyPlacement, foods: CampaignObject[]): NurseryTarget | undefined {
  if (ecology.action !== 'laying' || typeof ecology.actionTargetId !== 'string') return undefined;
  return nurserySites(placement, foods).find(target => target.id === ecology.actionTargetId
    && distance(target.point, { x: ecology.wanderX, y: ecology.wanderY }) <= 1e-9);
}

function processLayingActions(state: InventoryState, bugs: CampaignObject[], foods: CampaignObject[], placement: EcologyPlacement,
  controlled: ReadonlySet<string>, handled: Set<string>, dt: number, ports: EcologyCyclePorts): void {
  let population = populationCount(state);
  for (const female of bugs) {
    const ecology = female.ecology!;
    if (ecology.action !== 'laying') continue;
    handled.add(female.id);
    const target = resolveNurseryTarget(ecology, placement, foods);
    const valid = ecology.stage === 'adult' && ecology.sex === 'female' && ecology.mated
      && ecology.breedCooldown <= 1e-9 && ecology.energy >= ECOLOGY_CYCLE.breedingEnergy
      && !controlled.has(female.id) && !!foods.length && !!target
      && distance(female, target.point) <= FEED_DISTANCE
      && population + ECOLOGY_CYCLE.clutchSize <= ECOLOGY_CYCLE.maxPopulation;
    if (!valid) {
      clearAction(ecology);
      continue;
    }
    const elapsed = elapsedAction(ecology) + dt;
    if (elapsed + 1e-9 < ECOLOGY_CYCLE.layingSeconds) {
      ecology.actionElapsed = elapsed;
      continue;
    }
    for (let index = 0; index < ECOLOGY_CYCLE.clutchSize; index++) addSpawn(state, ports, 'egg', target.point);
    population += ECOLOGY_CYCLE.clutchSize;
    ecology.energy -= ECOLOGY_CYCLE.breedingCost;
    ecology.breedCooldown = ECOLOGY_CYCLE.breedingCooldown;
    ecology.mated = false;
    clearAction(ecology);
  }
}

function prepareNurseryTargets(state: InventoryState, bugs: CampaignObject[], foods: CampaignObject[], placement: EcologyPlacement,
  handled: ReadonlySet<string>): Map<string, NurseryTarget> {
  const targets = new Map<string, NurseryTarget>();
  const population = populationCount(state);
  for (const female of bugs) {
    const ecology = female.ecology!;
    if (handled.has(female.id) || ecology.action || ecology.stage !== 'adult' || ecology.sex !== 'female'
      || !ecology.mated || ecology.breedCooldown > 1e-9 || ecology.energy < ECOLOGY_CYCLE.breedingEnergy
      || population + ECOLOGY_CYCLE.clutchSize > ECOLOGY_CYCLE.maxPopulation || !foods.length) continue;
    const target = nurserySite(female, placement, foods);
    if (!target) continue;
    ecology.wanderX = target.point.x;
    ecology.wanderY = target.point.y;
    targets.set(female.id, target);
  }
  return targets;
}

function spawnAmbientTrash(state: InventoryState, clock: EcologyCycleClock, placement: EcologyPlacement, ports: EcologyCyclePorts): void {
  clock.spawnRemaining = Math.max(0, clock.spawnRemaining);
  if (clock.spawnRemaining > 1e-9) return;
  const trashCount = canonicalObjects(state).filter(item => item.owner === 'world' && item.kind === 'trash').length;
  if (trashCount >= ECOLOGY_CYCLE.maxWorldTrash) {
    clock.spawnRemaining = nextTrashInterval(clock);
    return;
  }
  const point = chooseSpawnPoint(clock, placement);
  if (!point) return;
  const trash = addSpawn(state, ports, 'trash', point);
  if (populationCount(state) < ECOLOGY_CYCLE.maxPopulation && nextCycleRandom(clock) < ECOLOGY_CYCLE.infectedTrashChance) {
    attachEgg(state, ports, trash);
  }
  clock.spawnRemaining = nextTrashInterval(clock);
}

/** Continuous v2 ecosystem. The wrapper owns fixed-step validation and ID allocation. */
export function stepEcologyCycle(state: InventoryState, clock: EcologyCycleClock, dt: number, placement: EcologyPlacement, ports: EcologyCyclePorts): void {
  const frozen = new Set(placement.frozenObjectIds ?? []);
  const openingWasPending = !clock.openingSpawned;
  spawnOpening(state, clock, placement, ports);
  const openedThisStep = openingWasPending && clock.openingSpawned === true;
  clock.seconds += dt;
  clock.stage = Math.max(clock.stage, clock.seconds >= 600 ? 4 : clock.seconds >= 300 ? 3 : clock.seconds >= 120 ? 2 : 1);
  synchronizeCarrierEggs(state);

  const before = canonicalObjects(state).filter(item => ports.exposed(item));
  const controlled = new Set(before.filter(item => item.owner === 'world' && !frozen.has(item.id)
    && item.controlRemaining > 1e-9).map(item => item.id));
  let pressure = 0;
  for (const item of before) {
    if (!item.ecology) item.ecology = createEntityEcology(item.id, item.kind);
    if (item.owner !== 'world') continue;
    if (frozen.has(item.id)) continue;
    if (item.kind === 'trash' || item.kind === 'corpse') pressure += item.pollution;
    if (isCycleBug(item)) {
      item.age += dt;
      item.controlRemaining = Math.max(0, item.controlRemaining - dt);
      item.ecology.breedCooldown = Math.max(0, item.ecology.breedCooldown - dt);
      item.ecology.energy = Math.max(0, item.ecology.energy - ECOLOGY_CYCLE.maxEnergy / ECOLOGY_CYCLE.starvationSeconds * dt);
      if (item.ecology.energy <= 1e-9) {
        item.kind = 'corpse';
        item.hp = 0;
        item.behavior = 'none';
        item.armor = 0;
        item.pollution = Math.max(0.5, item.pollution);
        markEcologyDead(item);
      }
    }
  }

  const bugs = canonicalObjects(state).filter(item => isCycleBug(item) && !frozen.has(item.id));
  const foods = canonicalObjects(state).filter(item => isCycleFood(item) && !frozen.has(item.id));
  const handled = processMatingActions(bugs, controlled, placement, dt);
  startMatingActions(bugs, controlled, placement, handled);
  processLayingActions(state, bugs, foods, placement, controlled, handled, dt, ports);
  for (const bug of bugs) {
    if (!controlled.has(bug.id)) continue;
    clearAction(bug.ecology!);
    handled.add(bug.id);
  }
  const nurseryTargets = prepareNurseryTargets(state, bugs, foods, placement, handled);
  const assignments = foodAssignments(bugs.filter(bug => !handled.has(bug.id) && !nurseryTargets.has(bug.id)), foods);
  const positions = new Map(bugs.map(item => [item.id, { x: item.x, y: item.y }]));
  for (const bug of bugs) {
    const ecology = bug.ecology!;
    if (handled.has(bug.id)) continue;
    const nursery = nurseryTargets.get(bug.id);
    const food = nursery ? undefined : assignments.get(bug.id);
    if (!food && !nursery) {
      const previousTargetWasFood = foods.some(candidate => distance({ x: ecology.wanderX, y: ecology.wanderY }, candidate) <= 1e-9);
      if (previousTargetWasFood) ecology.wanderRemaining = 0;
      ecology.wanderRemaining = Math.max(0, ecology.wanderRemaining - dt);
      if (ecology.wanderRemaining <= 1e-9 || distance(bug, { x: ecology.wanderX, y: ecology.wanderY }) <= 0.012) beginWander(bug);
    }
    const target = nursery?.point ?? food ?? { x: ecology.wanderX, y: ecology.wanderY };
    if (ecology.action !== 'feeding') moveBug(bug, target, bugs, positions, dt);
    if (nursery && distance(bug, nursery.point) <= FEED_DISTANCE) {
      beginAction(ecology, 'laying', nursery.id);
      continue;
    }
    if (food && distance(bug, food) <= FEED_DISTANCE && isCycleFood(food)) {
      const amount = Math.min(ECOLOGY_CYCLE.feedingPerSecond * dt, ECOLOGY_CYCLE.maxEnergy - ecology.energy, food.ecology!.food);
      ecology.heading = displayHeading(food.x - bug.x, food.y - bug.y, placement);
      if (amount > 1e-9) {
        if (ecology.action !== 'feeding' || ecology.actionTargetId !== food.id) beginAction(ecology, 'feeding', food.id);
        ecology.actionElapsed = elapsedAction(ecology) + amount / ECOLOGY_CYCLE.feedingPerSecond;
      } else clearAction(ecology);
      ecology.energy += amount;
      food.ecology!.food -= amount;
      if (ecology.energy >= ECOLOGY_CYCLE.maxEnergy - 1e-9) {
        clearAction(ecology);
        beginWander(bug);
      }
      if (food.ecology!.food <= 1e-9) {
        food.ecology!.food = 0;
        food.hp = 0;
        food.armor = 0;
        food.behavior = 'none';
        food.pollution = Math.max(0.5, food.pollution);
        food.ecology!.energy = 0;
        food.ecology!.breedCooldown = 0;
        food.ecology!.mated = false;
        food.ecology!.carrierId = null;
        food.ecology!.disposition = 'consumed';
        food.owner = 'disposed';
        clearAction(ecology);
      }
    } else if (ecology.action === 'feeding') clearAction(ecology);
  }
  for (const bug of bugs) {
    const ecology = bug.ecology!;
    if (ecology.action !== 'feeding') continue;
    const target = typeof ecology.actionTargetId === 'string' && hasKey(state.objects, ecology.actionTargetId)
      ? state.objects[ecology.actionTargetId] : undefined;
    if (!target || !isCycleFood(target)) clearAction(ecology);
  }

  synchronizeCarrierEggs(state);
  for (const egg of canonicalObjects(state).filter(item => isWorldEgg(item) && !frozen.has(item.id))) {
    egg.age += dt;
    egg.ecology!.growthSeconds += dt;
    if (egg.ecology!.growthSeconds + 1e-9 >= ECOLOGY_CYCLE.hatchSeconds) hatchEgg(egg);
  }
  for (const bug of canonicalObjects(state).filter(item => isCycleBug(item) && !frozen.has(item.id))) grow(bug, dt);

  clock.pollution = Math.min(100, Math.max(0, clock.pollution + pressure * dt * 0.01));
  if (!openedThisStep) clock.spawnRemaining = Math.max(0, clock.spawnRemaining - dt);
  spawnAmbientTrash(state, clock, placement, ports);
  clock.density = ports.density();
  clock.peakDensity = Math.max(clock.peakDensity, clock.density);
}

/** In-place, idempotent conversion from the legacy wave ecology to cycle v2. */
export function migrateEcologyCycle(state: InventoryState, clock: EcologyCycleClock): void {
  if (clock.cycleVersion === ECOLOGY_CYCLE.version) return;
  for (const item of canonicalObjects(state)) {
    if (item.kind === 'nest') {
      item.kind = 'corpse';
      item.hp = 0;
      item.maxHp = Math.max(0, item.maxHp);
      item.armor = 0;
      item.behavior = 'none';
      item.pollution = Math.max(0.5, item.pollution);
    }
    if (item.kind === 'elite') {
      item.kind = 'bug';
      item.hp = Math.min(20, item.hp);
      item.maxHp = 20;
      item.armor = 0;
      item.behavior = 'forager';
    }
    item.ecology = createEntityEcology(item.id, item.kind);
    if (item.kind === 'egg') item.ecology.growthSeconds = Math.min(ECOLOGY_CYCLE.hatchSeconds, item.age);
    if (item.kind === 'corpse') {
      item.ecology.energy = 0;
      item.ecology.breedCooldown = 0;
      item.ecology.mated = false;
      item.ecology.food = ECOLOGY_CYCLE.corpseNutrition;
      item.ecology.carrierId = null;
      item.ecology.disposition = 'none';
    }
  }
  synchronizeCarrierEggs(state);
  clock.cycleVersion = ECOLOGY_CYCLE.version;
  clock.openingSpawned = true;
}
