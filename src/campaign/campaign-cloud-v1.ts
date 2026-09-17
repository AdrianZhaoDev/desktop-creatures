import { createGameSaveV4, V4_LIMITS } from './campaign-save-v4';
import { validateCampaignSessionDocument, type CampaignRustInvoke, type CampaignSessionDocument } from './campaign-session-v4';

export interface CampaignCloudProjectionV1 {
  cloudVersion: 1;
  session: CampaignSessionDocument;
}

export const CAMPAIGN_CLOUD_MAX_BYTES = 16 * 1024 * 1024;
export const CAMPAIGN_CLOUD_COMMANDS = Object.freeze({
  read: 'read_campaign_cloud',
  refresh: 'refresh_campaign_cloud',
  restore: 'restore_campaign_cloud',
});

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const FORBIDDEN_PREFIX = /^(?:[A-Za-z]:|https?:|file:|data:|smb:|ssh:)/i;
const MAX_STEAM_ID = 18_446_744_073_709_551_615n;

function reject(message: string): never { throw new Error(`Invalid campaign cloud projection: ${message}`); }
function own(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }

interface ScanBudget { nodes: number }

function scanEmbedded(value: unknown, depth: number, budget: ScanBudget): void {
  budget.nodes++;
  if (budget.nodes > V4_LIMITS.nodes || depth > V4_LIMITS.depth) reject('embedded JSON scale');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) reject('embedded JSON number');
    return;
  }
  if (typeof value === 'string') {
    if (value === '') reject('empty embedded token');
    scanString(value, true, depth, budget);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > V4_LIMITS.commands) reject('embedded JSON array scale');
    for (const item of value) scanEmbedded(item, depth + 1, budget);
    return;
  }
  if (!value || typeof value !== 'object') reject('embedded JSON value');
  const point = value as Record<string, unknown>;
  const keys = Object.keys(point);
  if (keys.length !== 2 || !own(point, 'x') || !own(point, 'y')) reject('opaque embedded JSON object');
  if (typeof point.x !== 'number' || !Number.isFinite(point.x) || point.x < 0 || point.x > 1
    || typeof point.y !== 'number' || !Number.isFinite(point.y) || point.y < 0 || point.y > 1) {
    reject('embedded JSON point');
  }
  scanEmbedded(point.x, depth + 1, budget);
  scanEmbedded(point.y, depth + 1, budget);
}

function scanString(value: string, embedded: boolean, depth: number, budget: ScanBudget): void {
  if (value.startsWith('{')) reject('opaque JSON string');
  if (value.startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { reject('malformed embedded JSON array'); }
    if (!Array.isArray(parsed)) reject('embedded JSON must be an array');
    scanEmbedded(parsed, depth + 1, budget);
    return;
  }
  if (value === '' && !embedded) return;
  if (!TOKEN.test(value) || value.includes('..') || FORBIDDEN_PREFIX.test(value)) reject('unsafe string token');
}

/** Reject accessors, aliases, exotic prototypes, sparse arrays and hidden fields before
 * the domain validator reads any input-owned property. The V4 validator remains the
 * authority for every campaign and S07 semantic/cross-ledger invariant.
 */
function scanProjection(value: unknown): void {
  const budget: ScanBudget = { nodes: 0 };
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop()!;
    budget.nodes++;
    if (budget.nodes > V4_LIMITS.nodes || next.depth > V4_LIMITS.depth) reject('document scale');
    if (typeof next.value === 'string') { scanString(next.value, false, next.depth, budget); continue; }
    if (next.value === null || typeof next.value === 'boolean') continue;
    if (typeof next.value === 'number') {
      if (!Number.isFinite(next.value) || Math.abs(next.value) > Number.MAX_SAFE_INTEGER) reject('JSON number');
      continue;
    }
    if (!next.value || typeof next.value !== 'object') reject('JSON value');
    if (seen.has(next.value)) reject('cyclic or aliased JSON object');
    seen.add(next.value);
    const isArray = Array.isArray(next.value);
    const prototype = Object.getPrototypeOf(next.value);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) reject('JSON object type');
    if (Object.getOwnPropertySymbols(next.value).length !== 0) reject('JSON symbol');
    const descriptors = Object.getOwnPropertyDescriptors(next.value);
    if (isArray) {
      const array = next.value as unknown[];
      if (array.length > V4_LIMITS.commands || Object.keys(array).length !== array.length) reject('array scale or holes');
      if (Object.keys(descriptors).some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) reject('array property');
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (isArray && key === 'length') continue;
      if (!('value' in descriptor) || !descriptor.enumerable) reject('JSON accessor or hidden field');
      scanString(key, false, next.depth + 1, budget);
      pending.push({ value: descriptor.value, depth: next.depth + 1 });
    }
  }
}

function byteLength(json: string): number { return new TextEncoder().encode(json).byteLength; }

function validateCloudProfile(profile: string): void {
  if (profile === 'local') return;
  const match = /^steam:([1-9][0-9]{0,19})$/.exec(profile);
  if (!match || BigInt(match[1]) > MAX_STEAM_ID) reject('profile');
}

function requireCanonicalTransients(session: CampaignSessionDocument): void {
  const run = session.campaign.activeRun;
  if (!run) return;
  if (run.pauseReasons.length > 1 || (run.pauseReasons.length === 1 && run.pauseReasons[0] !== 'user')) reject('non-canonical pause reasons');
  const swatter = run.swatter;
  if (swatter.active || swatter.gestureId !== '' || swatter.path.length !== 0 || swatter.hitIds.length !== 0
    || swatter.start.x !== 0 || swatter.start.y !== 0 || swatter.end.x !== 0 || swatter.end.y !== 0) {
    reject('non-canonical swatter gesture');
  }
}

export function validateCloudProjection(value: unknown, expectedProfile?: string): CampaignCloudProjectionV1 {
  scanProjection(value);
  if (expectedProfile !== undefined) validateCloudProfile(expectedProfile);
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('document');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !own(record, 'cloudVersion') || !own(record, 'session') || record.cloudVersion !== 1) {
    reject('unsupported version or unexpected fields');
  }
  const session = validateCampaignSessionDocument(record.session, expectedProfile);
  validateCloudProfile(session.campaign.profile);
  if (session.campaign.legacyCompanion !== null) reject('legacy companion content');
  requireCanonicalTransients(session);
  const projection: CampaignCloudProjectionV1 = { cloudVersion: 1, session };
  const json = JSON.stringify(projection);
  if (byteLength(json) > CAMPAIGN_CLOUD_MAX_BYTES) reject('UTF-8 byte limit');
  return projection;
}

/** Create a detached cloud-safe projection from fully validated canonical state. */
export function createCloudProjection(session: CampaignSessionDocument): CampaignCloudProjectionV1 {
  const canonical = validateCampaignSessionDocument(session);
  canonical.campaign.legacyCompanion = null;
  const run = canonical.campaign.activeRun;
  if (run) {
    run.pauseReasons = run.pauseReasons.filter(reason => reason === 'user');
    Object.assign(run.swatter, {
      active: false,
      gestureId: '',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      path: [],
      hitIds: [],
    });
  }
  return validateCloudProjection({ cloudVersion: 1, session: canonical }, canonical.campaign.profile);
}

export type CloudRestoreDecision = 'restore' | 'local-present' | 'legacy-backup-present' | 'live-session';
export interface CloudRestorePresence {
  canonicalPresent: boolean;
  backupPresent: boolean;
  legacyBackupPresent: boolean;
  liveSessionStarted: boolean;
}

/** Presence beats timestamps and revisions. No branch merges state or replays settlement. */
export function selectCloudRestore(presence: CloudRestorePresence): CloudRestoreDecision {
  if (!presence || typeof presence !== 'object' || Array.isArray(presence)) reject('restore presence');
  const fields = ['canonicalPresent', 'backupPresent', 'legacyBackupPresent', 'liveSessionStarted'] as const;
  if (Object.keys(presence).length !== fields.length || fields.some(field => !own(presence, field) || typeof presence[field] !== 'boolean')) {
    reject('restore presence');
  }
  if (presence.liveSessionStarted) return 'live-session';
  if (presence.canonicalPresent || presence.backupPresent) return 'local-present';
  if (presence.legacyBackupPresent) return 'legacy-backup-present';
  return 'restore';
}

export interface CampaignCloudBridge {
  read(profile: string): Promise<CampaignCloudProjectionV1 | null>;
  refresh(profile: string): Promise<'current'>;
  restore(profile: string, value: unknown, context: { liveSessionStarted: boolean }): Promise<'restored' | 'local-present'>;
}

function validCommands(commands: { read: string; refresh: string; restore: string }): void {
  const names = Object.values(commands);
  if (names.some(name => !TOKEN.test(name) || name.includes('..')) || new Set(names).size !== 3) reject('dedicated native commands');
}

function semanticEqual(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    const aArray = Array.isArray(a), bArray = Array.isArray(b);
    if (aArray !== bArray) return false;
    if (aArray && bArray) {
      if (a.length !== b.length) return false;
      for (let index = 0; index < a.length; index++) pending.push([a[index], b[index]]);
      continue;
    }
    const aRecord = a as Record<string, unknown>, bRecord = b as Record<string, unknown>;
    const keys = Object.keys(aRecord);
    if (keys.length !== Object.keys(bRecord).length || keys.some(key => !own(bRecord, key))) return false;
    for (const key of keys) pending.push([aRecord[key], bRecord[key]]);
  }
  return true;
}

function parseCloudRaw(raw: unknown, profile: string): { raw: string; projection: CampaignCloudProjectionV1 } {
  if (typeof raw !== 'string' || byteLength(raw) > CAMPAIGN_CLOUD_MAX_BYTES) reject('native read payload');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { reject('native read JSON'); }
  return { raw, projection: validateCloudProjection(parsed, profile) };
}

export function createRustCampaignCloudBridge(
  invoke: CampaignRustInvoke,
  commands: { read: string; refresh: string; restore: string } = CAMPAIGN_CLOUD_COMMANDS,
): CampaignCloudBridge {
  validCommands(commands);
  // Steam identities must come from the future native Steam API. The current UI bridge
  // is deliberately local-only so a renderer-supplied decimal cannot create a profile.
  const validProfile = (profile: string): void => {
    createGameSaveV4(profile);
    if (profile !== 'local') reject('native bridge profile');
  };
  return {
    async read(profile) {
      validProfile(profile);
      const raw: unknown = await invoke<unknown>(commands.read, { profile });
      if (raw === null) return null;
      return parseCloudRaw(raw, profile).projection;
    },
    async refresh(profile) {
      validProfile(profile);
      const result: unknown = await invoke<unknown>(commands.refresh, { profile });
      if (result !== 'current') reject('native refresh result');
      return result;
    },
    async restore(profile, value, context) {
      validProfile(profile);
      if (!context || context.liveSessionStarted !== false) reject('restore during live session');
      const requested = validateCloudProjection(value, profile);
      const reread: unknown = await invoke<unknown>(commands.read, { profile });
      if (reread === null) reject('missing cloud source');
      const current = parseCloudRaw(reread, profile);
      if (!semanticEqual(current.projection, requested)) reject('cloud changed before restore');
      // Native compares its fixed cloud file with these exact bytes while holding the
      // profile lock. Never JSON.stringify here: whitespace/key order are byte-significant.
      const result: unknown = await invoke<unknown>(commands.restore, { profile, json: current.raw });
      if (result !== 'restored' && result !== 'local-present') reject('native restore result');
      return result;
    },
  };
}
