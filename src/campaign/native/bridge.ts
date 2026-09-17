import { InteractionHandleRegistry, validateHandleScope, type InteractionHandleScope, type HitIdentity } from '../integration/hit-handles';
import type { SurfaceSnapshotV2 } from '../surface';
import type { BinGeometry, CampaignHitRegion, CancelReason, NativeCampaignHost, NativeCampaignRuntimeEvent, NativeGrab, NativeRegion, Point, Unlisten } from './types';
import { check, parseBin, parseGrab, parseSurface, point, real, uint } from './validation';

export interface NativeCampaignBridgeOptions {
  host: NativeCampaignHost;
  scope: InteractionHandleScope;
  emit: (event: NativeCampaignRuntimeEvent) => void;
  regions: () => readonly CampaignHitRegion[];
  equippedTool: () => string | null;
  surfaceHz?: number;
  /** Rust window binding, independent of the local run/handle scope generation. */
  bindingGeneration?: number;
  /** Local preview only: use host-provided bottom-edge terrain when capture is unavailable. */
  allowSurfaceFallback?: boolean;
}
interface ActiveGrab { grab: NativeGrab; target: HitIdentity; toolId: string | null; seen: Set<string> }
interface PublishedRegion { native: NativeRegion; target: HitIdentity; toolId: string | null }
function acceptsTool(kind: HitIdentity['kind'], regionTool: string | null | undefined, equippedTool: string | null): boolean {
  if (kind === 'ui') return true;
  if (kind === 'house') return regionTool == null || regionTool === equippedTool;
  if (kind === 'object' && regionTool == null) return equippedTool === null;
  return typeof regionTool === 'string' && regionTool === equippedTool;
}
/** Houses are anchored to the overlay viewport, not detected desktop terrain. */
function requiresHealthySurface(kind: HitIdentity['kind']): boolean {
  return kind !== 'ui' && kind !== 'house';
}
function inside(p: Point, r: NativeRegion): boolean {
  const x = p.x - r.centerDip.x, y = p.y - r.centerDip.y, c = Math.cos(r.rotationRad), s = Math.sin(r.rotationRad);
  return Math.abs(x * c + y * s) <= r.halfExtentDip.x && Math.abs(-x * s + y * c) <= r.halfExtentDip.y;
}

/** One bridge on the selected authoritative overlay. Owns transport and gestures, never RunState. */
export class NativeCampaignBridge {
  private scope: InteractionHandleScope;
  private registry: InteractionHandleRegistry;
  private readonly host: NativeCampaignHost;
  private readonly surfaceInterval: number;
  private disposed = false;
  private started = false;
  private starting?: Promise<void>;
  private epoch = 0;
  private publicationEpoch = 0;
  private surfaceEpoch = 0;
  private cleanup: Unlisten[] = [];
  private writes: Promise<void> = Promise.resolve();
  private regionBusy = false;
  private surfaceBusy = false;
  private binBusy = false;
  private heartbeatBusy = false;
  private revision = 0;
  private maxSession = 0;
  private active?: ActiveGrab;
  private published = new Map<number, PublishedRegion>();
  private nativePaused = false;
  private hidden = false;
  private surfaceHealthy = false;
  private surface?: SurfaceSnapshotV2;
  private bin?: { geometry: BinGeometry; at: number };
  private quitPending = false;
  private lastTool: string | null;
  private bindingGeneration: number;
  private displaySuspended = false;
  constructor(private readonly options: NativeCampaignBridgeOptions) {
    validateHandleScope(options.scope); this.scope = { ...options.scope };
    this.bindingGeneration = options.bindingGeneration ?? 1; uint(this.bindingGeneration, true);
    this.registry = new InteractionHandleRegistry(this.scope); this.host = options.host;
    const hz = options.surfaceHz ?? 5; check(Number.isFinite(hz) && hz >= 4 && hz <= 10, 'surfaceHz must be 4..10');
    this.surfaceInterval = 1000 / hz; this.lastTool = options.equippedTool();
  }
  private emit(event: NativeCampaignRuntimeEvent): void { if (!this.disposed) this.options.emit(event); }
  private surfaceAvailable(): boolean { return this.surfaceHealthy || this.options.allowSurfaceFallback === true; }
  private diagnostic(code: string, error: unknown): void { this.emit({ type: 'diagnostic', code, message: String(error) }); }
  private current(epoch: number): boolean { return !this.disposed && this.epoch === epoch; }
  private own(unlisten: Unlisten): void { if (this.disposed) unlisten(); else this.cleanup.push(unlisten); }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.then(operation); this.writes = result.catch(error => this.diagnostic('native-write', error)); return result;
  }
  async start(): Promise<void> {
    check(!this.disposed, 'bridge disposed');
    this.starting ??= this.startOnce(); await this.starting;
  }
  private async startOnce(): Promise<void> {
    this.started = true;
    try {
      for (const [name, callback] of [
        ['game://grab', (payload: unknown) => this.receiveGrab(payload)],
        ['game://command', (payload: unknown) => this.receiveCommand(payload)],
        ['creature://pause', (payload: unknown) => this.receivePause(payload)],
      ] as const) {
        this.own(await this.host.listen(name, payload => { if (!this.disposed) callback(payload); }));
        if (this.disposed) return;
      }
      this.own(this.host.onLifecycle(event => {
        if (this.disposed) return;
        if (event === 'hidden' || event === 'visible') {
          this.hidden = event === 'hidden'; this.emit({ type: 'pause', source: 'visibility', paused: this.hidden });
          if (this.hidden) {
            this.surfaceEpoch++; this.surface = undefined; this.surfaceHealthy = false;
            this.emit({ type: 'pause', source: 'surface', paused: true }); void this.cancel('hidden');
          }
        } else if (event === 'blur' || this.active || this.options.equippedTool()) void this.cancel(event);
      }));
      // Clear any old runtime snapshots before this runtime starts publishing.
      await this.cancel('scope-change'); if (this.disposed) return;
      this.own(this.host.every(this.surfaceInterval, () => { void this.pollSurface(); void this.pollBin(); }));
      this.own(this.host.every(50, () => { void this.publishRegions(); }));
      this.own(this.host.every(2000, () => { void this.heartbeat(); }));
      await Promise.all([this.pollSurface(), this.pollBin(), this.heartbeat()]);
      await this.publishRegions();
    } catch (error) { this.diagnostic('native-start', error); await this.dispose(); throw error; }
  }
  /** Cancels local ownership immediately, then serializes the native release after in-flight publications. */
  cancel(reason: CancelReason): Promise<void> {
    if (this.disposed) return this.writes;
    this.publicationEpoch++;
    this.published.clear();
    const active = this.active; this.active = undefined;
    if (active) this.emit({ type: 'grab', scope: { ...this.scope }, target: { ...active.target }, toolId: active.toolId,
      grab: { ...active.grab, phase: 'cancel' }, cancelReason: reason });
    return this.enqueue(async () => {
      try { await this.host.invoke('cancel_game_grab'); } catch (error) { this.diagnostic('native-cancel', error); }
    });
  }
  async setScope(scope: InteractionHandleScope): Promise<void> {
    check(!this.disposed, 'bridge disposed'); validateHandleScope(scope);
    if (scope.runId === this.scope.runId && scope.displayId === this.scope.displayId && scope.generation === this.scope.generation) return;
    const release = this.cancel(scope.displayId === this.scope.displayId ? 'scope-change' : 'display-change');
    this.epoch++; this.registry.invalidate(); this.scope = { ...scope }; this.registry = new InteractionHandleRegistry(scope);
    this.surface = undefined; this.surfaceHealthy = false; this.bin = undefined;
    this.emit({ type: 'pause', source: 'surface', paused: true });
    await release;
  }
  async suspendDisplay(): Promise<void> {
    this.displaySuspended = true; this.surfaceEpoch++; this.surface = undefined; this.surfaceHealthy = false; this.bin = undefined;
    await this.cancel('display-change');
  }
  async setDisplayBinding(scope: InteractionHandleScope, bindingGeneration: number): Promise<void> {
    uint(bindingGeneration, true);
    await this.suspendDisplay();
    this.bindingGeneration = bindingGeneration;
    await this.setScope(scope);
  }
  resumeDisplay(): void { this.displaySuspended = false; }
  /** A post-binding native request must verify the exact new DIP geometry before release. */
  waitForDisplaySurface(width: number, height: number, timeoutMs = 10000): Promise<void> {
    const epoch = this.epoch, started = this.host.now();
    return new Promise((resolve, reject) => {
      let checking = false;
      let settled = false;
      let stop: Unlisten = () => {};
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true; stop();
        if (error !== undefined) reject(error); else resolve();
      };
      const checkSurface = async () => {
        if (settled) return;
        // The deadline and disposal checks cannot depend on an IPC response. A
        // hung native request must not hold the recovery controls busy forever.
        if (!this.current(epoch)) { finish(new Error('Display surface wait cancelled')); return; }
        if (this.host.now() - started >= timeoutMs) { finish(new Error('Timed out waiting for fresh display surface')); return; }
        if (checking) return; checking = true;
        try {
          await this.pollSurface();
          if (settled) return;
          if (!this.current(epoch)) throw new Error('Display surface wait cancelled');
          if (this.host.now() - started >= timeoutMs) throw new Error('Timed out waiting for fresh display surface');
          if (this.surfaceHealthy && this.surface?.width === width && this.surface.height === height) finish();
        } catch (error) { finish(error); }
        finally { checking = false; }
      };
      stop = this.host.every(100, () => { void checkSurface(); });
      void checkSurface();
    });
  }
  private toolChanged(): boolean {
    const tool = this.options.equippedTool();
    if (tool === this.lastTool) return false;
    this.lastTool = tool; void this.cancel('tool-change'); return true;
  }
  async publishRegions(): Promise<void> {
    if (this.disposed || !this.started || this.regionBusy) return;
    this.regionBusy = true; const epoch = this.epoch;
    try {
      this.toolChanged();
      if (this.surfaceHealthy && this.surface && this.host.now() - this.surface.verifiedAtMs > 1000) this.unhealthy('surface verification expired');
      const publicationEpoch = this.publicationEpoch;
      const next = new Map<number, PublishedRegion>();
      if (!this.hidden && !this.quitPending && !this.displaySuspended) for (const region of this.options.regions()) {
        const isUi = region.target.kind === 'ui';
        if (!isUi && (this.nativePaused || requiresHealthySurface(region.target.kind) && !this.surfaceAvailable()
          || !acceptsTool(region.target.kind, region.toolId, this.lastTool))) continue;
        point(region.centerDip); point(region.halfExtentDip); real(region.rotationRad);
        check(region.halfExtentDip.x > 0 && region.halfExtentDip.y > 0, 'invalid hit extent');
        check(Number.isSafeInteger(region.priority) && region.priority >= -2147483648 && region.priority <= 2147483647, 'invalid i32 priority');
        const entityId = this.registry.bind(region.target);
        check(!next.has(entityId), 'duplicate region target');
        const native: NativeRegion = { entityId, kind: `campaign-${region.target.kind}`, centerDip: { ...region.centerDip },
          halfExtentDip: { ...region.halfExtentDip }, rotationRad: region.rotationRad, priority: region.priority };
        next.set(entityId, { native, target: { ...region.target, runId: this.scope.runId }, toolId: isUi ? null : region.toolId ?? null });
      }
      await this.enqueue(async () => {
        if (!this.current(epoch) || this.publicationEpoch !== publicationEpoch) return;
        uint(this.revision + 1, true); const generatedAtMs = this.host.now(); uint(generatedAtMs);
        this.published = next;
        await this.host.invoke('update_interaction_regions', { snapshot: { displayId: this.scope.displayId,
          bindingGeneration: this.bindingGeneration, revision: ++this.revision, generatedAtMs, regions: [...next.values()].map(value => value.native) } });
      });
    } catch (error) { this.published.clear(); this.diagnostic('regions', error); await this.cancel('surface-invalid'); }
    finally { this.regionBusy = false; }
  }
  receiveGrab(payload: unknown): void {
    if (this.disposed || this.toolChanged()) return;
    let grab: NativeGrab;
    try { grab = parseGrab(payload); } catch (error) { this.diagnostic('grab-payload', error); return; }
    if (grab.bindingGeneration !== this.bindingGeneration) { this.diagnostic('grab-binding', 'stale native display binding'); return; }
    const active = this.active;
    if (grab.phase === 'start') {
      if (active || this.hidden || this.quitPending || this.displaySuspended || grab.sessionId <= this.maxSession) return;
      const target = this.registry.resolve({ handle: grab.entityId, displayId: grab.displayId, generation: this.scope.generation });
      const region = this.published.get(grab.entityId);
      if (!target || !region || region.native.kind !== grab.kind || !inside(grab.localDip, region.native)) return;
      if (target.kind !== 'ui' && (this.nativePaused || requiresHealthySurface(target.kind) && !this.surfaceAvailable()
        || !acceptsTool(target.kind, region.toolId, this.options.equippedTool()))) return;
      this.maxSession = grab.sessionId;
      this.active = { grab, target, toolId: region.toolId, seen: new Set([JSON.stringify(grab)]) };
      this.emit({ type: 'grab', scope: { ...this.scope }, target, grab: structuredClone(grab), toolId: region.toolId }); return;
    }
    if (!active || grab.sessionId !== active.grab.sessionId || grab.entityId !== active.grab.entityId || grab.kind !== active.grab.kind) return;
    // A mismatched native event is never dispatched as domain input. Locally retire the gesture instead.
    if (grab.displayId !== this.scope.displayId) { void this.cancel('display-change'); return; }
    if (grab.timestampMs < active.grab.timestampMs) return;
    const signature = JSON.stringify(grab); if (active.seen.has(signature)) return;
    if (grab.phase !== 'cancel' && this.surface && (grab.localDip.x < 0 || grab.localDip.y < 0 || grab.localDip.x >= this.surface.width || grab.localDip.y >= this.surface.height)) {
      void this.cancel('display-change'); return;
    }
    // Equal millisecond timestamps are valid (Rust has no event sequence); suppress identical deliveries only.
    if (grab.timestampMs > active.grab.timestampMs) active.seen.clear();
    active.seen.add(signature); active.grab = grab;
    if (grab.phase === 'end' || grab.phase === 'cancel') this.active = undefined;
    this.emit({ type: 'grab', scope: { ...this.scope }, target: { ...active.target }, grab: structuredClone(grab), toolId: active.toolId,
      ...(grab.phase === 'cancel' ? { cancelReason: 'native-cancel' as const } : {}) });
  }
  private receivePause(payload: unknown): void {
    if (typeof payload !== 'boolean') { this.diagnostic('pause-payload', 'expected boolean'); return; }
    this.nativePaused = payload; if (payload) void this.cancel('paused');
    this.emit({ type: 'pause', source: 'native', paused: payload });
  }
  private receiveCommand(payload: unknown): void {
    if (payload === 'save') this.emit({ type: 'save-requested', scope: { ...this.scope } });
    if (payload !== 'quit' || this.quitPending) return;
    this.quitPending = true; void this.cancel('quit'); const epoch = this.epoch;
    let finishing: Promise<void> | undefined;
    this.emit({ type: 'quit-requested', scope: { ...this.scope }, finishExit: () => {
      check(this.current(epoch), 'stale exit callback');
      finishing ??= this.enqueue(async () => { check(this.current(epoch), 'stale exit callback'); await this.host.invoke('finish_game_exit'); })
        .catch(error => { finishing = undefined; throw error; });
      return finishing;
    } });
  }
  private unhealthy(message: string): void {
    if (this.surfaceHealthy) void this.cancel('surface-invalid');
    this.surfaceHealthy = false; this.emit({ type: 'pause', source: 'surface', paused: true }); this.diagnostic('surface-invalid', message);
  }
  async pollSurface(): Promise<void> {
    if (this.disposed || this.hidden || this.surfaceBusy) return;
    this.surfaceBusy = true; const epoch = this.epoch, surfaceEpoch = this.surfaceEpoch, displayId = this.scope.displayId;
    try {
      const payload = await this.host.invoke('desktop_surface_v2', { displayId, bindingGeneration: this.bindingGeneration }); if (!this.current(epoch) || surfaceEpoch !== this.surfaceEpoch) return;
      if (payload === null) { this.unhealthy('surface unavailable'); return; }
      const surface = parseSurface(payload); check(surface.displayId === displayId, 'surface display mismatch');
      const previous = this.surface;
      if (previous && (surface.revision < previous.revision || surface.verifiedAtMs < previous.verifiedAtMs || surface.capturedAtMs < previous.capturedAtMs)) {
        this.unhealthy('out-of-order surface'); return;
      }
      const now = this.host.now(); uint(now);
      check(surface.verifiedAtMs <= now + 1000 && now - surface.verifiedAtMs <= 1000, 'stale or future surface');
      this.surface = surface;
      if (!surface.valid) this.unhealthy(surface.error ?? 'native surface invalid');
      else if (!this.surfaceHealthy) { this.surfaceHealthy = true; this.emit({ type: 'pause', source: 'surface', paused: false }); }
      if (!previous || JSON.stringify(previous) !== JSON.stringify(surface)) this.emit({ type: 'surface', scope: { ...this.scope }, surface: structuredClone(surface) });
    } catch (error) { if (this.current(epoch) && surfaceEpoch === this.surfaceEpoch) this.unhealthy(String(error)); }
    finally { this.surfaceBusy = false; }
  }
  async pollBin(): Promise<void> {
    if (this.disposed || this.hidden || this.binBusy) return;
    this.binBusy = true; const epoch = this.epoch;
    try {
      const geometry = parseBin(await this.host.invoke('bin_geometry')); if (!this.current(epoch)) return;
      const at = this.host.now(); uint(at); this.bin = { geometry, at }; this.emit({ type: 'bin-geometry', geometry: { ...geometry } });
    } catch (error) { if (this.current(epoch)) { this.bin = undefined; this.emit({ type: 'bin-geometry', geometry: null }); this.diagnostic('bin-geometry', error); } }
    finally { this.binBusy = false; }
  }
  /** Explicit mouth hit, in physical coordinates; the native whole-window flag is not a deposit verdict. */
  hitBin(screenPhysical: Point, mouthRadiusDip = 24): boolean {
    point(screenPhysical); real(mouthRadiusDip); check(mouthRadiusDip > 0, 'invalid mouth radius');
    const bin = this.bin, now = this.host.now(); uint(now);
    if (this.disposed || this.hidden || !bin || now < bin.at || now - bin.at > 500) return false;
    const g = bin.geometry;
    return screenPhysical.x >= g.x && screenPhysical.x <= g.x + g.width && screenPhysical.y >= g.y && screenPhysical.y <= g.y + g.height
      && Math.hypot(screenPhysical.x - g.mouthX, screenPhysical.y - g.mouthY) <= mouthRadiusDip * g.scale;
  }
  private async heartbeat(): Promise<void> {
    if (this.disposed || this.heartbeatBusy) return; this.heartbeatBusy = true;
    try { await this.host.invoke('render_heartbeat'); } catch (error) { this.diagnostic('heartbeat', error); }
    finally { this.heartbeatBusy = false; }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return this.writes;
    const release = this.cancel('dispose'); this.disposed = true; this.epoch++; this.registry.invalidate();
    for (const unlisten of this.cleanup.splice(0)) { try { unlisten(); } catch { /* keep releasing remaining listeners */ } }
    this.bin = undefined; await release;
  }
}
