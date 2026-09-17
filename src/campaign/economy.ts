/** JSON-only, deterministic ledger. The caller confirms kills and final disposal. */
export type RewardEnemy = "normal" | "elite" | "nest";
export interface EconomyEvent {
  id: string;
  kind: "kill" | "clean" | "milestone";
  targetId: string;
  parts: number;
  weight: number;
  enemy: RewardEnemy | null;
  stage: number;
}
export interface EconomyState {
  parts: number;
  events: EconomyEvent[];
  /** JSON tuple keys: ["spend" | "refund", purchaseId] or
   * ["unused-refund", purchaseId, refundCommandId]. Never delete receipts. */
  purchases: Record<string, number>;
  /** Folded rewards from retired ecology objects. Optional only for cycle-v1 compatibility. */
  archived?: EconomyArchive;
}
export interface EconomyArchive { earnedParts: number; cleanWeight: number; normalKills: number; eliteKills: number; nestKills: number }

const KILL_PARTS: Record<RewardEnemy, number> = { normal: 1, elite: 8, nest: 30 };
export const DEVICE_PRICES = Object.freeze({ bait: 8, glue: 10, catcher: 20, gridDoor: 30, ladder: 12, bouncePad: 16, repairPack: 25 });
const validId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const amount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const weightValue = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const key = (kind: "spend" | "refund", id: string): string => JSON.stringify([kind, id]);
const unusedKey = (purchaseId: string, refundId: string): string => JSON.stringify(["unused-refund", purchaseId, refundId]);
const has = (value: object, name: string): boolean => Object.prototype.hasOwnProperty.call(value, name);
const EMPTY_ARCHIVE: Readonly<EconomyArchive> = Object.freeze({ earnedParts: 0, cleanWeight: 0, normalKills: 0, eliteKills: 0, nestKills: 0 });

function validArchive(value: unknown): value is EconomyArchive {
  if (!record(value) || Object.keys(value).sort().join() !== "cleanWeight,earnedParts,eliteKills,nestKills,normalKills") return false;
  if (!amount(value.earnedParts) || !weightValue(value.cleanWeight) || !amount(value.normalKills)
    || !amount(value.eliteKills) || !amount(value.nestKills)) return false;
  const killParts = value.normalKills + value.eliteKills * KILL_PARTS.elite + value.nestKills * KILL_PARTS.nest;
  return amount(killParts) && value.earnedParts >= killParts;
}

function archiveScore(archive: EconomyArchive | undefined): number {
  if (!archive) return 0;
  return archive.cleanWeight * 2 + archive.normalKills + archive.eliteKills * 8;
}

export function createEconomy(): EconomyState { return { parts: 20, events: [], purchases: {} }; }

export function isEconomyState(value: unknown): value is EconomyState {
  if (!record(value) || !amount(value.parts) || !Array.isArray(value.events) || !record(value.purchases)) return false;
  const archived = has(value, "archived") ? value.archived : undefined;
  if (archived !== undefined && !validArchive(archived)) return false;
  const ids = new Set<string>();
  let score = archiveScore(archived);
  for (const event of value.events) {
    if (!record(event) || !validId(event.id) || !validId(event.targetId) || ids.has(event.id) || !amount(event.parts) || !weightValue(event.weight) || !amount(event.stage)) return false;
    ids.add(event.id);
    if (event.kind === "kill") {
      if (!(event.enemy === "normal" || event.enemy === "elite" || event.enemy === "nest") || event.id !== `kill:${event.targetId}` || event.parts !== KILL_PARTS[event.enemy] || event.weight !== 0 || event.stage !== 0) return false;
      score += event.enemy === "normal" ? 1 : event.enemy === "elite" ? 8 : 0;
    } else if (event.kind === "clean") {
      if (event.id !== `clean:${event.targetId}` || event.enemy !== null || event.stage !== 0) return false;
      score += event.weight * 2;
    } else if (event.kind === "milestone") {
      if (event.stage < 2 || event.stage > 4 || event.id !== `milestone:${event.stage}` || event.targetId !== `stage:${event.stage}` || event.parts !== 0 || event.weight !== 0 || event.enemy !== null) return false;
    } else return false;
  }
  if (!weightValue(score)) return false;
  const unusedPurchases = new Set<string>();
  const refundCommands = new Set<string>();
  for (const [receipt, cost] of Object.entries(value.purchases)) {
    if (!amount(cost)) return false;
    let tuple: unknown;
    try { tuple = JSON.parse(receipt); } catch { return false; }
    if (!Array.isArray(tuple) || !validId(tuple[1])) return false;
    if (tuple[0] === "unused-refund") {
      if (tuple.length !== 3 || !validId(tuple[2]) || unusedKey(tuple[1], tuple[2]) !== receipt || unusedPurchases.has(tuple[1]) || refundCommands.has(tuple[2])) return false;
      const paid = value.purchases[key("spend", tuple[1])];
      if (!has(value.purchases, key("spend", tuple[1])) || !amount(paid) || cost > Math.floor(paid * 0.5) || has(value.purchases, key("refund", tuple[1]))) return false;
      unusedPurchases.add(tuple[1]);
      refundCommands.add(tuple[2]);
      continue;
    }
    if (tuple.length !== 2 || (tuple[0] !== "spend" && tuple[0] !== "refund") || key(tuple[0], tuple[1]) !== receipt) return false;
    if (tuple[0] === "refund" && (!has(value.purchases, key("spend", tuple[1])) || value.purchases[key("spend", tuple[1])] !== cost)) return false;
  }
  return true;
}

/** Strong save-boundary check; seeded simulation wallets can use structural validation.
 * Every aggregate and arithmetic step must remain an exact safe integer.
 */
export function isEconomyConserved(state: EconomyState): boolean {
  if (!isEconomyState(state)) return false;
  let earned = 20 + (state.archived?.earnedParts ?? 0);
  if (!Number.isSafeInteger(earned)) return false;
  let spent = 0;
  let refunded = 0;
  for (const event of state.events) {
    earned += event.parts;
    if (!Number.isSafeInteger(earned)) return false;
  }
  for (const [receipt, cost] of Object.entries(state.purchases)) {
    const tuple = JSON.parse(receipt);
    if (tuple[0] === "spend") spent += cost;
    else refunded += cost;
    if (!Number.isSafeInteger(spent) || !Number.isSafeInteger(refunded)) return false;
  }
  const afterSpending = earned - spent;
  const expected = afterSpending + refunded;
  return Number.isSafeInteger(afterSpending) && amount(expected) && state.parts === expected;
}

function append(state: EconomyState, event: EconomyEvent): boolean {
  if (!isEconomyState(state) || state.events.some((item) => item.id === event.id)) return false;
  const candidate = { ...state, parts: state.parts + event.parts, events: [...state.events, event] };
  if (!isEconomyState(candidate)) return false;
  state.parts = candidate.parts;
  state.events.push(event);
  return true;
}

export function recordKill(state: EconomyState, targetId: string, enemy: RewardEnemy): boolean {
  if (!validId(targetId) || !has(KILL_PARTS, enemy)) return false;
  return append(state, { id: `kill:${targetId}`, kind: "kill", targetId, parts: KILL_PARTS[enemy], weight: 0, enemy, stage: 0 });
}

export function recordClean(state: EconomyState, targetId: string, weight: number, parts: number): boolean {
  if (!validId(targetId) || !weightValue(weight) || !amount(parts)) return false;
  return append(state, { id: `clean:${targetId}`, kind: "clean", targetId, parts, weight, enemy: null, stage: 0 });
}

export function recordMilestone(state: EconomyState, stage: number): boolean {
  if (!Number.isInteger(stage) || stage < 2 || stage > 4) return false;
  return append(state, { id: `milestone:${stage}`, kind: "milestone", targetId: `stage:${stage}`, parts: 0, weight: 0, enemy: null, stage });
}

/** Fold kill/clean rows for retired targets without changing the wallet balance. */
export function archiveEconomyEvents(state: EconomyState, targetIds: ReadonlySet<string>): boolean {
  if (!isEconomyState(state) || [...targetIds].some(id => !validId(id))) return false;
  const folded = state.events.filter(event => event.kind !== "milestone" && targetIds.has(event.targetId));
  if (!folded.length) return true;
  const archive: EconomyArchive = { ...(state.archived ?? EMPTY_ARCHIVE) };
  for (const event of folded) {
    archive.earnedParts += event.parts;
    if (event.kind === "clean") archive.cleanWeight += event.weight;
    else if (event.enemy === "normal") archive.normalKills++;
    else if (event.enemy === "elite") archive.eliteKills++;
    else archive.nestKills++;
    if (!validArchive(archive) || !weightValue(archiveScore(archive))) return false;
  }
  const events = state.events.filter(event => event.kind === "milestone" || !targetIds.has(event.targetId));
  const candidate: EconomyState = { ...state, events, archived: archive };
  if (!isEconomyState(candidate)) return false;
  state.events = events;
  state.archived = archive;
  return true;
}

export function spendParts(state: EconomyState, commandId: string, cost: number): boolean {
  if (!isEconomyState(state) || !validId(commandId) || !amount(cost) || has(state.purchases, key("spend", commandId)) || state.parts < cost) return false;
  state.parts -= cost;
  state.purchases[key("spend", commandId)] = cost;
  return true;
}

/** Refund an existing payment, once. A changed amount or replay never creates money. */
export function refundParts(state: EconomyState, commandId: string, cost?: number): boolean {
  if (!isEconomyState(state) || !validId(commandId) || !has(state.purchases, key("spend", commandId)) || has(state.purchases, key("refund", commandId))) return false;
  if (Object.keys(state.purchases).some((receipt) => { const tuple = JSON.parse(receipt); return tuple[0] === "unused-refund" && tuple[1] === commandId; })) return false;
  const paid = state.purchases[key("spend", commandId)];
  if ((cost !== undefined && cost !== paid) || !amount(state.parts + paid)) return false;
  state.parts += paid;
  state.purchases[key("refund", commandId)] = paid;
  return true;
}

/** Retire a device purchase once for half its unused paid value, rounded down.
 * Even a zero refund consumes the receipt. The caller supplies actual unused life
 * and removes the device only when this atomic ledger operation succeeds.
 */
export function refundUnusedParts(state: EconomyState, purchaseCommandId: string, refundCommandId: string, unusedFraction: number): boolean {
  if (!isEconomyState(state) || !validId(purchaseCommandId) || !validId(refundCommandId) || !Number.isFinite(unusedFraction) || unusedFraction < 0 || unusedFraction > 1 || !has(state.purchases, key("spend", purchaseCommandId)) || has(state.purchases, key("refund", purchaseCommandId))) return false;
  if (Object.keys(state.purchases).some((receipt) => {
    const tuple = JSON.parse(receipt);
    return tuple[0] === "unused-refund" && (tuple[1] === purchaseCommandId || tuple[2] === refundCommandId);
  })) return false;
  const refund = Math.floor(state.purchases[key("spend", purchaseCommandId)] * unusedFraction * 0.5);
  if (!amount(state.parts + refund)) return false;
  state.parts += refund;
  state.purchases[unusedKey(purchaseCommandId, refundCommandId)] = refund;
  return true;
}

export function effectiveScore(state: EconomyState): number {
  if (!isEconomyState(state)) throw new RangeError("Invalid economy ledger");
  return state.events.reduce((total, event) => total + (event.kind === "clean" ? event.weight * 2 : event.kind === "kill" ? event.enemy === "normal" ? 1 : event.enemy === "elite" ? 8 : 0 : 0), archiveScore(state.archived));
}

export const RUN_UPGRADES = Object.freeze({
  cleanerClean: { cost: 10 }, cleanerMove: { cost: 12 }, cleanerCapacity: { cost: 12 },
  frogTongue: { cost: 12 }, frogAttack: { cost: 14 }, frogDigestion: { cost: 12 },
  frogBatch: { cost: 14 }, frogCapacity: { cost: 12 }, bagCapacity: { cost: 10 },
  bagEfficiency: { cost: 12 }, swatDamage: { cost: 14 }, swatHeat: { cost: 12 },
  trapMaintenance: { cost: 14 }, homeArmor: { cost: 18 },
});
export type RunUpgradeId = keyof typeof RUN_UPGRADES;
export interface RunUpgradeState { levels: Partial<Record<RunUpgradeId, number>> }
export function createRunUpgrades(): RunUpgradeState { return { levels: {} }; }
export function isRunUpgradeState(value: unknown): value is RunUpgradeState {
  return record(value) && record(value.levels) && Object.entries(value.levels).every(([id, level]) => has(RUN_UPGRADES, id) && amount(level) && level <= 3);
}
export function runUpgradeCost(upgrades: RunUpgradeState, id: RunUpgradeId): number | null {
  if (!isRunUpgradeState(upgrades) || !has(RUN_UPGRADES, id) || id === "trapMaintenance") return null;
  const level = upgrades.levels[id] ?? 0;
  return level < 3 ? RUN_UPGRADES[id].cost * 2 ** level : null;
}
export function buyRunUpgrade(economy: EconomyState, upgrades: RunUpgradeState, commandId: string, id: RunUpgradeId): boolean {
  const cost = runUpgradeCost(upgrades, id);
  if (cost === null || !spendParts(economy, commandId, cost)) return false;
  upgrades.levels[id] = (upgrades.levels[id] ?? 0) + 1;
  return true;
}

export interface RunAttributes {
  cleanSeconds: number; moveSpeed: number; cleanerCapacity: number; tongueReach: number;
  attackCooldown: number; digestionSeconds: number; tongueBatch: number; frogCapacity: number;
  bagCapacity: number; unloadSeconds: number; swatDamage: number; swatHeat: number;
  trapMaintenanceMultiplier: number; homeMaxHp: number;
}
export const BASE_RUN_ATTRIBUTES: Readonly<RunAttributes> = Object.freeze({
  cleanSeconds: 1.2, moveSpeed: 120, cleanerCapacity: 6, tongueReach: 140,
  attackCooldown: 1.2, digestionSeconds: 8, tongueBatch: 1, frogCapacity: 4,
  bagCapacity: 8, unloadSeconds: 1, swatDamage: 20, swatHeat: 100,
  trapMaintenanceMultiplier: 1, homeMaxHp: 1000,
});

/** Recompute from initial stats, never from a previously upgraded display value.
 * Bag speed is a provisional -10% unload time/level; cooldown minima are explicit.
 * Research base capacity bonuses are additive and independent of purchase order.
 */
export function deriveRunAttributes(upgrades: RunUpgradeState, researchNodes: readonly string[] = [], base: Readonly<RunAttributes> = BASE_RUN_ATTRIBUTES): RunAttributes {
  if (!isRunUpgradeState(upgrades) || !Array.isArray(researchNodes) || !researchNodes.every((id) => typeof id === "string") || !Object.keys(BASE_RUN_ATTRIBUTES).every((name) => weightValue(base[name as keyof RunAttributes]))) throw new RangeError("Invalid upgrade attributes");
  const l = (id: RunUpgradeId): number => upgrades.levels[id] ?? 0;
  const result: RunAttributes = {
    cleanSeconds: Math.max(0.35, base.cleanSeconds * (1 - l("cleanerClean") * 0.1)),
    moveSpeed: base.moveSpeed * (1 + l("cleanerMove") * 0.1),
    cleanerCapacity: base.cleanerCapacity + l("cleanerCapacity") * 2,
    tongueReach: base.tongueReach + l("frogTongue") * 15,
    attackCooldown: Math.max(0.1, base.attackCooldown * (1 - l("frogAttack") * 0.08)),
    digestionSeconds: Math.max(0.1, base.digestionSeconds * (1 - l("frogDigestion") * 0.1)),
    tongueBatch: base.tongueBatch + l("frogBatch"),
    frogCapacity: base.frogCapacity + l("frogCapacity") * 2 + (researchNodes.includes("frog-2") ? 2 : 0),
    bagCapacity: base.bagCapacity + l("bagCapacity") * 4 + (researchNodes.includes("bag-1") ? 2 : 0),
    unloadSeconds: Math.max(0.1, base.unloadSeconds * (1 - l("bagEfficiency") * 0.1)),
    swatDamage: base.swatDamage * (1 + l("swatDamage") * 0.2),
    swatHeat: base.swatHeat * (1 + l("swatHeat") * 0.15),
    trapMaintenanceMultiplier: base.trapMaintenanceMultiplier * Math.max(0.6, 1 - l("trapMaintenance") * 0.1),
    homeMaxHp: base.homeMaxHp * (1 + l("homeArmor") * 0.1 + (researchNodes.includes("home-1") ? 0.1 : 0)),
  };
  if (!Object.values(result).every(weightValue)) throw new RangeError("Upgrade attributes overflow");
  return result;
}

/** Add only the new maximum HP delta; destroyed houses remain destroyed. */
export function upgradedHomeHp(currentHp: number, previousMax: number, nextMax: number): number {
  if (!weightValue(currentHp) || !weightValue(previousMax) || !weightValue(nextMax) || currentHp > previousMax || nextMax < previousMax) throw new RangeError("Invalid home upgrade");
  return currentHp === 0 ? 0 : Math.min(nextMax, currentHp + nextMax - previousMax);
}
