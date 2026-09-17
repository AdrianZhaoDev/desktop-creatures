import { captureObject, createEcology, damageObject, ensureMainNest, infectionDensity, isLive, stepEcology, type EcologyState } from './combat-ecology';
import type { EcologyPlacement } from './ecology-cycle-types';
import { buyRunUpgrade, createEconomy, createRunUpgrades, deriveRunAttributes, recordClean, recordKill, recordMilestone, refundUnusedParts, spendParts, upgradedHomeHp, type EconomyState, type RunUpgradeId, type RunUpgradeState } from './economy';
import { canonicalById, canonicalObjects, createSwatter, createInventory, emptyBag, hasKey, inventoryItems, inventoryLoad, releaseResidueBatch, transact, transferObjects, cancelSwatter, stepSwatter, type InventoryState, type Point, type Receipt, type SwatterState } from './tool-system';

export type CampaignPhase = 'preparation' | 'running' | 'retreat' | 'siege' | 'victory' | 'defeat' | 'abandoned';
/** No cached navigation path or surface IDs cross the save boundary. Velocities are normalized/second. */
export interface ActorPose extends Point { vx: number; vy: number; stamina: number; appearanceId: string; activity: string; motion: 'walking' | 'climbing' | 'jumping' | 'falling' | 'landing'; taskId: string | null }
export interface ActorSnapshot { id: string; archetype: 'cleaner' | 'frog'; inventoryId: string; houseId: string; atHome: boolean; pose: ActorPose }
export interface HouseState extends Point { id: string; hp: number; maxHp: number; repaired: boolean; locked: boolean }
export type ActorEffect = { type: 'retreat' | 'safe-home' | 'disabled'; actorId: string; houseId: string };
/** S07 adapter owns navigation and motion. Effects are delivered after the domain step commits. */
export interface ActorPort { snapshot(): ActorSnapshot[]; apply(effect: ActorEffect): void }
export interface HousePort { present(houses: readonly HouseState[]): void }
export type TrapKind = 'bait' | 'glue' | 'catcher' | 'ladder';
export interface TrapState extends Point { id: string; kind: TrapKind; remaining: number; uses: number; paid: number; purchaseCommandId: string; inventoryId: string | null }
export interface RunState {
  runId: string; missionId: string; phase: CampaignPhase; pauseReasons: string[];
  tick: number; ecology: EcologyState; inventory: InventoryState; economy: EconomyState;
  upgrades: RunUpgradeState;
  researchNodes: string[];
  actors: ActorSnapshot[]; houses: HouseState[]; traps: TrapState[]; trapSlots: number;
  retreatSeconds: number; pressureSeconds: number; victorySeconds: number; swatter: SwatterState;
  frogUnlocked: boolean;
}
export const FIXED_STEP = 1 / 60;
export const isTerminal = (run: RunState): boolean => ['victory', 'defeat', 'abandoned'].includes(run.phase);
export const isPaused = (run: RunState): boolean => run.pauseReasons.length > 0;
export function createRun(runId: string, missionId = 'demo-1', seed = 1, frogUnlocked = true, researchNodes: string[] = []): RunState {
  if (!runId || !missionId || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Invalid run identity');
  const inventory = createInventory();
  for (const id of ['home.cleaner', 'home.frog']) inventory.containers[id] = { id, kind: 'house', capacity: Number.MAX_SAFE_INTEGER, sealed: true };
  const run: RunState = { runId, missionId, phase: 'preparation', pauseReasons: [], tick: 0, ecology: createEcology(seed), inventory, economy: createEconomy(), upgrades: createRunUpgrades(), researchNodes: [...researchNodes],
    actors: [ { id: 'actor.cleaner', archetype: 'cleaner', inventoryId: 'cleanerPack', houseId: 'home.cleaner', atHome: false, pose: { x: 0.35, y: 1, vx: 0, vy: 0, stamina: 100, appearanceId: 'female', activity: 'idle', motion: 'walking', taskId: null } }, { id: 'actor.frog', archetype: 'frog', inventoryId: 'frogPouch', houseId: 'home.frog', atHome: false, pose: { x: 0.65, y: 1, vx: 0, vy: 0, stamina: 100, appearanceId: 'frog', activity: 'idle', motion: 'walking', taskId: null } } ],
    houses: [ { id: 'home.cleaner', x: 0.35, y: 1, hp: 1000, maxHp: 1000, repaired: false, locked: false }, { id: 'home.frog', x: 0.65, y: 1, hp: 1000, maxHp: 1000, repaired: false, locked: false } ],
    traps: [], trapSlots: 3 + (researchNodes.includes('trap-2') ? 1 : 0) + (researchNodes.includes('trap-4') ? 1 : 0), retreatSeconds: 0, pressureSeconds: 0, victorySeconds: 0, swatter: createSwatter(), frogUnlocked };
  const attributes = deriveRunAttributes(run.upgrades, run.researchNodes);
  inventory.containers.playerBag.capacity = attributes.bagCapacity;
  inventory.containers.cleanerPack.capacity = attributes.cleanerCapacity;
  inventory.containers.frogPouch.capacity = attributes.frogCapacity;
  for (const house of canonicalById(run.houses)) { house.hp = attributes.homeMaxHp; house.maxHp = attributes.homeMaxHp; }
  return run;
}
export function startRun(run: RunState): void { if (run.phase === 'preparation') run.phase = 'running'; }
export function setCampaignPaused(run: RunState, reason: string, paused: boolean): void {
  if (!reason) return;
  if (paused && !run.pauseReasons.includes(reason)) { run.pauseReasons.push(reason); cancelSwatter(run.swatter); }
  else if (!paused) run.pauseReasons = run.pauseReasons.filter(value => value !== reason);
}
function commandAllowed(run: RunState): boolean { return !isTerminal(run) && run.phase !== 'preparation' && !isPaused(run); }
function blocked(): Receipt { return { signature: '', ok: false, reason: 'campaign-frozen' }; }
const killPort = (run: RunState) => ({ kill: (id: string, kind: 'normal' | 'elite' | 'nest') => { recordKill(run.economy, id, kind); } });
export function collectItem(run: RunState, commandId: string, id: string, from = 'world'): Receipt {
  if (!commandAllowed(run)) return blocked();
  return transferObjects(run.inventory, commandId, [id], from, 'playerBag');
}
export function disposeBag(run: RunState, commandId: string, binAvailable: boolean, bag = 'playerBag'): Receipt {
  if (!commandAllowed(run)) return blocked();
  return emptyBag(run.inventory, commandId, binAvailable, { clean: (id, weight, value) => {
    const before = run.economy.events.length;
    recordClean(run.economy, id, weight, value);
    if (run.economy.events.length > before) run.ecology.pollution = Math.max(0, run.ecology.pollution - weight * 2);
  } }, bag);
}
export function hitObject(run: RunState, commandId: string, id: string, damage = 20): Receipt {
  if (!commandAllowed(run)) return blocked();
  return damageObject(run.inventory, run.ecology, commandId, id, damage, killPort(run));
}
export function actorCapture(run: RunState, commandId: string, id: string): Receipt {
  if (!commandAllowed(run) || run.phase !== 'running' || !run.frogUnlocked) return blocked();
  return captureObject(run.inventory, commandId, id, 'frogPouch', killPort(run));
}
export function reportActorHome(run: RunState, commandId: string, actorId: string): Receipt {
  if (isTerminal(run) || isPaused(run) || run.phase !== 'retreat') return blocked();
  return transact(run.inventory, commandId, JSON.stringify(['home', actorId]), () => {
    const actor = run.actors.find(value => value.id === actorId);
    if (!actor) return 'missing-actor';
    const items = inventoryItems(run.inventory, actor.inventoryId);
    if (items.length && !transferObjects(run.inventory, `${commandId}:inventory`, items.map(item => item.id), actor.inventoryId, actor.houseId).ok) return 'inventory-transfer';
    actor.atHome = true;
    const house = run.houses.find(value => value.id === actor.houseId)!;
    Object.assign(actor.pose, { x: house.x, y: house.y, vx: 0, vy: 0, activity: 'resting', taskId: null });
    return null;
  });
}
const PRICES: Record<TrapKind, number> = { bait: 8, glue: 10, catcher: 20, ladder: 12 };
/** Shop can remain paused while confirming a purchase; no gameplay timers run. */
export function placeTrap(run: RunState, commandId: string, id: string, kind: TrapKind, position: Point, validGround: boolean): Receipt {
  if (isTerminal(run) || run.phase === 'preparation') return blocked();
  return transact(run.inventory, commandId, JSON.stringify(['place', id, kind, position, validGround]), () => {
    if (!hasKey(PRICES, kind) || !id || run.traps.some(trap => trap.id === id) || hasKey(run.inventory.containers, id) || hasKey(run.inventory.objects, id)) return 'invalid-trap';
    if (!validGround || !Number.isFinite(position.x) || position.x < 0 || position.x > 1 || position.y !== 1) return 'invalid-ground';
    if (kind === 'ladder' ? run.traps.some(trap => trap.kind === 'ladder') : run.traps.filter(trap => trap.kind !== 'ladder').length >= run.trapSlots) return 'slots';
    if (!spendParts(run.economy, `trap:${commandId}`, PRICES[kind])) return 'parts';
    // Empty non-catcher containers also reserve IDs after replacement, preventing identity reuse.
    Object.defineProperty(run.inventory.containers, id, { value: { id, kind: 'trap', capacity: kind === 'catcher' ? 6 : 0, sealed: true }, enumerable: true, writable: true, configurable: true });
    run.traps.push({ id, kind, ...position, remaining: kind === 'bait' ? 60 : 0, uses: kind === 'glue' ? 12 : 0, paid: PRICES[kind], purchaseCommandId: `trap:${commandId}`, inventoryId: kind === 'catcher' ? id : null });
    return null;
  });
}
export function removeTrap(run: RunState, commandId: string, id: string): Receipt {
  if (isTerminal(run) || run.phase === 'preparation') return blocked();
  return transact(run.inventory, commandId, JSON.stringify(['remove-trap', id]), () => {
    const trap = run.traps.find(value => value.id === id);
    if (!trap) return 'missing-trap';
    if (inventoryItems(run.inventory, id).length) return 'maintenance-required';
    const fraction = trap.kind === 'bait' ? trap.remaining / 60 : trap.kind === 'glue' ? trap.uses / 12 : trap.kind === 'catcher' ? Math.max(0, 1 - trap.uses / 6) : 1;
    if (!refundUnusedParts(run.economy, trap.purchaseCommandId, `refund:${commandId}`, fraction)) return 'refund-unavailable';
    run.traps = run.traps.filter(value => value.id !== id);
    return null;
  });
}
/** Navigation adapter maps this normalized guaranteed ground ladder to its current DIP space. */
export function ladderSurfaces(run: RunState): Array<{ id: string; bottom: Point; top: Point }> {
  return canonicalById(run.traps).filter(trap => trap.kind === 'ladder').map(trap => ({ id: trap.id, bottom: { x: trap.x, y: 1 }, top: { x: trap.x, y: 0.7 } }));
}
export function maintainCatcher(run: RunState, commandId: string, id: string): Receipt {
  if (hasKey(run.inventory.commands, commandId)) {
    const receipt = run.inventory.commands[commandId];
    let signature: unknown;
    try { signature = JSON.parse(receipt.signature); } catch { signature = null; }
    const exactMissingTrap = Array.isArray(signature) && signature.length === 2
      && signature[0] === 'maintain-catcher' && signature[1] === id;
    const exactTrapBatch = Array.isArray(signature) && signature.length === 4
      && signature[0] === 'residue-batch' && signature[1] === id
      && run.inventory.containers[id]?.kind === 'trap';
    if (exactMissingTrap || exactTrapBatch) return { ...receipt };
    return { signature: JSON.stringify(['maintain-catcher', id]), ok: false, reason: 'command-conflict' };
  }
  if (!commandAllowed(run)) return blocked();
  const trap = run.traps.find(value => value.id === id && value.kind === 'catcher');
  if (!trap?.inventoryId) return transact(run.inventory, commandId, JSON.stringify(['maintain-catcher', id]), () => 'missing-trap');
  return releaseResidueBatch(run.inventory, commandId, trap.inventoryId, trap);
}
/** Per-member timers avoid giving late captures a partially completed digestion cycle.
 * Age is integer fixed ticks / 60, independent of wall time or ecology's exposed-object age.
 * Retreat/atHome freezes pouch logistics so its remaining cargo can be sheltered intact.
 */
function stepFrogDigestion(run: RunState): void {
  if (run.phase !== 'running' || !run.frogUnlocked) return;
  const frog = run.actors.find(actor => actor.archetype === 'frog');
  if (!frog || frog.atHome) return;
  const periodTicks = Math.ceil(deriveRunAttributes(run.upgrades, run.researchNodes).digestionSeconds * 60 - 1e-9);
  const mature: string[] = [];
  for (const item of inventoryItems(run.inventory, frog.inventoryId)) {
    if (item.kind !== 'corpse') continue;
    const elapsedTicks = Math.min(periodTicks, Math.round(item.age * 60) + 1);
    item.age = elapsedTicks / 60;
    if (elapsedTicks === periodTicks) mature.push(item.id);
  }
  if (mature.length) releaseResidueBatch(run.inventory, `digest:${run.tick}`, frog.inventoryId, frog.pose, mature);
}
export function repairHouse(run: RunState, commandId: string, id: string): Receipt {
  if (isTerminal(run) || run.phase !== 'siege') return blocked();
  return transact(run.inventory, commandId, JSON.stringify(['repair', id]), () => {
    const house = run.houses.find(value => value.id === id);
    if (!house || house.hp <= 0 || house.repaired || house.hp >= house.maxHp) return 'not-repairable';
    if (!spendParts(run.economy, `repair:${commandId}`, 25)) return 'parts';
    house.hp = Math.min(house.maxHp, house.hp + house.maxHp * 0.25 * (run.researchNodes.includes('home-2') ? 1.1 : 1)); house.repaired = true;
    return null;
  });
}
/** Caller uses the returned derived attributes to configure the S07 movement/work adapter. */
export function purchaseRunUpgrade(run: RunState, commandId: string, id: RunUpgradeId): Receipt {
  if (isTerminal(run) || run.phase === 'preparation') return blocked();
  return transact(run.inventory, commandId, JSON.stringify(['upgrade', id]), () => {
    if (!buyRunUpgrade(run.economy, run.upgrades, `upgrade:${commandId}`, id)) return 'upgrade-unavailable';
    const attributes = deriveRunAttributes(run.upgrades, run.researchNodes);
    run.inventory.containers.playerBag.capacity = attributes.bagCapacity;
    run.inventory.containers.cleanerPack.capacity = attributes.cleanerCapacity;
    run.inventory.containers.frogPouch.capacity = attributes.frogCapacity;
    for (const house of canonicalById(run.houses)) {
      house.hp = upgradedHomeHp(house.hp, house.maxHp, attributes.homeMaxHp); house.maxHp = attributes.homeMaxHp;
    }
    return null;
  });
}
function stepTraps(run: RunState, frozenObjectIds: readonly string[] = []): void {
  const frozen = new Set(frozenObjectIds);
  for (const trap of canonicalById(run.traps)) {
    trap.remaining = Math.max(0, trap.remaining - FIXED_STEP);
    for (const item of canonicalObjects(run.inventory)) {
      if (frozen.has(item.id) || !isLive(item) || item.kind === 'nest' || item.owner !== 'world' || Math.hypot(item.x - trap.x, item.y - trap.y) > 0.15) continue;
      if (trap.kind === 'catcher' && item.kind === 'bug' && inventoryLoad(run.inventory, trap.id) + 1 <= run.inventory.containers[trap.id].capacity) {
        if (captureObject(run.inventory, `trap:${trap.id}:${run.tick}:${item.id}`, item.id, trap.id, killPort(run)).ok) trap.uses++;
      }
      if (trap.kind === 'glue' && trap.uses > 0 && item.controlRemaining === 0) { item.controlRemaining = item.kind === 'elite' ? 1 : 2; trap.uses--; }
      if (trap.kind === 'bait' && trap.remaining > 0 && item.controlRemaining === 0) {
        item.x += (trap.x - item.x) * FIXED_STEP; item.y += (trap.y - item.y) * FIXED_STEP;
      }
    }
  }
}
export interface SiegeDamage { houseId: string; front: number; pressure: number; attackerIds: string[] }
/** Each live bug belongs to exactly one channel and one house in a tick. */
export function stepSiege(run: RunState): SiegeDamage[] {
  if (run.phase !== 'siege' || isPaused(run)) return [];
  const living = canonicalById(run.houses).filter(house => house.hp > 0);
  const results = living.map(house => ({ houseId: house.id, front: 0, pressure: 0, attackerIds: [] as string[] }));
  const seats = living.map(() => 0);
  if (!living.length) return results;
  for (const item of canonicalObjects(run.inventory)) {
    if (!isLive(item) || item.kind === 'nest' || item.owner !== 'world') continue;
    const index = living.reduce((best, house, i) => Math.abs(house.x - item.x) < Math.abs(living[best].x - item.x) ? i : best, 0);
    const result = results[index], house = living[index];
    item.attackRemaining = Math.max(0, item.attackRemaining - FIXED_STEP);
    if (item.controlRemaining > 0) continue;
    if (Math.hypot(house.x - item.x, house.y - item.y) <= 0.15 && seats[index] < 3) {
      seats[index]++;
      if (item.attackRemaining <= 1e-9) { result.front += item.kind === 'elite' ? 16 : 8; item.attackRemaining = 1; result.attackerIds.push(item.id); }
    } else if (Math.hypot(house.x - item.x, house.y - item.y) <= 0.3) {
      result.pressure += FIXED_STEP * (item.kind === 'elite' ? 2 : 0.5); result.attackerIds.push(item.id);
    } else {
      const distance = Math.hypot(house.x - item.x, house.y - item.y);
      item.x += (house.x - item.x) / distance * FIXED_STEP * 0.06;
      item.y += (house.y - item.y) / distance * FIXED_STEP * 0.06;
    }
  }
  for (const result of results) { const house = living.find(value => value.id === result.houseId)!; house.hp = Math.max(0, house.hp - result.front - result.pressure); }
  return results;
}
export function stepCampaign(run: RunState, viewport?: { widthDip: number; heightDip: number }, placement?: EcologyPlacement): ActorEffect[] {
  const effects: ActorEffect[] = [];
  if (isPaused(run) || isTerminal(run) || run.phase === 'preparation') return effects;
  if (!Number.isSafeInteger(run.tick) || run.tick < 0 || run.tick >= Number.MAX_SAFE_INTEGER - 1) throw new RangeError('Campaign tick space exhausted');
  run.tick++;
  if (viewport) stepCampaignSwatter(run, viewport.widthDip, viewport.heightDip);
  else stepSwatter(run.swatter, FIXED_STEP, false, [], () => {});
  if (run.tick % 6 === 0) { stepEcology(run.inventory, run.ecology, 0.1, false, placement); recordMilestone(run.economy, run.ecology.stage); }
  stepTraps(run, placement?.frozenObjectIds);
  stepFrogDigestion(run);
  // Continuous desktop ecology has no timer-triggered siege or nest victory.
  // Explicit user abandonment remains available through the existing command.
  if (run.ecology.cycleVersion === 2) {
    run.pressureSeconds = 0; run.retreatSeconds = 0; run.victorySeconds = 0;
    run.ecology.density = infectionDensity(run.inventory);
    run.ecology.peakDensity = Math.max(run.ecology.peakDensity, run.ecology.density);
    return effects;
  }
  if (run.phase === 'retreat') {
    run.retreatSeconds += FIXED_STEP;
    if (run.retreatSeconds + 1e-9 >= 20) for (const actor of canonicalById(run.actors).filter(value => !value.atHome)) {
      if (reportActorHome(run, `safe-home:${run.runId}:${actor.id}`, actor.id).ok) effects.push({ type: 'safe-home', actorId: actor.id, houseId: actor.houseId });
    }
    if (run.actors.every(actor => actor.atHome)) { run.phase = 'siege'; ensureMainNest(run.inventory, run.ecology); run.victorySeconds = 0; }
  }
  const aliveBefore = canonicalById(run.houses).filter(house => house.hp > 0).map(house => house.id);
  stepSiege(run);
  for (const house of canonicalById(run.houses).filter(value => value.hp === 0 && aliveBefore.includes(value.id))) {
    for (const actor of canonicalById(run.actors).filter(value => value.houseId === house.id)) effects.push({ type: 'disabled', actorId: actor.id, houseId: house.id });
  }
  run.ecology.density = infectionDensity(run.inventory);
  run.ecology.peakDensity = Math.max(run.ecology.peakDensity, run.ecology.density);
  if (run.phase === 'siege' && run.houses.every(house => house.hp <= 0)) { run.phase = 'defeat'; cancelSwatter(run.swatter); return effects; }
  if (run.phase === 'running') {
    run.pressureSeconds = run.ecology.density >= 65 && run.ecology.pollution >= 85 && run.frogUnlocked ? run.pressureSeconds + FIXED_STEP : 0;
    if (run.pressureSeconds + 1e-9 >= 10) {
      run.phase = 'retreat'; run.victorySeconds = 0;
      for (const house of canonicalById(run.houses)) house.locked = true;
      for (const actor of canonicalById(run.actors)) { actor.pose.taskId = null; actor.pose.activity = 'returning-home'; effects.push({ type: 'retreat', actorId: actor.id, houseId: actor.houseId }); }
    }
  }
  const eligible = (run.phase === 'running' || run.phase === 'siege') && run.ecology.nestDestroyed && run.ecology.pollution <= 40 && (run.phase !== 'siege' || run.ecology.density <= 30);
  run.victorySeconds = eligible ? run.victorySeconds + FIXED_STEP : 0;
  if (run.victorySeconds + 1e-9 >= 10) { run.phase = 'victory'; cancelSwatter(run.swatter); }
  return effects;
}
/** Input adapter supplies DIP target positions; simulation remains normalized and renderer independent. */
function stepCampaignSwatter(run: RunState, widthDip: number, heightDip: number): void {
  if (!commandAllowed(run) || ![widthDip, heightDip].every(v => Number.isFinite(v) && v > 0)) return;
  const attributes = deriveRunAttributes(run.upgrades, run.researchNodes);
  stepSwatter(run.swatter, FIXED_STEP, false, canonicalObjects(run.inventory).filter(item => item.owner === 'world' && isLive(item)).map(item => ({ id: item.id, x: item.x * widthDip, y: item.y * heightDip, radius: 0 })), (id, commandId) => { hitObject(run, commandId, id, attributes.swatDamage); }, run.researchNodes.includes('swat-2') ? 28 : 24, attributes.swatHeat);
}
export function abandonRun(run: RunState): void { if (!isTerminal(run)) { run.phase = 'abandoned'; cancelSwatter(run.swatter); } }

export interface ClockAdvance { remainder: number; droppedSeconds: number; steps: number; effects: ActorEffect[] }
/** Wall-clock adapter bounds catch-up to six steps; pause/hidden never accumulate deferred pressure. */
export function advanceCampaign(run: RunState, elapsedSeconds: number, remainder = 0, viewport?: { widthDip: number; heightDip: number }, placement?: EcologyPlacement): ClockAdvance {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || !Number.isFinite(remainder) || remainder < 0 || remainder >= FIXED_STEP) throw new Error('Invalid campaign clock');
  if (isPaused(run) || isTerminal(run) || run.phase === 'preparation') return { remainder: 0, droppedSeconds: 0, steps: 0, effects: [] };
  const accumulated = elapsedSeconds + remainder;
  const steps = Math.min(6, Math.floor((accumulated + 1e-12) / FIXED_STEP));
  const effects: ActorEffect[] = [];
  for (let i = 0; i < steps; i++) effects.push(...stepCampaign(run, viewport, placement));
  const leftover = Math.max(0, accumulated - steps * FIXED_STEP);
  const kept = leftover % FIXED_STEP;
  return { remainder: kept, droppedSeconds: leftover - kept, steps, effects };
}
