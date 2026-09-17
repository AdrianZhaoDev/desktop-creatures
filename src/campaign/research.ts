import { effectiveScore, isEconomyState, type EconomyState } from "./economy";

export interface MetaProgress {
  researchPoints: number;
  nodes: string[];
  completedMissions: string[];
  firstAttemptGranted: boolean;
  settledRunIds: string[];
  frogUnlocked: boolean;
  appearanceId: string;
}
export type RunOutcome = "victory" | "defeat" | "abandoned";
export interface ResearchRewardBreakdown { base: number; milestones: number; firstVictory: number; firstAttempt: number }
export interface ResearchSettlement {
  runId: string; missionId: string; outcome: RunOutcome; researchReward: number; score: number;
  /** Optional for source compatibility only; every newly computed result includes it.
   * Strong saved-result validation requires this field. */
  breakdown?: ResearchRewardBreakdown;
}
export type ResearchBranch = "cleaner" | "frog" | "bag" | "swat" | "trap" | "home";
export interface ResearchNode { id: string; branch: ResearchBranch; tier: number; cost: number; prerequisite: string | null; demo: boolean; effect: string }

const BRANCHES: Record<ResearchBranch, readonly string[]> = {
  cleaner: ["grip-stamina-15pct", "half-carry-penalty", "platform-vault", "cleanse-area"],
  frog: ["jump-control-10pct", "base-pouch-plus-2", "chain-capture", "landing-control"],
  bag: ["capacity-plus-2", "area-pickup", "corpse-weight-minus-25pct", "chain-pickup-area"],
  swat: ["faster-cooling", "radius-plus-4dip", "armor-break", "limited-chain-lightning"],
  trap: ["enhanced-catcher", "slot-plus-1", "grid-door", "slot-plus-1-synergy"],
  home: ["hp-plus-10pct", "repair-plus-10pct", "retreat-no-carry-penalty", "siege-shield"],
};
export const RESEARCH_NODES: readonly Readonly<ResearchNode>[] = Object.freeze((Object.entries(BRANCHES) as [ResearchBranch, readonly string[]][]).flatMap(([branch, effects]) => effects.map((effect, index) => Object.freeze({
  id: `${branch}-${index + 1}`, branch, tier: index + 1, cost: [3, 8, 16, 28][index], prerequisite: index === 0 ? null : `${branch}-${index}`, demo: index < 2, effect,
}))));
const NODE_BY_ID = new Map(RESEARCH_NODES.map((node) => [node.id, node]));
const validId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const amount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function uniqueIds(value: unknown): value is string[] { return Array.isArray(value) && value.every(validId) && new Set(value).size === value.length; }

export function createMetaProgress(): MetaProgress {
  return { researchPoints: 0, nodes: [], completedMissions: [], firstAttemptGranted: false, settledRunIds: [], frogUnlocked: false, appearanceId: "female" };
}

export function isMetaProgress(value: unknown): value is MetaProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  if (!amount(meta.researchPoints) || !uniqueIds(meta.nodes) || !uniqueIds(meta.completedMissions) || !uniqueIds(meta.settledRunIds) || typeof meta.firstAttemptGranted !== "boolean" || typeof meta.frogUnlocked !== "boolean" || !validId(meta.appearanceId)) return false;
  const ids = meta.nodes;
  return ids.every((id) => { const node = NODE_BY_ID.get(id); return !!node && (node.prerequisite === null || ids.includes(node.prerequisite)); });
}

/** Preview the exact reward from pre-settlement progress without mutating either input. */
export function computeResearchSettlement(meta: MetaProgress, economy: EconomyState, runId: string, missionId: string, outcome: RunOutcome): ResearchSettlement | null {
  if (!isMetaProgress(meta) || !isEconomyState(economy) || !validId(runId) || !validId(missionId) || !["victory", "defeat", "abandoned"].includes(outcome) || meta.settledRunIds.includes(runId)) return null;
  const score = effectiveScore(economy);
  const firstAttempt = score >= 20 && !meta.firstAttemptGranted;
  const firstVictory = outcome === "victory" && !meta.completedMissions.includes(missionId);
  const milestones = economy.events.filter((event) => event.kind === "milestone").length;
  const breakdown = { base: Math.min(6, Math.floor(score / 40)), milestones, firstVictory: firstVictory ? 8 : 0, firstAttempt: firstAttempt ? 3 : 0 };
  const researchReward = breakdown.base + breakdown.milestones + breakdown.firstVictory + breakdown.firstAttempt;
  if (!amount(meta.researchPoints + researchReward)) return null;
  return { runId, missionId, outcome, researchReward, score, breakdown };
}

/** Validates a durable result even after its run ledger is no longer retained. */
export function isResearchSettlementShape(value: unknown): value is ResearchSettlement & { breakdown: ResearchRewardBreakdown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (!validId(result.runId) || !validId(result.missionId) || (result.outcome !== "victory" && result.outcome !== "defeat" && result.outcome !== "abandoned") || !amount(result.researchReward) || typeof result.score !== "number" || !Number.isFinite(result.score) || result.score < 0 || result.score > Number.MAX_SAFE_INTEGER || !result.breakdown || typeof result.breakdown !== "object" || Array.isArray(result.breakdown)) return false;
  const breakdown = result.breakdown as Record<string, unknown>;
  if (!amount(breakdown.base) || breakdown.base !== Math.min(6, Math.floor(result.score / 40)) || !amount(breakdown.milestones) || breakdown.milestones > 3 || (breakdown.firstVictory !== 0 && breakdown.firstVictory !== 8) || (breakdown.firstAttempt !== 0 && breakdown.firstAttempt !== 3)) return false;
  if ((breakdown.firstVictory !== 0 && result.outcome !== "victory") || (breakdown.firstAttempt !== 0 && result.score < 20)) return false;
  return result.researchReward === breakdown.base + breakdown.milestones + breakdown.firstVictory + breakdown.firstAttempt;
}

/** Cross-field consistency against post-settlement progress and the retained run.
 * Permanent markers corroborate bonuses; they cannot prove historical firstness
 * if an entire history is manually forged. The caller matches run/mission/outcome
 * to its authoritative campaign transition.
 */
export function validateResearchSettlement(value: unknown, economy: EconomyState, metaAfter: MetaProgress): boolean {
  if (!isResearchSettlementShape(value) || !isEconomyState(economy) || !isMetaProgress(metaAfter)) return false;
  if (value.score !== effectiveScore(economy) || value.breakdown.milestones !== economy.events.filter((event) => event.kind === "milestone").length || !metaAfter.settledRunIds.includes(value.runId)) return false;
  if (value.outcome === "victory" && !metaAfter.completedMissions.includes(value.missionId)) return false;
  if (value.score >= 20 && !metaAfter.firstAttemptGranted) return false;
  return true;
}

/** Call only on an actual end-of-run transition; suspend/crash is not an outcome. */
export function settleResearch(meta: MetaProgress, economy: EconomyState, runId: string, missionId: string, outcome: RunOutcome): ResearchSettlement | null {
  const result = computeResearchSettlement(meta, economy, runId, missionId, outcome);
  if (!result) return null;
  meta.researchPoints += result.researchReward;
  if (result.breakdown!.firstAttempt) meta.firstAttemptGranted = true;
  if (result.breakdown!.firstVictory) meta.completedMissions.push(missionId);
  meta.settledRunIds.push(runId);
  return result;
}

/** The activeRun flag includes paused campaigns: permanent purchases are between runs. */
export function purchaseResearch(meta: MetaProgress, nodeId: string, activeRun: boolean, demo = true): boolean {
  if (activeRun !== false || typeof demo !== "boolean" || !isMetaProgress(meta)) return false;
  const node = NODE_BY_ID.get(nodeId);
  if (!node || (demo && !node.demo) || meta.nodes.includes(nodeId) || (node.prerequisite !== null && !meta.nodes.includes(node.prerequisite)) || meta.researchPoints < node.cost) return false;
  meta.researchPoints -= node.cost;
  meta.nodes.push(nodeId);
  return true;
}

/** Full free respec. The caller reconciles equipment against availableResearchEquipment. */
export function resetResearch(meta: MetaProgress, activeRun: boolean): number | null {
  if (activeRun !== false || !isMetaProgress(meta)) return null;
  const refund = meta.nodes.reduce((total, id) => total + NODE_BY_ID.get(id)!.cost, 0);
  if (!amount(meta.researchPoints + refund)) return null;
  meta.researchPoints += refund;
  meta.nodes = [];
  return refund;
}

export function availableResearchEquipment(meta: MetaProgress): string[] {
  if (!isMetaProgress(meta)) throw new RangeError("Invalid research progress");
  return ["bag", "broom", "swat", "bait", "glue", "catcher", "ladder", "bouncePad", "repairPack", ...(meta.nodes.includes("trap-3") ? ["gridDoor"] : [])];
}

/** Equipment invalidated by a respec falls back to its usable basic configuration. */
export function reconcileResearchEquipment(meta: MetaProgress, equipmentId: string): string {
  return availableResearchEquipment(meta).includes(equipmentId) ? equipmentId : "bag";
}
