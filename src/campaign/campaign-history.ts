import type { RunState } from './campaign-controller';
import { archiveEconomyEvents } from './economy';
import { autonomousCommandPosition, canonicalObjects, hasKey, residueBatches, type Receipt, type ResidueBatch } from './tool-system';

const MIN_DISPOSED_TO_COMPACT = 256;
const MAX_RECENT_DISPOSED = 128;
const MIN_COMMANDS_TO_COMPACT = 2_048;
const COMMAND_RETENTION_TICKS = 600;

function ecologySequence(id: string): number | null {
  const match = /^ecology:([1-9]\d*)$/.exec(id);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function safeHomeVisits(current: Record<string, number> | undefined, supplied: Record<string, number> | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  const keys = new Set([...Object.keys(current ?? {}), ...Object.keys(supplied ?? {})]);
  for (const id of [...keys].sort()) {
    const oldVisit = current && hasKey(current, id) ? current[id] : undefined;
    const nextVisit = supplied && hasKey(supplied, id) ? supplied[id] : undefined;
    const validOld = Number.isSafeInteger(oldVisit) && oldVisit! >= 0 ? oldVisit! : 0;
    const validNext = Number.isSafeInteger(nextVisit) && nextVisit! >= 0 ? nextVisit! : 0;
    const visit = Math.max(validOld, validNext);
    if (/^home\.[^:]+$/.test(id) && id.length <= 512 && visit > 0) {
      Object.defineProperty(result, id, { value: visit, enumerable: true, writable: true, configurable: true });
    }
  }
  return result;
}

function protectedObjectIds(run: RunState): Set<string> {
  const protectedIds = new Set(run.swatter.hitIds);
  for (const actor of run.actors) if (actor.pose.taskId) protectedIds.add(actor.pose.taskId);
  for (const item of canonicalObjects(run.inventory)) if (item.ecology?.carrierId) protectedIds.add(item.ecology.carrierId);
  return protectedIds;
}

function activeResidueReceipts(batches: readonly ResidueBatch[]): Set<string> {
  return new Set(batches.map(batch => batch.commandId));
}

function residueReceiptMembers(receipt: Receipt): string[] {
  if (!receipt.ok) return [];
  let signature: unknown;
  try { signature = JSON.parse(receipt.signature); } catch { return []; }
  if (!Array.isArray(signature) || signature.length !== 4 || signature[0] !== 'residue-batch'
    || !Array.isArray(signature[2])) return [];
  return signature[2].filter((id): id is string => typeof id === 'string');
}

function commandCanRetire(run: RunState, commandId: string, commandTick: number, homeVisits: Record<string, number>, protectedReceipts: Set<string>): boolean {
  if (protectedReceipts.has(commandId)) return false;
  const position = autonomousCommandPosition(commandId);
  if (!position) return false;
  if (position.kind === 'tick') {
    if (position.runId !== undefined && position.runId !== run.runId) return false;
    return position.tick <= commandTick;
  }
  return hasKey(homeVisits, position.homeId) && position.visit <= homeVisits[position.homeId];
}

/**
 * Fold old disposed ecology identities and autonomous replay receipts into monotonic
 * tombstones. Manual commands, payments, active residue batches and live references stay.
 */
export function compactCampaignHistory(run: RunState, homeVisits?: Record<string, number>): void {
  if (run.ecology.cycleVersion !== 2 || !Number.isSafeInteger(run.tick) || run.tick < 0
    || !Number.isSafeInteger(run.ecology.nextId) || run.ecology.nextId < 1) return;
  const objectCount = Object.keys(run.inventory.objects).length;
  if (run.tick % COMMAND_RETENTION_TICKS !== 0 && objectCount <= 768) return;
  const disposed = canonicalObjects(run.inventory).map(item => ({ item, sequence: ecologySequence(item.id) }))
    .filter((entry): entry is { item: typeof entry.item; sequence: number } => entry.sequence !== null && entry.item.owner === 'disposed')
    .sort((left, right) => left.sequence - right.sequence);
  const commandCount = Object.keys(run.inventory.commands).length;
  if (disposed.length <= MIN_DISPOSED_TO_COMPACT && commandCount <= MIN_COMMANDS_TO_COMPACT) return;

  const prior = run.inventory.retired;
  const commandTick = Math.max(prior?.commandTick ?? 0, Math.max(0, run.tick - COMMAND_RETENTION_TICKS));
  const retiredHomeVisits = safeHomeVisits(prior?.homeVisits, homeVisits);
  const batches = residueBatches(run.inventory);
  const protectedReceipts = activeResidueReceipts(batches);
  const retiringCommands = Object.keys(run.inventory.commands).filter(commandId =>
    commandCanRetire(run, commandId, commandTick, retiredHomeVisits, protectedReceipts));
  const retiringCommandIds = new Set(retiringCommands);

  // A retained receipt is part of the save proof for every original batch member,
  // even after one member has been collected or disposed and is no longer presented
  // by residueBatches(). Retire the receipt and its unreferenced history together.
  const protectedIds = protectedObjectIds(run);
  for (const [commandId, receipt] of Object.entries(run.inventory.commands)) {
    if (retiringCommandIds.has(commandId)) continue;
    for (const id of residueReceiptMembers(receipt)) protectedIds.add(id);
  }
  const oldDisposed = disposed.slice(0, Math.max(0, disposed.length - MAX_RECENT_DISPOSED));
  const retiringIds = new Set(oldDisposed.filter(entry => !protectedIds.has(entry.item.id)).map(entry => entry.item.id));
  const economy = structuredClone(run.economy);
  if (!archiveEconomyEvents(economy, retiringIds)) return;

  for (const id of retiringIds) delete run.inventory.objects[id];
  for (const commandId of retiringCommands) delete run.inventory.commands[commandId];
  run.economy.events = economy.events;
  if (economy.archived) run.economy.archived = economy.archived;
  run.inventory.retired = {
    ecologyThrough: Math.max(prior?.ecologyThrough ?? 0, run.ecology.nextId - 1),
    commandTick,
    homeVisits: retiredHomeVisits,
  };
}
