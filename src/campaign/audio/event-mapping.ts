import type { CampaignPhase, HouseState, RunState } from "../campaign-controller";
import type { TongueEvent } from "../role-abilities";
import type { Receipt } from "../tool-system";
import type { CampaignAudioEvent } from "./types";

export type CampaignReceiptAction =
  | "pickup"
  | "bag-dispose"
  | "capture"
  | "swatter-hit"
  | "purchase"
  | "ui-confirm";

/** Maps committed command results only. Replayed successful receipts may be suppressed by the caller. */
export function audioEventsForReceipt(
  action: CampaignReceiptAction,
  receipt: Pick<Receipt, "ok">,
  repeated = false,
): CampaignAudioEvent[] {
  if (repeated) return [];
  if (action === "purchase") return [{ type: receipt.ok ? "purchase-success" : "purchase-failed" }];
  if (!receipt.ok) return [];
  if (action === "pickup") return [{ type: "item-pickup" }];
  if (action === "bag-dispose") return [{ type: "bag-dispose" }];
  if (action === "capture") return [{ type: "capture" }];
  if (action === "swatter-hit") return [{ type: "swatter-hit" }];
  return [{ type: "ui-confirm" }];
}

/** Converts deltas from the S07 ability adapter without coupling audio to its controller. */
export interface RoleAudioUpdateView {
  readonly cleanedTotal: number;
  readonly capturedTotal: number;
  readonly lastTongue?: Pick<TongueEvent, "sequence">;
}

export function audioEventsForRoleUpdate(
  previous: RoleAudioUpdateView,
  current: RoleAudioUpdateView,
): CampaignAudioEvent[] {
  const events: CampaignAudioEvent[] = [];
  if (current.lastTongue && current.lastTongue.sequence !== previous.lastTongue?.sequence) {
    events.push({ type: "tongue-fire" });
  }
  const captured = current.capturedTotal - previous.capturedTotal;
  if (Number.isFinite(captured) && captured > 0) events.push({ type: "capture", count: captured });
  const cleaned = current.cleanedTotal - previous.cleanedTotal;
  if (Number.isFinite(cleaned) && cleaned > 0) events.push({ type: "clean-sweep", count: cleaned });
  return events;
}

export interface CampaignAudioRunView {
  readonly phase: CampaignPhase;
  readonly houses: readonly Pick<HouseState, "id" | "hp" | "maxHp">[];
  readonly swatter: Pick<RunState["swatter"], "overheated">;
}

function finiteHp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Pure state-edge mapper: callers snapshot before mutation, then publish only the returned edges. */
export function audioEventsForRunTransition(
  previous: CampaignAudioRunView,
  current: CampaignAudioRunView,
): CampaignAudioEvent[] {
  const events: CampaignAudioEvent[] = [];
  if (!previous.swatter.overheated && current.swatter.overheated) events.push({ type: "swatter-overheat" });

  let damagedHomes = 0;
  let newlyLowHomes = 0;
  const beforeById = new Map(previous.houses.map(house => [house.id, house]));
  for (const house of current.houses) {
    const before = beforeById.get(house.id);
    if (!before) continue;
    const previousHp = finiteHp(before.hp);
    const currentHp = finiteHp(house.hp);
    if (currentHp < previousHp) damagedHomes++;
    const previousRatio = before.maxHp > 0 ? previousHp / before.maxHp : 0;
    const currentRatio = house.maxHp > 0 ? currentHp / house.maxHp : 0;
    if (previousRatio > 0.25 && currentRatio <= 0.25 && currentHp > 0) newlyLowHomes++;
  }
  if (damagedHomes > 0) events.push({ type: "home-hit", count: damagedHomes });
  if (newlyLowHomes > 0) events.push({ type: "home-low", count: newlyLowHomes });

  if (previous.phase !== current.phase) {
    if (current.phase === "retreat") events.push({ type: "retreat" });
    else if (current.phase === "victory") events.push({ type: "victory" });
    else if (current.phase === "defeat") events.push({ type: "defeat" });
  }
  return events;
}
