/** Pure campaign inventory and tool domain. Coordinates are normalized except swatter DIP input. */
export interface Point { x: number; y: number }
export type ObjectKind = 'trash' | 'egg' | 'bug' | 'elite' | 'nest' | 'corpse';
export type InventoryKind = 'world' | 'playerBag' | 'cleanerPack' | 'frogPouch' | 'trap' | 'corpsePile' | 'house' | 'disposed';
export interface CampaignObject extends Point {
  ecology?: import('./ecology-cycle-types').EntityEcology;
  id: string; kind: ObjectKind; owner: string; weight: number; cleanValue: number;
  hp: number; maxHp: number; armor: number; pollution: number;
  behavior: 'forager' | 'breeder' | 'swift' | 'armored' | 'nest' | 'none';
  age: number; attackRemaining: number; controlRemaining: number;
}
/** Pouches/catchers count individual objects; bags/packs and all other containers count weight. */
export interface Inventory { id: string; kind: InventoryKind; capacity: number; sealed: boolean }
export interface Receipt { signature: string; ok: boolean; reason: string }
export interface InventoryState {
  objects: Record<string, CampaignObject>; containers: Record<string, Inventory>;
  commands: Record<string, Receipt>;
  /** Monotonic tombstones for compacted ecology objects and autonomous receipts. */
  retired?: { ecologyThrough: number; commandTick: number; homeVisits: Record<string, number> };
}
export type AutonomousCommandPosition = { kind: 'tick'; tick: number; runId?: string }
  | { kind: 'home'; homeId: string; visit: number };
export function autonomousCommandPosition(commandId: string, depth = 0): AutonomousCommandPosition | null {
  if (depth > 8) return null;
  const digest = /^digest:(\d+)$/.exec(commandId);
  if (digest && Number.isSafeInteger(Number(digest[1]))) return { kind: 'tick', tick: Number(digest[1]) };
  const home = /^(home\.[^:]+):visit:(\d+):unload$/.exec(commandId);
  if (home && Number.isSafeInteger(Number(home[2]))) return { kind: 'home', homeId: home[1], visit: Number(home[2]) };
  try {
    const tuple: unknown = JSON.parse(commandId);
    if (!Array.isArray(tuple)) return null;
    if (tuple.length === 5 && tuple[0] === 'campaign-agent' && typeof tuple[1] === 'string'
      && typeof tuple[2] === 'string' && typeof tuple[3] === 'string' && Number.isSafeInteger(tuple[4]) && tuple[4] >= 0) {
      return { kind: 'tick', runId: tuple[1], tick: tuple[4] };
    }
    return typeof tuple[0] === 'string' ? autonomousCommandPosition(tuple[0], depth + 1) : null;
  } catch { return null; }
}
export function isAutonomousCommandRetired(state: InventoryState, commandId: string): boolean {
  if (!state.retired) return false;
  const position = autonomousCommandPosition(commandId);
  return position?.kind === 'tick' ? position.tick <= state.retired.commandTick
    : position?.kind === 'home' ? Object.prototype.hasOwnProperty.call(state.retired.homeVisits, position.homeId)
      && position.visit <= state.retired.homeVisits[position.homeId] : false;
}
export interface InventoryPort {
  transfer(commandId: string, ids: string[], from: string, to: string): Receipt;
}
export const hasKey = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
export const MAX_INVENTORY_COMMANDS = 50000;
export const MAX_COMMAND_ID_LENGTH = 512;
export const MAX_COMMAND_SIGNATURE_LENGTH = 16384;
/** Locale-independent UTF-16 code-unit order; never mutate the caller's collection. */
export function canonicalById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function canonicalObjects(state: InventoryState): CampaignObject[] {
  return canonicalById(Object.values(state.objects));
}
export function createInventory(): InventoryState {
  const containers: Record<string, Inventory> = {};
  for (const [id, kind, capacity, sealed] of [
    ['world', 'world', Number.MAX_SAFE_INTEGER, false], ['playerBag', 'playerBag', 8, true],
    ['cleanerPack', 'cleanerPack', 6, true], ['frogPouch', 'frogPouch', 4, true],
    ['disposed', 'disposed', Number.MAX_SAFE_INTEGER, true],
  ] as const) containers[id] = { id, kind, capacity, sealed };
  return { objects: {}, containers, commands: {} };
}
export function inventoryItems(state: InventoryState, owner: string): CampaignObject[] {
  return canonicalObjects(state).filter(item => item.owner === owner);
}
export function inventoryWeight(state: InventoryState, owner: string): number {
  return inventoryItems(state, owner).reduce((sum, item) => sum + item.weight, 0);
}
export function inventoryItemLoad(container: Inventory, item: CampaignObject): number {
  return container.kind === 'frogPouch' || container.kind === 'trap' ? 1 : item.weight;
}
export function inventoryLoad(state: InventoryState, owner: string): number {
  const container = state.containers[owner];
  if (!container) throw new Error('Missing inventory');
  return inventoryItems(state, owner).reduce((sum, item) => sum + inventoryItemLoad(container, item), 0);
}
/** Record failures as well as successes: replay cannot turn a failed old command into a new action. */
export function transact(state: InventoryState, commandId: string, signature: string, action: () => string | null): Receipt {
  if (!commandId || commandId.length > MAX_COMMAND_ID_LENGTH || signature.length > MAX_COMMAND_SIGNATURE_LENGTH) return { signature, ok: false, reason: 'invalid-command' };
  if (hasKey(state.commands, commandId)) {
    const receipt = state.commands[commandId];
    return receipt.signature === signature ? { ...receipt } : { signature, ok: false, reason: 'command-conflict' };
  }
  if (isAutonomousCommandRetired(state, commandId)) return { signature, ok: false, reason: 'command-expired' };
  if (Object.keys(state.commands).length >= MAX_INVENTORY_COMMANDS) return { signature, ok: false, reason: 'command-capacity' };
  const before = structuredClone(state);
  let reason: string | null;
  try { reason = action(); } catch (error) { Object.assign(state, before); throw error; }
  if (reason !== null) Object.assign(state, before);
  const receipt = { signature, ok: reason === null, reason: reason ?? 'ok' };
  Object.defineProperty(state.commands, commandId, { value: receipt, enumerable: true, writable: true, configurable: true });
  return { ...receipt };
}
export interface ResidueBatch extends Point { commandId: string; source: string; memberIds: string[]; sealed: true }
/** Receipt-backed grouping only: each member remains an individually owned, weighted corpse. */
export function releaseResidueBatch(state: InventoryState, commandId: string, source: string, point: Point, ids?: string[]): Receipt {
  let members = ids ? [...ids].sort() : inventoryItems(state, source).map(item => item.id);
  if (ids === undefined && hasKey(state.commands, commandId)) {
    try {
      const previous: unknown = JSON.parse(state.commands[commandId].signature);
      if (Array.isArray(previous) && previous[0] === 'residue-batch' && Array.isArray(previous[2]) && previous[2].every(value => typeof value === 'string')) members = previous[2];
    } catch { /* transact rejects a conflicting receipt below. */ }
  }
  const position = { x: point.x, y: point.y };
  return transact(state, commandId, JSON.stringify(['residue-batch', source, members, position]), () => {
    if (!hasKey(state.containers, source) || !['frogPouch', 'trap'].includes(state.containers[source].kind) || !state.containers[source].sealed) return 'invalid-container';
    if (![point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return 'invalid-position';
    if (!members.length) return 'empty';
    if (new Set(members).size !== members.length) return 'duplicate-members';
    const objects = members.map(id => hasKey(state.objects, id) ? state.objects[id] : undefined);
    if (objects.some(item => !item || item.owner !== source || item.kind !== 'corpse' || item.hp !== 0)) return 'not-residue';
    const weight = objects.reduce((sum, item) => sum + item!.weight, 0);
    if (!Number.isFinite(weight) || inventoryLoad(state, 'world') + weight > state.containers.world.capacity) return 'capacity';
    for (const item of objects) Object.assign(item!, { owner: 'world', x: point.x, y: point.y, age: 0, attackRemaining: 0, controlRemaining: 0, armor: 0, behavior: 'none' });
    return null;
  });
}
/** Read on inventory changes, not per rendered bug. Membership shrinks as the package is collected. */
export function residueBatches(state: InventoryState): ResidueBatch[] {
  const batches: ResidueBatch[] = [];
  const represented = new Set<string>();
  for (const commandId of Object.keys(state.commands).sort()) {
    const receipt = state.commands[commandId]; if (!receipt.ok) continue;
    let signature: unknown; try { signature = JSON.parse(receipt.signature); } catch { continue; }
    if (!Array.isArray(signature) || signature.length !== 4 || signature[0] !== 'residue-batch' || typeof signature[1] !== 'string' || !Array.isArray(signature[2])) continue;
    const point = signature[3] as Point | null;
    if (!point || ![point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) continue;
    const memberIds = signature[2].filter((id: unknown): id is string => typeof id === 'string' && !represented.has(id) && hasKey(state.objects, id) && state.objects[id].owner === 'world' && state.objects[id].kind === 'corpse' && state.objects[id].x === point.x && state.objects[id].y === point.y).sort();
    for (const id of memberIds) represented.add(id);
    if (memberIds.length) batches.push({ commandId, source: signature[1], memberIds, x: point.x, y: point.y, sealed: true });
  }
  return batches;
}
export function addObject(state: InventoryState, item: CampaignObject): void {
  const ecologyId = /^ecology:(\d+)$/.exec(item.id);
  if (ecologyId && state.retired && Number(ecologyId[1]) <= state.retired.ecologyThrough) throw new Error('Retired ecology object');
  if (!item.id || hasKey(state.objects, item.id) || hasKey(state.containers, item.id) || !hasKey(state.containers, item.owner)) throw new Error('Invalid or duplicate object');
  if (![item.weight, item.cleanValue, item.hp, item.maxHp, item.armor, item.pollution, item.age, item.attackRemaining, item.controlRemaining].every(v => Number.isFinite(v) && v >= 0)
    || item.weight <= 0 || item.hp > item.maxHp || ![item.x, item.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid object values');
  if (inventoryLoad(state, item.owner) + inventoryItemLoad(state.containers[item.owner], item) > state.containers[item.owner].capacity) throw new Error('Inventory full');
  Object.defineProperty(state.objects, item.id, { value: { ...item }, enumerable: true, writable: true, configurable: true });
}
export function transferObjects(state: InventoryState, commandId: string, ids: string[], from: string, to: string): Receipt {
  const sortedIds = [...ids].sort();
  const signature = JSON.stringify(['transfer', sortedIds, from, to]);
  return transact(state, commandId, signature, () => {
    if (!hasKey(state.containers, from) || !hasKey(state.containers, to) || from === to || ids.length === 0 || new Set(ids).size !== ids.length) return 'invalid-transfer';
    if (state.containers[from].kind === 'disposed' || state.containers[to].kind === 'disposed') return 'requires-disposal';
    const items = sortedIds.map(id => hasKey(state.objects, id) ? state.objects[id] : undefined);
    if (items.some(item => !item || item.owner !== from)) return 'ownership';
    const destination = state.containers[to];
    if (destination.kind !== 'world' && items.some(item => item && ['bug', 'elite', 'nest'].includes(item.kind))) return 'requires-capture';
    if (inventoryLoad(state, to) + items.reduce((sum, item) => sum + inventoryItemLoad(destination, item!), 0) > destination.capacity) return 'capacity';
    for (const item of items) {
      item!.owner = to;
      // A collected egg becomes an independent, frozen inventory item immediately.
      // Save validation runs at this command boundary, before the next ecology tick.
      if (item!.kind === 'egg' && item!.ecology) item!.ecology!.carrierId = null;
    }
    if (from === 'world' && to !== 'world') {
      const carriers = new Set(items.filter(item => item!.kind === 'trash').map(item => item!.id));
      for (const egg of Object.values(state.objects)) {
        if (egg.owner !== 'world' || egg.kind !== 'egg' || !egg.ecology?.carrierId || !carriers.has(egg.ecology.carrierId)) continue;
        egg.owner = 'disposed';
        Object.assign(egg.ecology, { disposition: 'carrier-cleared', carrierId: null, food: 0,
          energy: 0, mated: false, breedCooldown: 0, wanderRemaining: 0 });
      }
    }
    return null;
  });
}
export interface DisposalPort { clean(id: string, weight: number, value: number): void }
/** Call on a transaction draft when persistence is required; save draft and rewards together. */
export function emptyBag(state: InventoryState, commandId: string, binAvailable: boolean, rewards: DisposalPort, bag = 'playerBag'): Receipt {
  return transact(state, commandId, JSON.stringify(['empty', bag, binAvailable]), () => {
    if (!binAvailable) return 'bin-unavailable';
    if (!hasKey(state.containers, bag) || !['playerBag', 'cleanerPack', 'house'].includes(state.containers[bag].kind)) return 'invalid-container';
    const items = inventoryItems(state, bag);
    if (items.length === 0) return 'empty';
    if (items.some(item => ['bug', 'elite', 'nest'].includes(item.kind))) return 'requires-capture';
    for (const item of items) rewards.clean(item.id, item.weight, item.cleanValue);
    for (const item of items) item.owner = 'disposed';
    return null;
  });
}
/** A pile is a presentation group, never a single weight-one replacement for its members. */
export function pileTotals(state: InventoryState, pile: string): { count: number; weight: number; value: number; pollution: number } {
  return inventoryItems(state, pile).reduce((sum, item) => ({ count: sum.count + 1, weight: sum.weight + item.weight, value: sum.value + item.cleanValue, pollution: sum.pollution + item.pollution }), { count: 0, weight: 0, value: 0, pollution: 0 });
}
export interface SwatterState { active: boolean; gestureId: string; start: Point; end: Point; path: Point[]; hitIds: string[]; cooldown: number; heat: number; overheated: boolean }
export interface SwatterTarget extends Point { id: string; radius: number }
export const createSwatter = (): SwatterState => ({ active: false, gestureId: '', start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, path: [], hitIds: [], cooldown: 0, heat: 0, overheated: false });
export function beginSwatter(state: SwatterState, id: string, point: Point, inputOwned: boolean): boolean {
  if (!inputOwned || state.active || !id || ![point.x, point.y].every(Number.isFinite)) return false;
  state.active = true; state.gestureId = id; state.start = { ...point }; state.end = { ...point }; state.path = [{ ...point }]; state.hitIds = [];
  return true;
}
export function moveSwatter(state: SwatterState, point: Point, inside: boolean): void {
  if (!inside || ![point.x, point.y].every(Number.isFinite)) { cancelSwatter(state); return; }
  if (state.active) { state.end = { ...point }; state.path.push({ ...point }); }
}
export function cancelSwatter(state: SwatterState): void { state.active = false; state.path = []; state.hitIds = []; state.gestureId = ''; }
export function segmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx * dx + dy * dy === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t);
}
/** Only the fixed simulation step calls this, never native pointer event frequency. */
export function stepSwatter(state: SwatterState, dt: number, paused: boolean, targets: SwatterTarget[], hit: (id: string, commandId: string) => void, radius = 24, heatCapacity = 100): void {
  if (paused || !Number.isFinite(dt) || dt <= 0 || dt > 1 / 30) return;
  state.cooldown = Math.max(0, state.cooldown - dt);
  state.heat = Math.max(0, state.heat - dt * (state.active ? 5 : 30));
  if (state.heat <= 30) state.overheated = false;
  if (!state.active || state.overheated || state.cooldown > 1e-9) return;
  const path = state.path.length ? state.path : [state.start, state.end];
  const hits = canonicalById(targets).filter(target => !state.hitIds.includes(target.id) && path.some((point, i) => segmentDistance(target, i === 0 ? state.start : path[i - 1], point) <= radius + target.radius));
  state.start = { ...state.end }; state.path = [{ ...state.end }];
  if (!hits.length) return;
  state.cooldown = 0.25; state.heat = Math.min(heatCapacity, state.heat + 20); state.overheated = state.heat >= heatCapacity;
  for (const target of hits) { state.hitIds.push(target.id); hit(target.id, `swat:${state.gestureId}:${target.id}`); }
}
