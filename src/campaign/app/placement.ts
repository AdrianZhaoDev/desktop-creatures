import type { DevicePlacementContextPort, TrustedDevicePlacement } from '../application/campaign-application';
import type { InteractionHandleScope } from '../integration/hit-handles';
import type { CampaignHitRegion } from '../native/types';
import type { SurfaceSnapshotV2 } from '../surface';
import type { CampaignGrabEvent, CampaignPointer } from './input';

export type CampaignPlacementCommand = Parameters<DevicePlacementContextPort['resolve']>[0];
export interface CampaignPlacementOptions {
  scope(): InteractionHandleScope | null;
  surface(): SurfaceSnapshotV2 | null;
  now(): number;
  enabled?(): boolean;
  ready?(): boolean;
  /** Production wiring submits this selected host pointer to the existing trusted input port. */
  resolveAt(command: CampaignPlacementCommand, pointer: CampaignPointer): TrustedDevicePlacement | null | Promise<TrustedDevicePlacement | null>;
  onPrompt(message: string | null): void;
  diagnostic?(code: string, message: string): void;
}
interface PendingPlacement {
  command: CampaignPlacementCommand;
  scope: InteractionHandleScope;
  targetId: string;
  finish(value: TrustedDevicePlacement | null): void;
  resolving: boolean;
  grab: { sessionId: number; entityId: number; timestampMs: number } | null;
  maxSession: number;
}
function sameScope(a: InteractionHandleScope | null, b: InteractionHandleScope): boolean {
  return !!a && a.runId === b.runId && a.displayId === b.displayId && a.generation === b.generation;
}

/** A temporary selection request, never a second campaign or input authority. The shop command
 * stays pending until a real floor click is resolved by the existing trusted placement port. */
export class CampaignPlacementSelection {
  private pending: PendingPlacement | null = null;
  private sequence = 0;
  private disposed = false;
  constructor(private readonly options: CampaignPlacementOptions) {}

  get isPending(): boolean { this.refresh(); return this.pending !== null; }
  private available(): boolean { return !this.disposed && this.options.enabled?.() !== false && this.options.ready?.() !== false; }
  private surface(scope: InteractionHandleScope): SurfaceSnapshotV2 | null {
    const surface = this.options.surface(), now = this.options.now();
    return surface?.valid && surface.displayId === scope.displayId
      && [now, surface.width, surface.height, surface.floorY, surface.verifiedAtMs].every(Number.isFinite)
      && surface.width > 0 && surface.height > 0 && surface.floorY >= 0 && surface.floorY <= surface.height
      && surface.verifiedAtMs <= now + 1000 && now - surface.verifiedAtMs <= 1000 ? surface : null;
  }
  /** Call from the runtime refresh boundary as well as normal region publication. */
  refresh(): void {
    const pending = this.pending;
    if (pending && (!this.available() || !sameScope(this.options.scope(), pending.scope) || !this.surface(pending.scope))) this.cancel();
  }
  request(command: CampaignPlacementCommand): Promise<TrustedDevicePlacement | null> {
    this.cancel();
    const scope = this.options.scope();
    if (!this.available() || !scope || scope.runId !== command.runId || !this.surface(scope)) return Promise.resolve(null);
    return new Promise(resolve => {
      this.pending = { command: { ...command }, scope: { ...scope }, targetId: `placement:${++this.sequence}`,
        finish: resolve, resolving: false, grab: null, maxSession: 0 };
      this.options.onPrompt('点击屏幕底部地面放置设备；Esc 取消。 / Click the floor to place the device; Esc cancels.');
    });
  }
  regions(): CampaignHitRegion[] {
    this.refresh();
    const pending = this.pending;
    if (!pending || pending.resolving) return [];
    const surface = this.surface(pending.scope)!;
    const top = Math.max(0, surface.floorY - 24), bottom = Math.min(surface.height, surface.floorY + 24);
    return [{ target: { kind: 'ui', id: pending.targetId }, centerDip: { x: surface.width / 2, y: (top + bottom) / 2 },
      halfExtentDip: { x: surface.width / 2, y: (bottom - top) / 2 }, rotationRad: 0, priority: 80 }];
  }
  private onFloor(pointer: CampaignPointer, pending: PendingPlacement): boolean {
    const surface = this.surface(pending.scope), p = pointer.localDip;
    return !!surface && pointer.displayId === pending.scope.displayId && [p.x, p.y].every(Number.isFinite)
      && p.x >= 0 && p.x <= surface.width && p.y >= 0 && p.y <= surface.height && Math.abs(p.y - surface.floorY) <= 24;
  }
  handleGrab(event: CampaignGrabEvent): boolean {
    this.refresh();
    const pending = this.pending;
    if (!pending || pending.resolving || event.target.kind !== 'ui' || event.target.id !== pending.targetId) return false;
    if (!sameScope(event.scope, pending.scope) || event.target.runId !== pending.scope.runId || event.grab.displayId !== pending.scope.displayId || event.toolId !== null) return false;
    const grab = event.grab, pointer: CampaignPointer = { displayId: grab.displayId, localDip: { ...grab.localDip } };
    if (grab.phase === 'start') {
      if (pending.grab || !Number.isSafeInteger(grab.sessionId) || grab.sessionId <= pending.maxSession || !this.onFloor(pointer, pending)) return false;
      pending.grab = { sessionId: grab.sessionId, entityId: grab.entityId, timestampMs: grab.timestampMs };
      pending.maxSession = grab.sessionId; return true;
    }
    const active = pending.grab;
    if (!active || active.sessionId !== grab.sessionId || active.entityId !== grab.entityId || grab.timestampMs < active.timestampMs) return false;
    active.timestampMs = grab.timestampMs;
    if (grab.phase === 'cancel') { this.cancel(); return true; }
    if (grab.phase === 'end') { pending.grab = null; void this.selectPoint(pointer); }
    return true;
  }
  /** Browser wiring calls this only from its real pointer handler. Points outside the current
   * floor band leave the request pending; no UI-controlled placement position is accepted. */
  async selectPoint(pointer: CampaignPointer): Promise<boolean> {
    this.refresh();
    const pending = this.pending;
    if (!pending || pending.resolving || !this.onFloor(pointer, pending)) return false;
    const selectedSurface = this.surface(pending.scope)!;
    const geometry = { width: selectedSurface.width, height: selectedSurface.height, floorY: selectedSurface.floorY };
    pending.resolving = true; pending.grab = null;
    try {
      const placement = await this.options.resolveAt({ ...pending.command }, { displayId: pointer.displayId, localDip: { ...pointer.localDip } });
      this.refresh();
      if (this.pending !== pending) return false;
      const surface = this.surface(pending.scope);
      if (!surface || surface.width !== geometry.width || surface.height !== geometry.height || surface.floorY !== geometry.floorY || !this.onFloor(pointer, pending)) {
        this.complete(pending, null); return false;
      }
      this.complete(pending, placement); return placement !== null;
    } catch (error) {
      if (this.pending === pending) {
        this.options.diagnostic?.('placement-resolution-failed', String(error));
        this.complete(pending, null);
      }
      return false;
    }
  }
  private complete(pending: PendingPlacement, value: TrustedDevicePlacement | null): void {
    if (this.pending !== pending) return;
    this.pending = null; pending.finish(value === null ? null : structuredClone(value)); this.options.onPrompt(null);
  }
  cancel(): void { const pending = this.pending; if (pending) this.complete(pending, null); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.cancel(); }
}
