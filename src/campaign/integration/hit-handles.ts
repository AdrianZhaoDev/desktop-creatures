/** Ephemeral domain-string mappings. Nothing in this module belongs in a save. */
export type HitKind = 'ui' | 'object' | 'actor' | 'house' | 'trap';
export interface HitTarget { kind: HitKind; id: string }
export interface HitIdentity extends HitTarget { runId: string }
export interface InteractionHandleScope { runId: string; displayId: string; generation: number }
export interface InteractionHit { handle: number; displayId: string; generation: number }
export const MAX_HIT_HANDLE = Number.MAX_SAFE_INTEGER;
/** Reserved for the legacy gray runtime (UI 1..22 and placement 100). */
export const FIRST_CAMPAIGN_HANDLE = 101;

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid hit handle: ${message}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  requireThat(Object.keys(value).length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key)), 'unexpected or missing fields');
}
function id(value: unknown): asserts value is string {
  requireThat(typeof value === 'string' && value.trim().length > 0, 'empty or invalid ID');
}
function integer(value: unknown): asserts value is number {
  requireThat(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, 'expected a positive safe integer');
}
export function validateHandleScope(value: unknown): asserts value is InteractionHandleScope {
  requireThat(record(value), 'scope must be an object'); keys(value, ['runId', 'displayId', 'generation']);
  id(value.runId); id(value.displayId); integer(value.generation);
}

/** Share one allocator for every region kind and every runtime generation. Never reuse a handle. */
export class CampaignHandleAllocator {
  private highWaterMark: number;
  private readonly used = new Set<number>();
  constructor(first = FIRST_CAMPAIGN_HANDLE) {
    integer(first); requireThat(first >= FIRST_CAMPAIGN_HANDLE, 'legacy handle range is reserved');
    this.highWaterMark = first - 1;
  }
  allocate(requested?: number): number {
    if (requested !== undefined) {
      integer(requested); requireThat(requested >= FIRST_CAMPAIGN_HANDLE, 'legacy handle range is reserved');
    } else {
      requireThat(this.highWaterMark < MAX_HIT_HANDLE, 'handle range exhausted');
    }
    const handle = requested ?? this.highWaterMark + 1;
    requireThat(!this.used.has(handle), 'handle already bound');
    this.used.add(handle); this.highWaterMark = Math.max(this.highWaterMark, handle);
    return handle;
  }
}
const runtimeAllocator = new CampaignHandleAllocator();

/** Scope is the runtime lifetime, NOT a Rust grab session (created only after native start). */
export class InteractionHandleRegistry {
  private readonly byHandle = new Map<number, HitIdentity>();
  private readonly byIdentity = new Map<string, number>();
  private readonly scope: InteractionHandleScope;
  private active = true;
  constructor(scope: InteractionHandleScope, private readonly allocator = runtimeAllocator) {
    validateHandleScope(scope); this.scope = { ...scope };
  }
  bind(target: HitTarget, requested?: number): number {
    requireThat(this.active, 'registry invalidated'); requireThat(record(target), 'target must be an object');
    keys(target, ['kind', 'id']); id(target.id);
    requireThat(['ui', 'object', 'actor', 'house', 'trap'].includes(target.kind), 'unknown kind');
    if (requested !== undefined) integer(requested);
    const key = JSON.stringify([target.kind, target.id]);
    const existing = this.byIdentity.get(key);
    if (existing !== undefined) {
      requireThat(requested === undefined || requested === existing, 'identity already bound to another handle');
      return existing;
    }
    const handle = this.allocator.allocate(requested);
    this.byHandle.set(handle, { ...target, runId: this.scope.runId }); this.byIdentity.set(key, handle);
    return handle;
  }
  resolve(hit: InteractionHit): HitIdentity | undefined {
    requireThat(record(hit), 'hit must be an object'); keys(hit, ['handle', 'displayId', 'generation']);
    integer(hit.handle); integer(hit.generation); id(hit.displayId);
    if (!this.active || hit.displayId !== this.scope.displayId || hit.generation !== this.scope.generation) return undefined;
    const value = this.byHandle.get(hit.handle); return value && { ...value };
  }
  invalidate(): void { this.active = false; this.byHandle.clear(); this.byIdentity.clear(); }
}
export { InteractionHandleRegistry as HitHandleRegistry };

