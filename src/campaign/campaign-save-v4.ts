import { createRun, isTerminal, type RunState } from './campaign-controller';
import { migrateEcologyCycle } from './combat-ecology';
import { ECOLOGY_CYCLE, type EntityEcology } from './ecology-cycle-types';
import { BASE_RUN_ATTRIBUTES, DEVICE_PRICES, RUN_UPGRADES, deriveRunAttributes, effectiveScore, isEconomyConserved, isEconomyState, isRunUpgradeState, type RunUpgradeId } from './economy';
import { createMetaProgress, isMetaProgress, isResearchSettlementShape, settleResearch, validateResearchSettlement, type MetaProgress, type ResearchSettlement } from './research';
import { MAX_COMMAND_SIGNATURE_LENGTH, MAX_INVENTORY_COMMANDS, cancelSwatter, hasKey, inventoryLoad, type InventoryState } from './tool-system';

export interface GameSaveV4 {
  saveVersion: 4; profile: string; meta: MetaProgress; activeRun: RunState | null;
  recentSettlement: ResearchSettlement | null;
  legacyCompanion: { saveVersion: 1 | 2 | 3; source: unknown } | null;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => number(value) && Number.isSafeInteger(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const uniqueIds = (value: unknown): value is string[] => Array.isArray(value) && value.every(id) && new Set(value).size === value.length;
/** Limits apply before expensive cross-reference checks; oversized input is rejected, never truncated. */
export const V4_LIMITS = Object.freeze({ objects: 10000, containers: 2048, commands: MAX_INVENTORY_COMMANDS, events: 20004, history: 10000, path: 2048, signature: MAX_COMMAND_SIGNATURE_LENGTH, nodes: 500000, text: 16 * 1024 * 1024, depth: 32 });
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Invalid V4 save: ${message}`); }
function jsonBudget(value: unknown): void {
  const pending = [{ value, depth: 0 }], seen = new Set<object>(); let nodes = 0, text = 0;
  while (pending.length) {
    const next = pending.pop()!; nodes++;
    requireThat(nodes <= V4_LIMITS.nodes && next.depth <= V4_LIMITS.depth, 'document scale');
    if (typeof next.value === 'string') { text += next.value.length; requireThat(text <= V4_LIMITS.text, 'document text scale'); continue; }
    if (next.value === null || typeof next.value === 'boolean') continue;
    if (typeof next.value === 'number') { requireThat(Number.isFinite(next.value), 'JSON number'); continue; }
    requireThat(typeof next.value === 'object' && next.value !== null, 'JSON value');
    requireThat(!seen.has(next.value), 'cyclic or aliased JSON object'); seen.add(next.value);
    const prototype = Object.getPrototypeOf(next.value);
    requireThat(Array.isArray(next.value) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, 'JSON object type');
    requireThat(Object.getOwnPropertySymbols(next.value).length === 0, 'JSON symbol');
    if (Array.isArray(next.value)) requireThat(next.value.length <= V4_LIMITS.commands && Object.keys(next.value).length === next.value.length, 'array scale or holes');
    const entries = Object.getOwnPropertyDescriptors(next.value);
    requireThat(Object.keys(entries).length <= V4_LIMITS.commands + 1, 'collection scale');
    for (const [key, property] of Object.entries(entries)) {
      if (Array.isArray(next.value) && key === 'length') continue;
      requireThat('value' in property && property.enumerable, 'JSON accessor');
      text += key.length; requireThat(text <= V4_LIMITS.text, 'document text scale');
      pending.push({ value: property.value, depth: next.depth + 1 });
    }
  }
}
function keys(value: Record<string, unknown>, expected: string[]): void { requireThat(Object.keys(value).every(key => expected.includes(key)) && expected.every(key => hasKey(value, key)), 'unexpected or missing fields'); }
function point(value: Record<string, unknown>, normalized = true): void {
  requireThat(number(value.x) && number(value.y) && (!normalized || (value.x <= 1 && value.y <= 1)), 'position');
}
type EcologySchema = 'legacy' | 'cycle2';
function validateEntityEcology(value: unknown, item: Record<string, unknown>, objects: Record<string, unknown>): asserts value is EntityEcology {
  requireThat(object(value), 'object ecology');
  const hasAction = hasKey(value, 'action');
  keys(value, ['stage', 'sex', 'energy', 'growthSeconds', 'breedCooldown', 'mated', 'food', 'carrierId', 'wanderX', 'wanderY', 'wanderRemaining', 'wanderSeed', 'heading', 'disposition',
    ...(hasAction ? ['action', 'actionElapsed', 'actionTargetId'] : [])]);
  requireThat(['none', 'egg', 'small', 'medium', 'adult'].includes(String(value.stage))
    && ['none', 'male', 'female'].includes(String(value.sex))
    && ['none', 'consumed', 'carrier-cleared'].includes(String(value.disposition)), 'object ecology identity');
  for (const field of ['energy', 'growthSeconds', 'breedCooldown', 'food', 'wanderX', 'wanderY', 'wanderRemaining']) {
    requireThat(number(value[field]), `object ecology ${field}`);
  }
  requireThat(Number(value.energy) <= 100 && Number(value.wanderX) <= 1 && Number(value.wanderY) <= 1
    && integer(value.wanderSeed) && Number(value.wanderSeed) <= 0xffffffff
    && typeof value.heading === 'number' && Number.isFinite(value.heading)
    && typeof value.mated === 'boolean'
    && (value.carrierId === null || (id(value.carrierId) && hasKey(objects, value.carrierId))), 'object ecology fields');
  const stage = String(value.stage), sex = String(value.sex), kind = String(item.kind);
  const adultBody = ['small', 'medium', 'adult'].includes(stage) && ['male', 'female'].includes(sex);
  requireThat(
    (kind === 'trash' && stage === 'none' && sex === 'none')
      || (kind === 'egg' && stage === 'egg' && ['male', 'female'].includes(sex))
      || (['bug', 'elite'].includes(kind) && adultBody)
      || (kind === 'corpse' && ((stage === 'none' && sex === 'none') || adultBody))
      || (kind === 'nest' && stage === 'none' && sex === 'none'),
    'object ecology kind/stage/sex',
  );
  if (hasAction) {
    const action = String(value.action), targetId = value.actionTargetId;
    requireThat(['feeding', 'mating', 'laying'].includes(action)
      && number(value.actionElapsed)
      && (targetId === null || id(targetId))
      && ['bug', 'elite'].includes(kind) && item.owner === 'world' && Number(item.hp) > 0
      && value.disposition === 'none', 'object ecology action fields');
    if (action === 'feeding') {
      requireThat(typeof targetId === 'string' && targetId !== item.id, 'object ecology feeding action');
    } else if (action === 'mating') {
      requireThat(value.actionElapsed <= ECOLOGY_CYCLE.matingSeconds && stage === 'adult'
        && typeof targetId === 'string' && targetId !== item.id,
      'object ecology mating action');
    } else {
      requireThat(value.actionElapsed <= ECOLOGY_CYCLE.layingSeconds && stage === 'adult' && sex === 'female' && value.mated,
        'object ecology laying action');
    }
  }
  const carrier = value.carrierId === null ? null : objects[value.carrierId];
  requireThat(value.carrierId === null || (kind === 'egg' && item.owner === 'world' && object(carrier)
    && carrier.kind === 'trash' && carrier.owner === 'world'), 'object ecology carrier');
  if (kind === 'corpse') requireThat(value.energy === 0 && value.mated === false && value.breedCooldown === 0, 'corpse ecology');
  const systemInactive = item.owner === 'disposed' && value.food === 0 && value.carrierId === null
    && value.energy === 0 && value.mated === false && value.breedCooldown === 0;
  requireThat(
    value.disposition === 'none'
      || (value.disposition === 'consumed' && systemInactive && ['trash', 'corpse'].includes(kind))
      || (value.disposition === 'carrier-cleared' && systemInactive && kind === 'egg'),
    'object ecology disposition',
  );
}
function validateInventory(value: unknown, schema: EcologySchema): asserts value is InventoryState {
  requireThat(object(value), 'inventory');
  keys(value, ['objects', 'containers', 'commands', ...(schema === 'cycle2' && hasKey(value, 'retired') ? ['retired'] : [])]);
  requireThat(object(value.objects) && object(value.containers) && object(value.commands), 'inventory maps');
  requireThat(Object.keys(value.objects).length <= V4_LIMITS.objects && Object.keys(value.containers).length <= V4_LIMITS.containers && Object.keys(value.commands).length <= V4_LIMITS.commands, 'inventory scale');
  for (const [key, container] of Object.entries(value.containers)) {
    requireThat(object(container), 'container'); keys(container, ['id', 'kind', 'capacity', 'sealed']);
    requireThat(id(key) && container.id === key && ['world', 'playerBag', 'cleanerPack', 'frogPouch', 'trap', 'corpsePile', 'house', 'disposed'].includes(String(container.kind)) && number(container.capacity) && typeof container.sealed === 'boolean', 'container fields');
    requireThat(container.sealed === !['world', 'corpsePile'].includes(String(container.kind)), 'container seal');
  }
  for (const [key, item] of Object.entries(value.objects)) {
    requireThat(object(item), 'object');
    keys(item, ['id', 'kind', 'owner', 'weight', 'cleanValue', 'hp', 'maxHp', 'armor', 'pollution', 'behavior', 'age', 'attackRemaining', 'controlRemaining', 'x', 'y', ...(schema === 'cycle2' ? ['ecology'] : [])]);
    requireThat(id(key) && key === item.id && !hasKey(value.containers, key) && id(item.owner) && hasKey(value.containers, item.owner), 'object unique ownership');
    requireThat(['trash', 'egg', 'bug', 'elite', 'nest', 'corpse'].includes(String(item.kind)), 'object kind');
    for (const field of ['weight', 'cleanValue', 'hp', 'maxHp', 'armor', 'pollution', 'age', 'attackRemaining', 'controlRemaining']) requireThat(number(item[field]), `object ${field}`);
    requireThat(Number(item.weight) > 0 && integer(item.cleanValue) && Number(item.hp) <= Number(item.maxHp), 'object values');
    requireThat(['forager', 'breeder', 'swift', 'armored', 'nest', 'none'].includes(String(item.behavior)), 'behavior'); point(item);
    if (['bug', 'elite', 'nest'].includes(String(item.kind))) requireThat(item.owner === 'world' && Number(item.hp) > 0, 'live object ownership');
    else requireThat(item.hp === 0, 'residue hp');
    if (schema === 'cycle2') validateEntityEcology(item.ecology, item, value.objects);
  }
  const inventory = value as unknown as InventoryState;
  for (const container of Object.values(inventory.containers)) requireThat(inventoryLoad(inventory, container.id) <= container.capacity, 'inventory capacity');
  for (const [key, receipt] of Object.entries(value.commands)) {
    requireThat(id(key) && object(receipt), 'command receipt'); keys(receipt, ['signature', 'ok', 'reason']);
    requireThat(typeof receipt.signature === 'string' && receipt.signature.length <= V4_LIMITS.signature && typeof receipt.ok === 'boolean' && id(receipt.reason) && receipt.ok === (receipt.reason === 'ok'), 'command receipt fields');
  }
  if (schema === 'cycle2' && hasKey(value, 'retired')) {
    const retired = value.retired;
    requireThat(object(retired), 'retired inventory history');
    keys(retired, ['ecologyThrough', 'commandTick', 'homeVisits']);
    requireThat(integer(retired.ecologyThrough) && integer(retired.commandTick) && object(retired.homeVisits)
      && Object.keys(retired.homeVisits).length <= 2, 'retired inventory history fields');
    for (const [houseId, visits] of Object.entries(retired.homeVisits)) requireThat(id(houseId) && integer(visits), 'retired home visits');
  }
  for (const [key, kind] of [['world', 'world'], ['playerBag', 'playerBag'], ['cleanerPack', 'cleanerPack'], ['frogPouch', 'frogPouch'], ['disposed', 'disposed']]) requireThat(inventory.containers[key]?.kind === kind, 'required inventory');
}
function validateRunSchema(value: unknown, schema: EcologySchema): asserts value is RunState {
  requireThat(object(value), 'run');
  keys(value, ['runId', 'missionId', 'phase', 'pauseReasons', 'tick', 'ecology', 'inventory', 'economy', 'upgrades', 'researchNodes', 'actors', 'houses', 'traps', 'trapSlots', 'retreatSeconds', 'pressureSeconds', 'victorySeconds', 'swatter', 'frogUnlocked']);
  requireThat(id(value.runId) && id(value.missionId) && ['preparation', 'running', 'retreat', 'siege', 'victory', 'defeat', 'abandoned'].includes(String(value.phase)) && uniqueIds(value.pauseReasons), 'run identity');
  requireThat(integer(value.tick) && value.tick < Number.MAX_SAFE_INTEGER && typeof value.frogUnlocked === 'boolean', 'run clock');
  for (const field of ['retreatSeconds', 'pressureSeconds', 'victorySeconds']) requireThat(number(value[field]), `run ${field}`);
  requireThat(integer(value.trapSlots) && value.trapSlots >= 3 && value.trapSlots <= 5, 'trap slots');
  requireThat(object(value.economy) && Array.isArray(value.economy.events) && value.economy.events.length <= V4_LIMITS.events && object(value.economy.purchases) && Object.keys(value.economy.purchases).length <= V4_LIMITS.commands, 'economy scale');
  keys(value.economy, ['parts', 'events', 'purchases', ...(schema === 'cycle2' && hasKey(value.economy, 'archived') ? ['archived'] : [])]);
  if (schema === 'cycle2' && hasKey(value.economy, 'archived')) {
    const archived = value.economy.archived;
    requireThat(object(archived), 'archived economy');
    keys(archived, ['earnedParts', 'cleanWeight', 'normalKills', 'eliteKills', 'nestKills']);
    for (const field of ['earnedParts', 'normalKills', 'eliteKills', 'nestKills']) requireThat(integer(archived[field]), `archived economy ${field}`);
    requireThat(number(archived.cleanWeight) && Number(archived.cleanWeight) <= Number.MAX_SAFE_INTEGER, 'archived economy cleanWeight');
  }
  requireThat(isEconomyState(value.economy) && isEconomyConserved(value.economy) && isRunUpgradeState(value.upgrades), 'economy conservation or upgrades');
  keys(value.upgrades as unknown as Record<string, unknown>, ['levels']);
  for (const event of value.economy.events) keys(event as unknown as Record<string, unknown>, ['id', 'kind', 'targetId', 'parts', 'weight', 'enemy', 'stage']);
  requireThat(uniqueIds(value.researchNodes) && isMetaProgress({ ...createMetaProgress(), nodes: value.researchNodes }), 'research snapshot');
  validateInventory(value.inventory, schema);
  requireThat(object(value.ecology), 'ecology');
  keys(value.ecology, ['stage', 'seconds', 'pollution', 'density', 'peakDensity', 'seed', 'nextId', 'spawnRemaining', 'nestSpawned', 'nestDestroyed', ...(schema === 'cycle2' ? ['cycleVersion', 'openingSpawned'] : [])]);
  const ecology = value.ecology;
  requireThat(integer(ecology.stage) && ecology.stage >= 1 && ecology.stage <= 4 && number(ecology.seconds) && integer(ecology.seed) && ecology.seed <= 0xffffffff && integer(ecology.nextId) && ecology.nextId > 0 && ecology.nextId < Number.MAX_SAFE_INTEGER && number(ecology.spawnRemaining), 'ecology clock');
  for (const field of ['pollution', 'density', 'peakDensity']) requireThat(number(ecology[field]) && Number(ecology[field]) <= 100, `ecology ${field}`);
  requireThat(typeof ecology.nestSpawned === 'boolean' && typeof ecology.nestDestroyed === 'boolean' && (!ecology.nestDestroyed || ecology.nestSpawned), 'nest flags');
  if (schema === 'cycle2') requireThat(ecology.cycleVersion === 2 && typeof ecology.openingSpawned === 'boolean', 'ecology cycle');
  const retired = (value.inventory as unknown as Record<string, unknown>).retired;
  if (schema === 'cycle2' && retired !== undefined) {
    const history = retired as { ecologyThrough: number; commandTick: number };
    requireThat(history.ecologyThrough < Number(ecology.nextId) && history.commandTick <= Number(value.tick), 'retired inventory cutoff');
  }
  requireThat(Array.isArray(value.houses) && value.houses.length === 2, 'two houses');
  const houseIds = new Set<string>();
  for (const house of value.houses) {
    requireThat(object(house), 'house'); keys(house, ['id', 'x', 'y', 'hp', 'maxHp', 'repaired', 'locked']); point(house);
    requireThat(id(house.id) && !houseIds.has(house.id) && value.inventory.containers[house.id]?.kind === 'house' && number(house.hp) && number(house.maxHp) && house.maxHp > 0 && house.hp <= house.maxHp && typeof house.repaired === 'boolean' && typeof house.locked === 'boolean', 'house fields');
    houseIds.add(house.id);
    if (value.phase === 'retreat' || value.phase === 'siege') requireThat(house.locked, 'retreat locks houses');
  }
  if (schema === 'cycle2' && retired !== undefined) {
    const homeVisits = (retired as { homeVisits: Record<string, number> }).homeVisits;
    requireThat(Object.keys(homeVisits).every(houseId => houseIds.has(houseId)), 'retired home visit identity');
  }
  requireThat(Array.isArray(value.actors) && value.actors.length === 2, 'two actors');
  const actorIds = new Set<string>(), actorInventories = new Set<string>(), actorHomes = new Set<string>(), roles = new Set<string>();
  for (const actor of value.actors) {
    requireThat(object(actor), 'actor'); keys(actor, ['id', 'archetype', 'inventoryId', 'houseId', 'atHome', 'pose']);
    requireThat(id(actor.id) && !actorIds.has(actor.id) && !hasKey(value.inventory.objects, actor.id) && ['cleaner', 'frog'].includes(String(actor.archetype)) && id(actor.inventoryId) && !actorInventories.has(actor.inventoryId) && id(actor.houseId) && houseIds.has(actor.houseId) && !actorHomes.has(actor.houseId) && typeof actor.atHome === 'boolean', 'actor fields');
    requireThat(value.inventory.containers[actor.inventoryId]?.kind === (actor.archetype === 'frog' ? 'frogPouch' : 'cleanerPack'), 'actor inventory');
    requireThat(object(actor.pose), 'actor pose');
    keys(actor.pose, ['x', 'y', 'vx', 'vy', 'stamina', 'appearanceId', 'activity', 'motion', 'taskId']); point(actor.pose);
    requireThat(typeof actor.pose.vx === 'number' && Number.isFinite(actor.pose.vx) && typeof actor.pose.vy === 'number' && Number.isFinite(actor.pose.vy) && number(actor.pose.stamina) && actor.pose.stamina <= 100 && id(actor.pose.appearanceId) && ['idle', 'travelling', 'working', 'returning-home', 'entering-home', 'resting', 'exiting-home', 'unavailable'].includes(String(actor.pose.activity)) && ['walking', 'climbing', 'jumping', 'falling', 'landing'].includes(String(actor.pose.motion)) && (actor.pose.taskId === null || (id(actor.pose.taskId) && hasKey(value.inventory.objects, actor.pose.taskId))), 'actor pose fields');
    actorIds.add(actor.id); actorInventories.add(actor.inventoryId); actorHomes.add(actor.houseId); roles.add(String(actor.archetype));
    if (value.phase === 'siege') requireThat(actor.atHome, 'siege resident');
  }
  requireThat(roles.size === 2, 'actor roles');
  requireThat(Array.isArray(value.traps), 'traps'); const trapIds = new Set<string>();
  for (const trap of value.traps) {
    requireThat(object(trap), 'trap'); keys(trap, ['id', 'kind', 'x', 'y', 'remaining', 'uses', 'paid', 'purchaseCommandId', 'inventoryId']); point(trap);
    requireThat(id(trap.id) && !trapIds.has(trap.id) && !hasKey(value.inventory.objects, trap.id) && !actorIds.has(trap.id) && !houseIds.has(trap.id) && ['bait', 'glue', 'catcher', 'ladder'].includes(String(trap.kind)) && trap.y === 1 && number(trap.remaining) && integer(trap.uses) && integer(trap.paid), 'trap fields');
    requireThat(trap.kind === 'catcher' ? trap.inventoryId === trap.id && value.inventory.containers[trap.id]?.kind === 'trap' : trap.inventoryId === null, 'trap inventory');
    requireThat(id(trap.purchaseCommandId) && value.economy.purchases[JSON.stringify(['spend', trap.purchaseCommandId])] === trap.paid, 'trap payment');
    trapIds.add(trap.id);
  }
  const traps = value.traps as unknown as RunState['traps'];
  requireThat(traps.filter(trap => trap.kind === 'ladder').length <= 1 && traps.filter(trap => trap.kind !== 'ladder').length <= value.trapSlots, 'trap limits');
  requireThat(object(value.swatter), 'swatter'); const swatter = value.swatter;
  keys(swatter, ['active', 'gestureId', 'start', 'end', 'path', 'hitIds', 'cooldown', 'heat', 'overheated']);
  requireThat(typeof swatter.active === 'boolean' && typeof swatter.gestureId === 'string' && uniqueIds(swatter.hitIds) && number(swatter.cooldown) && number(swatter.heat) && swatter.heat <= deriveRunAttributes(value.upgrades, value.researchNodes).swatHeat && typeof swatter.overheated === 'boolean' && Array.isArray(swatter.path), 'swatter fields');
  for (const p of [swatter.start, swatter.end, ...swatter.path]) { requireThat(object(p), 'swatter point'); keys(p, ['x', 'y']); point(p, false); }
  for (const event of value.economy.events) {
    if (event.kind === 'milestone') continue;
    requireThat(hasKey(value.inventory.objects, event.targetId), 'reward object reference');
    const item = value.inventory.objects[event.targetId];
    if (event.kind === 'clean') requireThat(item.owner === 'disposed' && event.weight === item.weight && event.parts === item.cleanValue, 'clean reward ownership');
    else requireThat(item.kind === 'corpse', 'kill residue');
  }
  for (const item of Object.values(value.inventory.objects)) if (item.owner === 'disposed') {
    const clean = value.economy.events.some(event => event.kind === 'clean' && event.targetId === item.id);
    const system = item.ecology?.disposition === 'consumed' || item.ecology?.disposition === 'carrier-cleared';
    requireThat(system ? !clean : value.economy.events.some(event => event.id === `clean:${item.id}`), 'disposal receipt');
  }
  crossValidateRun(value as unknown as RunState);
}
export function validateRun(value: unknown): asserts value is RunState { validateRunSchema(value, 'cycle2'); }

function crossValidateRun(run: RunState): void {
  const attrs = deriveRunAttributes(run.upgrades, run.researchNodes);
  for (const item of Object.values(run.inventory.objects)) {
    const kind = run.inventory.containers[item.owner].kind;
    if (kind === 'frogPouch' || kind === 'trap') {
      requireThat(item.kind === 'corpse' && item.hp === 0 && item.behavior === 'none' && item.armor === 0 && item.attackRemaining === 0 && item.controlRemaining === 0, 'sealed residue timers');
      // Per-member elapsed time remains valid if a just-purchased upgrade shortens the threshold.
      requireThat(kind === 'frogPouch' ? item.age <= BASE_RUN_ATTRIBUTES.digestionSeconds && Math.abs(item.age * 60 - Math.round(item.age * 60)) < 1e-8 : item.age === 0, 'sealed residue age');
    }
  }
  for (const [name, capacity] of [['playerBag', attrs.bagCapacity], ['cleanerPack', attrs.cleanerCapacity], ['frogPouch', attrs.frogCapacity]] as const) requireThat(run.inventory.containers[name].capacity === capacity, 'derived inventory capacity');
  for (const house of run.houses) requireThat(house.maxHp === attrs.homeMaxHp && house.y === 1, 'derived house HP/ground');
  requireThat(run.trapSlots === 3 + (run.researchNodes.includes('trap-2') ? 1 : 0) + (run.researchNodes.includes('trap-4') ? 1 : 0), 'derived trap slots');
  const upgradeCosts = new Map<RunUpgradeId, number[]>(), repairs = new Map<string, number>();
  const payment = (command: string) => run.economy.purchases[JSON.stringify(['spend', command])];
  const refunded = (command: string) => Object.keys(run.economy.purchases).some(key => { const tuple = JSON.parse(key); return ['refund', 'unused-refund'].includes(tuple[0]) && tuple[1] === command; });
  for (const [commandId, receipt] of Object.entries(run.inventory.commands)) {
    if (!receipt.ok) continue;
    let signature: unknown;
    try { signature = JSON.parse(receipt.signature); } catch { continue; }
    if (!Array.isArray(signature)) continue;
    if (signature[0] === 'residue-batch') {
      requireThat(signature.length === 4 && typeof signature[1] === 'string' && hasKey(run.inventory.containers, signature[1]) && ['frogPouch', 'trap'].includes(run.inventory.containers[signature[1]].kind) && uniqueIds(signature[2]) && signature[2].length > 0 && signature[2].length <= run.inventory.containers[signature[1]].capacity && object(signature[3]), 'residue batch receipt');
      const sorted = [...signature[2]].sort();
      requireThat(sorted.every((id, index) => id === signature[2][index] && hasKey(run.inventory.objects, id) && run.inventory.objects[id].kind === 'corpse'), 'residue batch membership');
      keys(signature[3], ['x', 'y']); point(signature[3]);
    }
    if (signature[0] === 'upgrade') {
      requireThat(signature.length === 2 && hasKey(RUN_UPGRADES, signature[1]), 'upgrade receipt');
      const upgradeId = signature[1] as RunUpgradeId, purchaseId = `upgrade:${commandId}`;
      requireThat(integer(payment(purchaseId)) && !refunded(purchaseId), 'upgrade payment');
      const costs = upgradeCosts.get(upgradeId) ?? [];
      requireThat(costs.length < 3, 'upgrade count'); costs.push(payment(purchaseId)); upgradeCosts.set(upgradeId, costs);
    }
    if (signature[0] === 'repair') {
      requireThat(signature.length === 2 && run.houses.some(house => house.id === signature[1]) && payment(`repair:${commandId}`) === DEVICE_PRICES.repairPack && !refunded(`repair:${commandId}`), 'repair payment');
      requireThat(!repairs.has(signature[1]), 'duplicate repair'); repairs.set(signature[1], 1);
    }
  }
  for (const upgradeId of Object.keys(RUN_UPGRADES) as RunUpgradeId[]) {
    const costs = (upgradeCosts.get(upgradeId) ?? []).sort((a, b) => a - b), level = run.upgrades.levels[upgradeId] ?? 0;
    requireThat(costs.length === level && costs.every((cost, index) => cost === RUN_UPGRADES[upgradeId].cost * 2 ** index), 'upgrade levels/payments');
  }
  for (const house of run.houses) requireThat((repairs.get(house.id) ?? 0) === (house.repaired ? 1 : 0), 'repair flag/payment');
  const trapPayments = new Set<string>();
  for (const trap of run.traps) {
    requireThat(trap.paid === DEVICE_PRICES[trap.kind] && !trapPayments.has(trap.purchaseCommandId) && !refunded(trap.purchaseCommandId), 'trap price/payment');
    trapPayments.add(trap.purchaseCommandId);
    requireThat(trap.purchaseCommandId.startsWith('trap:'), 'trap purchase identity');
    const placement = run.inventory.commands[trap.purchaseCommandId.slice(5)];
    requireThat(placement?.ok, 'trap placement receipt');
    let signature: unknown; try { signature = JSON.parse(placement.signature); } catch { throw new Error('Invalid V4 save: trap placement signature'); }
    requireThat(Array.isArray(signature) && signature.length === 5 && signature[0] === 'place' && signature[1] === trap.id && signature[2] === trap.kind && object(signature[3]) && signature[3].x === trap.x && signature[3].y === trap.y && signature[4] === true, 'trap placement signature');
    requireThat(trap.remaining <= 60 && (trap.kind === 'bait' || trap.remaining === 0), 'trap duration');
    requireThat(trap.kind === 'glue' ? trap.uses <= 12 : trap.kind === 'catcher' ? trap.uses <= Object.keys(run.inventory.objects).length : trap.uses === 0, 'trap uses');
    requireThat(run.inventory.containers[trap.id]?.kind === 'trap' && run.inventory.containers[trap.id].capacity === (trap.kind === 'catcher' ? 6 : 0), 'trap capacity');
  }
  const tasks = new Set<string>();
  for (const actor of run.actors) {
    const pose = actor.pose, house = run.houses.find(value => value.id === actor.houseId)!;
    requireThat(!hasKey(run.inventory.containers, actor.id), 'actor/container identity');
    if (pose.taskId !== null) {
      const target = run.inventory.objects[pose.taskId];
      requireThat(!tasks.has(pose.taskId) && target.owner === 'world' && !actor.atHome && run.phase === 'running' && ['travelling', 'working'].includes(pose.activity), 'task ownership/activity');
      requireThat(actor.archetype === 'frog' ? target.kind === 'bug' : ['trash', 'corpse', 'egg'].includes(target.kind), 'task role'); tasks.add(pose.taskId);
    }
    requireThat(!['working', 'travelling'].includes(pose.activity) || pose.taskId !== null, 'working task');
    if (actor.atHome) requireThat(pose.taskId === null && pose.vx === 0 && pose.vy === 0 && ['resting', 'unavailable', 'entering-home', 'exiting-home'].includes(pose.activity), 'atHome pose');
    if (run.phase === 'siege') requireThat(actor.atHome && pose.x === house.x && pose.y === house.y && ['resting', 'unavailable'].includes(pose.activity), 'siege pose');
    if (run.phase === 'retreat') requireThat(pose.taskId === null, 'retreat task');
  }
  const swatter = run.swatter;
  requireThat(swatter.cooldown <= 0.25 && swatter.path.length <= V4_LIMITS.path && swatter.hitIds.length <= V4_LIMITS.objects && swatter.hitIds.every(key => hasKey(run.inventory.objects, key)), 'swatter limits');
  requireThat(!swatter.overheated || swatter.heat > 30, 'swatter heat latch');
  if (swatter.active) {
    const end = swatter.path[swatter.path.length - 1];
    requireThat(id(swatter.gestureId) && run.phase !== 'preparation' && !isTerminal(run) && run.pauseReasons.length === 0 && end && end.x === swatter.end.x && end.y === swatter.end.y, 'active swatter');
  } else requireThat(swatter.gestureId === '' && swatter.path.length === 0 && swatter.hitIds.length === 0, 'inactive swatter');
}
export function createGameSaveV4(profile = 'local'): GameSaveV4 {
  if (!/^(local|steam:[0-9]{1,20})$/.test(profile)) throw new Error('Invalid profile');
  return { saveVersion: 4, profile, meta: createMetaProgress(), activeRun: null, recentSettlement: null, legacyCompanion: null };
}
function validateGameSaveV4Schema(value: unknown, expectedProfile: string | undefined, schema: EcologySchema): GameSaveV4 {
  requireThat(object(value), 'document');
  if (value.saveVersion !== 4) throw new Error('Unsupported save version; preserve original file');
  jsonBudget(value);
  keys(value, ['saveVersion', 'profile', 'meta', 'activeRun', 'recentSettlement', 'legacyCompanion']);
  requireThat(typeof value.profile === 'string' && /^(local|steam:[0-9]{1,20})$/.test(value.profile) && (!expectedProfile || value.profile === expectedProfile), 'profile');
  requireThat(isMetaProgress(value.meta), 'meta');
  requireThat(value.meta.completedMissions.length <= V4_LIMITS.history && value.meta.settledRunIds.length <= V4_LIMITS.history, 'meta history scale');
  keys(value.meta as unknown as Record<string, unknown>, ['researchPoints', 'nodes', 'completedMissions', 'firstAttemptGranted', 'settledRunIds', 'frogUnlocked', 'appearanceId']);
  if (value.activeRun !== null) validateRunSchema(value.activeRun, schema);
  if (value.activeRun) {
    const metaNodes = value.meta.nodes;
    requireThat((value.activeRun as RunState).researchNodes.length === metaNodes.length && (value.activeRun as RunState).researchNodes.every(node => metaNodes.includes(node)), 'active research snapshot');
  }
  if (value.recentSettlement !== null) {
    requireThat(object(value.recentSettlement), 'settlement'); const result = value.recentSettlement;
    keys(result, ['runId', 'missionId', 'outcome', 'researchReward', 'score', 'breakdown']);
    requireThat(isResearchSettlementShape(result) && id(result.runId) && id(result.missionId) && value.meta.settledRunIds.includes(result.runId), 'settlement fields');
    requireThat(object(result.breakdown), 'settlement breakdown'); keys(result.breakdown, ['base', 'milestones', 'firstVictory', 'firstAttempt']);
    requireThat((result.outcome !== 'victory' || value.meta.completedMissions.includes(result.missionId)) && (result.score < 20 || value.meta.firstAttemptGranted), 'settlement permanent markers');
  }
  if (value.activeRun && isTerminal(value.activeRun as RunState)) {
    const run = value.activeRun as RunState;
    requireThat(object(value.recentSettlement) && value.recentSettlement.runId === run.runId && value.recentSettlement.missionId === run.missionId && value.recentSettlement.outcome === run.phase && value.recentSettlement.score === effectiveScore(run.economy) && validateResearchSettlement(value.recentSettlement, run.economy, value.meta), 'terminal atomic settlement');
  } else if (value.activeRun) requireThat(!value.meta.settledRunIds.includes((value.activeRun as RunState).runId), 'settled active run');
  if (value.legacyCompanion !== null) {
    requireThat(object(value.legacyCompanion), 'legacy slot'); keys(value.legacyCompanion, ['saveVersion', 'source']);
    requireThat([1, 2, 3].includes(value.legacyCompanion.saveVersion as number) && object(value.legacyCompanion.source) && value.legacyCompanion.source.saveVersion === value.legacyCompanion.saveVersion, 'legacy slot version');
  }
  return structuredClone(value) as unknown as GameSaveV4;
}
export function validateGameSaveV4(value: unknown, expectedProfile?: string): GameSaveV4 {
  return validateGameSaveV4Schema(value, expectedProfile, 'cycle2');
}
/** Upgrade the pre-cycle V4 shape exactly once. A present cycleVersion is always current-schema
 * authority, so malformed V2 documents are rejected instead of being repaired as legacy data. */
export function migrateGameSaveV4Ecology(value: unknown, expectedProfile?: string): { save: GameSaveV4; migrated: boolean } {
  if (!object(value) || value.activeRun === null) return { save: validateGameSaveV4(value, expectedProfile), migrated: false };
  requireThat(object(value.activeRun), 'run');
  requireThat(object(value.activeRun.ecology), 'ecology');
  if (hasKey(value.activeRun.ecology, 'cycleVersion')) {
    return { save: validateGameSaveV4(value, expectedProfile), migrated: false };
  }
  const save = validateGameSaveV4Schema(value, expectedProfile, 'legacy');
  const run = save.activeRun!;
  migrateEcologyCycle(run.inventory, run.ecology);
  if (run.phase === 'retreat' || run.phase === 'siege') {
    run.phase = 'running';
    run.retreatSeconds = 0; run.pressureSeconds = 0; run.victorySeconds = 0;
    for (const house of run.houses) house.locked = false;
    for (const actor of run.actors) {
      actor.atHome = false;
      actor.pose.taskId = null; actor.pose.vx = 0; actor.pose.vy = 0; actor.pose.activity = 'idle';
    }
  }
  return { save: validateGameSaveV4(save, expectedProfile), migrated: true };
}
/** Caller retains rawBackup verbatim in the old profile backup. No legacy value becomes research. */
export function migrateLegacySave(raw: string, validateLegacy: (value: unknown) => unknown, profile = 'local'): { save: GameSaveV4; rawBackup: string } {
  requireThat(raw.length <= V4_LIMITS.text, 'legacy text scale');
  const parsed: unknown = JSON.parse(raw);
  requireThat(object(parsed) && [1, 2, 3].includes(parsed.saveVersion as number), 'legacy version');
  const validated = validateLegacy(parsed);
  requireThat(object(validated) && validated.saveVersion === parsed.saveVersion, 'legacy validation');
  const save = createGameSaveV4(profile);
  save.legacyCompanion = { saveVersion: parsed.saveVersion as 1 | 2 | 3, source: structuredClone(validated) };
  return { save: validateGameSaveV4(save), rawBackup: raw };
}
export function startCampaignInSave(save: GameSaveV4, runId: string, missionId = 'demo-1', seed = 1): void {
  if (save.activeRun || save.meta.settledRunIds.includes(runId)) throw new Error('Run already exists');
  save.activeRun = createRun(runId, missionId, seed, save.meta.frogUnlocked, save.meta.nodes);
  save.activeRun.actors[0].pose.appearanceId = save.meta.appearanceId;
}
export function settleCampaignInSave(save: GameSaveV4): ResearchSettlement | null {
  const run = save.activeRun;
  if (!run || !isTerminal(run)) return null;
  const result = settleResearch(save.meta, run.economy, run.runId, run.missionId, run.phase as ResearchSettlement['outcome']);
  if (result) save.recentSettlement = result;
  return result;
}
export function continueAfterSettlement(save: GameSaveV4): void {
  if (save.activeRun && isTerminal(save.activeRun) && save.meta.settledRunIds.includes(save.activeRun.runId)) save.activeRun = null;
}
/** One queue per profile, backed by the existing Rust atomic main/temp/backup writer. */
export class AtomicCampaignStore {
  private current: GameSaveV4;
  private tail: Promise<void> = Promise.resolve();
  constructor(initial: GameSaveV4, private readonly writeAtomic: (json: string) => Promise<void>) {
    this.current = validateGameSaveV4(initial);
    if (this.current.activeRun) cancelSwatter(this.current.activeRun.swatter);
  }
  snapshot(): GameSaveV4 { return structuredClone(this.current); }
  update(mutate: (draft: GameSaveV4) => void): Promise<GameSaveV4> {
    const operation = this.tail.then(async () => {
      const draft = this.snapshot(); const result: unknown = mutate(draft);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
        // Observe a rejected native Promise without running arbitrary user-defined thenables.
        if (result instanceof Promise) void result.catch(() => {});
        throw new Error('Campaign mutations must be synchronous');
      }
      settleCampaignInSave(draft);
      const validated = validateGameSaveV4(draft, this.current.profile);
      await this.writeAtomic(JSON.stringify(validated));
      this.current = validated;
      return this.snapshot();
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
