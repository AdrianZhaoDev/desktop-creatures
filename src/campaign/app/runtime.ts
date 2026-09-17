import { CampaignAgentDriver } from '../agent-runtime/driver';
import type { TongueOccluder } from '../agent-runtime/geometry';
import { createCampaignAgentSessionHook } from '../agent-runtime/session-hook';
import { CampaignApplication, type CampaignCommandResult, type RuntimePauseReason } from '../application/campaign-application';
import { audioEventsForReceipt, audioEventsForRoleUpdate, audioEventsForRunTransition } from '../audio/event-mapping';
import type { CampaignAudio } from '../audio/types';
import { FIXED_STEP, type RunState } from '../campaign-controller';
import type { CampaignSessionV4 } from '../campaign-session-v4';
import type { S07DomainAdapter } from '../integration/s07-domain-adapter';
import type { InteractionHandleScope } from '../integration/hit-handles';
import type { NativeCampaignBridge } from '../native/bridge';
import type { BinGeometry, NativeCampaignRuntimeEvent } from '../native/types';
import type { CampaignRenderer } from '../rendering/campaign-renderer';
import type { SurfaceSnapshotV2 } from '../surface';
import { renderCampaignLobby, type CampaignApplicationUiMount } from '../ui/campaign-lobby';
import { renderCampaignUi } from '../ui/campaign-ui';
import type { CampaignUiCommand } from '../ui/model';
import type { CampaignDisplayController } from './display-move';
import type { CampaignDisplayInfo, CampaignDisplayState } from '../native/types';
import type { HomeInteractionAction, HomeInteractionResult } from '../home-interaction';

export interface PresentationScheduler {
  now(): number;
  request(callback: (milliseconds: number) => void): number;
  cancel(handle: number): void;
}
export interface RuntimeOptions {
  session: CampaignSessionV4;
  application: CampaignApplication;
  scheduler: PresentationScheduler;
  surfaceNow(): number;
  viewport: { widthDip: number; heightDip: number; dpiScale: number };
  displayId: string;
  practice: boolean;
  /** Controlled native preview may use synthetic bottom-edge terrain if capture fails. */
  surfaceFallback?: boolean;
  renderer: Pick<CampaignRenderer, 'submit' | 'render' | 'resize' | 'setQuality' | 'dispose'> & Partial<Pick<CampaignRenderer, 'interactHome'>>;
  view: Pick<CampaignApplicationUiMount, 'update' | 'destroy'> & Partial<Pick<CampaignApplicationUiMount, 'isBusy'>>;
  audio: CampaignAudio;
  error(message: string): void;
  diagnostic(code: string, message: string): void;
  onGrab?: (event: Extract<NativeCampaignRuntimeEvent, { type: 'grab' }>) => void;
  onScopeChanging?: () => void;
  onDisplayPreparing?: () => Promise<void>;
  onBinGeometry?: (geometry: BinGeometry | null) => void;
  onAudioSettings?: () => void;
  readTongueOccluders?: () => readonly TongueOccluder[] | undefined;
  onStopped?: (stopped: boolean) => void;
  onPresentation?: (hasRun: boolean) => void;
}

/** Resize the borrowed S07 port in place; preserve its identity and normalized durable poses.
 * Native paths/supports belong to the old geometry and must be reacquired. No new authority. */
export function resizeCampaignAdapter(adapter: S07DomainAdapter, width: number, height: number): boolean {
  const old = adapter.viewport;
  if (old.widthDip === width && old.heightDip === height) return false;
  if (![width, height].every(n => Number.isFinite(n) && n >= 120)) throw new Error('Invalid campaign DIP viewport');
  for (const actor of adapter.actors) {
    actor.body.x *= width / old.widthDip; actor.body.y *= height / old.heightDip;
    actor.body.support = undefined; actor.body.grip = undefined;
    actor.body.dropThrough = undefined; actor.body.releasedGrip = undefined;
    adapter.coordinator.releaseActor(actor); adapter.ledger.releaseActorReservations(actor.id); actor.task = undefined;
  }
  for (const home of adapter.homes) Object.assign(home, { x: home.x * width / old.widthDip, y: home.y * height / old.heightDip });
  old.widthDip = width; old.heightDip = height;
  return true;
}

export function practiceSurface(width: number, height: number, displayId: string, now: number): SurfaceSnapshotV2 {
  return { schemaVersion: 2, displayId, revision: 1, capturedAtMs: now, verifiedAtMs: now,
    valid: true, width, height, floorY: height - 8, screenBounds: true,
    platforms: [{ id: 'practice:desk', version: 1, source: 'screenBoundary', confidence: 1,
      x1: width * 0.15, x2: width * 0.8, y: height * 0.65 }], grips: [] };
}

/** Owns scheduling and side effects. The only domain clock invocation is session.advance. */
export class CampaignProductionRuntime {
  readonly driver: CampaignAgentDriver;
  private bridge?: NativeCampaignBridge;
  private displayController?: CampaignDisplayController;
  private displayChanging = false;
  private admittedDisplayCommands = new Map<string, { original: string; command: CampaignUiCommand }>();
  private scopeValue: InteractionHandleScope;
  private surfaceValue: SurfaceSnapshotV2 | null = null;
  private nativeSurfaceHealthy = false;
  private frameHandle?: number;
  private lastFrame?: number;
  private lastUiAt = -Infinity;
  private submittedRevision = -1;
  private previousRun: RunState | null = null;
  private stopped = true;
  private disposed = false;
  private exiting = false;
  private exitAttempt?: Promise<boolean>;
  private exitCallback?: () => Promise<void>;
  private disposal?: Promise<void>;
  private pending = new Set<Promise<unknown>>();
  private cleanups: Array<() => void | Promise<void>> = [];
  private settingsKey = '';
  private uiSignature = '';
  private interacting = false;
  private changingScope = false;
  private pauses = new Map<RuntimePauseReason, boolean>();
  private pauseOperations = new Map<RuntimePauseReason, Promise<void>>();
  private readonly hook;

  constructor(readonly options: RuntimeOptions) {
    this.scopeValue = { runId: options.session.snapshot().campaign.activeRun?.runId ?? 'lobby', displayId: options.displayId, generation: 1 };
    this.driver = new CampaignAgentDriver({ onResult: result => {
      for (const d of result.diagnostics) options.diagnostic(d.code, [d.actorId, d.targetId].filter(Boolean).join(':'));
    } });
    const driverHook = createCampaignAgentSessionHook(this.driver);
    this.hook = (adapter: S07DomainAdapter, seconds: number) => {
      if (resizeCampaignAdapter(adapter, this.options.viewport.widthDip, this.options.viewport.heightDip)) this.driver.reset();
      driverHook(adapter, seconds);
    };
    this.refresh(true);
  }
  get acceptingInput(): boolean { return !this.disposed && !this.exiting && !this.displayChanging; }
  get isStopped(): boolean { return this.stopped; }
  scope(): InteractionHandleScope { return { ...this.scopeValue }; }
  surface(): SurfaceSnapshotV2 | null { return this.surfaceValue && structuredClone(this.surfaceValue); }
  private usingPracticeSurface(): boolean {
    const surface = this.surfaceValue;
    const now = this.options.surfaceNow();
    if (this.nativeSurfaceHealthy && (!surface || !surface.valid
      // Reserve one maximum catch-up batch (six fixed steps) so the driver
      // cannot cross its 1-second expiry partway through this frame.
      || now < surface.verifiedAtMs || now - surface.verifiedAtMs >= 900)) this.nativeSurfaceHealthy = false;
    return this.options.practice || this.options.surfaceFallback === true && !this.nativeSurfaceHealthy;
  }
  private installPracticeSurface(): void {
    this.surfaceValue = practiceSurface(this.options.viewport.widthDip, this.options.viewport.heightDip,
      this.scopeValue.displayId, this.options.surfaceNow());
    if (!this.options.practice) {
      // The native fallback is the actual screen bottom, not the browser demo's
      // invisible mid-screen shelf. Canonical homes and floor work use y = 1.
      this.surfaceValue.floorY = this.options.viewport.heightDip;
      this.surfaceValue.platforms = [];
    }
  }
  setInteracting(value: boolean): void { this.interacting = value; }
  own(cleanup: () => void | Promise<void>): void {
    if (this.disposed) { void Promise.resolve(cleanup()).catch(() => {}); } else this.cleanups.push(cleanup);
  }
  attachBridge(bridge: NativeCampaignBridge): void { this.bridge = bridge; }
  attachDisplayController(controller: CampaignDisplayController): void { this.displayController = controller; }
  async prepareDisplayMove(): Promise<void> {
    if (this.disposed || this.exiting) throw new Error('Runtime unavailable');
    this.displayChanging = true; this.pauses.set('display-change', true); this.stop();
    this.options.onScopeChanging?.(); this.interacting = false;
    await this.bridge?.suspendDisplay();
    await this.options.onDisplayPreparing?.();
    await Promise.allSettled([...this.pending]);
    const application = this.options.application;
    if (application.uiSnapshot().equippedTool) await application.dispatch(application.createCommand({ type: 'tool.equip', tool: null }));
    if (this.options.session.snapshot().campaign.activeRun) {
      const paused = await application.setRuntimePauseReason('display-change', true);
      if (!paused.ok) throw new Error('Unable to pause for display move');
    }
    await this.options.session.flush('display-change');
    if (this.options.session.dirty) throw new Error('Display move checkpoint incomplete');
  }
  async bindDisplay(state: CampaignDisplayState, display: CampaignDisplayInfo): Promise<void> {
    if (this.disposed || this.exiting || !this.displayChanging) throw new Error('Display move cancelled');
    const widthDip = Math.max(120, display.size.width / display.scaleFactor);
    const heightDip = Math.max(120, display.size.height / display.scaleFactor);
    this.options.session.remapViewport(widthDip, heightDip);
    Object.assign(this.options.viewport, { widthDip, heightDip, dpiScale: display.scaleFactor });
    this.options.renderer.resize(widthDip, heightDip, display.scaleFactor);
    this.scopeValue = { ...this.scopeValue, displayId: display.id, generation: this.scopeValue.generation + 1 };
    this.surfaceValue = null; this.nativeSurfaceHealthy = false; this.driver.reset(); this.options.onBinGeometry?.(null);
    await this.bridge?.setDisplayBinding(this.scopeValue, state.bindingGeneration);
  }
  async waitForDisplaySurface(display: CampaignDisplayInfo): Promise<void> {
    if (!this.bridge) throw new Error('Native bridge unavailable');
    await this.bridge.waitForDisplaySurface(Math.max(120, display.size.width / display.scaleFactor), Math.max(120, display.size.height / display.scaleFactor));
  }
  async releaseDisplayMove(): Promise<void> {
    if (this.disposed || this.exiting) throw new Error('Display move cancelled');
    if (this.options.session.snapshot().campaign.activeRun) {
      const result = await this.options.application.setRuntimePauseReason('display-change', false);
      if (!result.ok) throw new Error('Unable to finish display move');
    }
    this.pauses.set('display-change', false); this.displayChanging = false;
    this.bridge?.resumeDisplay(); this.refresh(true); this.start();
  }
  start(): void {
    if (this.disposed || this.exiting || this.displayChanging || !this.stopped || this.pauses.get('hidden')) return;
    this.stopped = false; this.lastFrame = undefined; this.options.onStopped?.(false); this.schedule();
  }
  stop(): void {
    const wasStopped = this.stopped;
    this.stopped = true; this.lastFrame = undefined;
    if (this.frameHandle !== undefined) this.options.scheduler.cancel(this.frameHandle);
    this.frameHandle = undefined; this.options.audio.stop(); if (!wasStopped) this.options.onStopped?.(true);
  }
  private schedule(): void { this.frameHandle = this.options.scheduler.request(this.frame); }
  private readonly frame = (now: number): void => {
    this.frameHandle = undefined;
    if (this.disposed || this.stopped) return;
    try {
      const elapsed = this.lastFrame === undefined ? 0 : Math.max(0, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      const { session, application } = this.options;
      const practice = this.usingPracticeSurface();
      if (practice) this.installPracticeSurface();
      this.driver.setInput({ surface: this.surfaceValue, surfaceNowMs: this.options.surfaceNow(),
        strategyByActor: application.uiSnapshot().strategyByActor,
        tongueOccluders: this.options.readTongueOccluders ? this.options.readTongueOccluders() : practice ? [] : undefined });
      const advanced = session.advance(elapsed, this.hook);
      this.refresh(now - this.lastUiAt >= 100);
      this.options.renderer.render(advanced.remainder / FIXED_STEP, now / 1000);
      const due = session.checkpointIfDue();
      if (due) this.observe(due, '自动保存失败，进度仍未保存。请重试保存。');
    } catch (error) { this.stop(); this.options.error(`运行已暂停：${String(error)}`); }
    if (!this.stopped && !this.disposed) this.schedule();
  };
  private observe<T>(operation: Promise<T>, errorMessage?: string): Promise<T> {
    if (this.pending.has(operation)) return operation;
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), error => {
      this.pending.delete(operation);
      if (!this.disposed && errorMessage) this.options.error(`${errorMessage} ${String(error)}`);
    });
    return operation;
  }
  async dispatch(command: CampaignUiCommand): Promise<CampaignCommandResult | { ok: false; reason: string }> {
    if (!this.acceptingInput) return { ok: false, reason: 'runtime-stopped' };
    const admitted = this.admittedDisplayCommands.get(command.commandId);
    if (admitted?.original === JSON.stringify(command)) command = admitted.command;
    const activeRun = this.options.session.snapshot().campaign.activeRun;
    const createsRun = (command.type === 'campaign.start' && !activeRun)
      || (command.type === 'result.retry' && !!activeRun && ['victory', 'defeat', 'abandoned'].includes(activeRun.phase));
    if (createsRun && this.displayController && !admitted) {
      const saved = this.options.application.settingsSnapshot().gameplay.displayId;
      const preferred = saved === 'primary' ? this.displayController.getState().native?.displays.find(display => display.primary)?.id ?? saved : saved;
      if (preferred && preferred !== this.scopeValue.displayId) {
        if (command.readRevision !== this.options.application.revision() || this.pending.size) return { ok: false, reason: 'stale-revision' };
        const original = JSON.stringify(command);
        if (!await this.displayController.move(preferred)) return { ok: false, reason: 'display-move-failed' };
        // Input is locked for the whole transaction; only the admitted move may advance
        // this revision. Retain the original command ID for application replay safety.
        command = { ...command, readRevision: this.options.application.revision() };
        this.admittedDisplayCommands.set(command.commandId, { original, command });
        if (this.admittedDisplayCommands.size > 512) this.admittedDisplayCommands.delete(this.admittedDisplayCommands.keys().next().value!);
      }
    }
    const operation = this.options.application.dispatch(command);
    this.observe(operation);
    const result = await operation;
    if (this.disposed) return result;
    const purchase = ['upgrade.purchase', 'device.place', 'research.purchase', 'house.repair'].includes(command.type);
    for (const event of audioEventsForReceipt(purchase ? 'purchase' : 'ui-confirm', result, result.replayed)) this.options.audio.emit(event);
    if (result.ok) {
      if (result.effects.some(e => e.type === 'run-upgrade-purchased')) this.tutorial({ type: 'upgrade-purchased' });
      if (result.effects.some(e => e.type === 'campaign-started') && this.options.application.tutorialSnapshot().status === 'not-started') this.tutorial({ type: 'start' });
    }
    this.refresh(true);
    return result;
  }
  async interactHome(houseId: string, action: HomeInteractionAction): Promise<HomeInteractionResult> {
    const chinese = this.options.application.settingsSnapshot().language === 'zh-CN';
    const fail = (zh: string, en: string): HomeInteractionResult => ({ ok: false, message: chinese ? zh : en });
    const run = this.options.session.snapshot().campaign.activeRun;
    const house = run?.houses.find(home => home.id === houseId);
    if (!this.acceptingInput || !run || run.phase !== 'running' || !house || house.hp <= 0
      || houseId === 'home.frog' && !run.frogUnlocked) return fail('当前无法与这座房屋互动。', 'This home is unavailable.');
    if (action === 'call') {
      const result = await this.observe(this.options.application.callResidentOut(houseId));
      if (!this.acceptingInput || this.options.session.snapshot().campaign.activeRun?.runId !== run.runId)
        return fail('场景已改变，请重新操作。', 'The scene changed. Please try again.');
      this.refresh(true);
      if (!result.ok) {
        if (result.reason === 'domain:too-tired') return fail('体力太低，需要先休息一会儿。', 'Too tired. A little more rest is needed.');
        if (result.reason === 'domain:home-entry-pending') return fail('正在回家卸下东西，请稍后再叫。', 'Returning home to unload. Please try shortly.');
        return fail('暂时无法出来工作，请稍后重试。', 'Cannot come out yet. Please try again shortly.');
      }
    }
    const animated = this.options.renderer.interactHome?.(houseId, action);
    if (!animated && action !== 'call') return fail('房屋还在加载，请稍后重试。', 'The home is loading. Please try again shortly.');
    return { ok: true, message: chinese ? (action === 'call' ? '已呼叫居民出来工作。' : action === 'door' ? '已开关房门。' : '屋内道具动起来了。')
      : (action === 'call' ? 'The resident has been called out.' : action === 'door' ? 'Door toggled.' : 'Room items are moving.') };
  }
  tutorial(event: Parameters<CampaignApplication['dispatchTutorialEvent']>[0]): void {
    if (!this.acceptingInput) return;
    this.observe(this.options.application.dispatchTutorialEvent(event).then(() => { if (!this.disposed) this.refresh(true); }));
  }
  /** A true browser event reaches unlock synchronously, before dispatch/await. Native synthetic clicks do not unlock. */
  userGesture(event: Pick<Event, 'isTrusted' | 'type'>): void {
    if (!this.acceptingInput || !event.isTrusted || !['pointerdown', 'keydown', 'click'].includes(event.type)) return;
    void this.options.audio.unlockFromUserGesture();
  }
  setHidden(hidden: boolean): void {
    this.options.audio.setDocumentHidden(hidden); this.pause('hidden', hidden);
    if (hidden) { this.stop(); this.checkpoint('hidden'); }
    else this.start();
  }
  pause(reason: RuntimePauseReason, paused: boolean): void {
    this.pauses.set(reason, paused);
    if (this.disposed || this.exiting || this.pauseOperations.has(reason)) return;
    // Install the per-reason operation before it starts. Calls arriving while an
    // application/tutorial write is in flight only replace the desired value; the
    // loop then reconciles the committed run with the newest value in queue order.
    let failed = false;
    const operation = Promise.resolve().then(async () => {
      while (!this.disposed && !this.exiting) {
        const run = this.options.session.snapshot().campaign.activeRun;
        const desired = this.pauses.get(reason) === true;
        if (!run || run.pauseReasons.includes(reason) === desired) return;
        const result = await this.options.application.setRuntimePauseReason(reason, () => this.pauses.get(reason) === true);
        if (!result.ok) { failed = true; return; }
        if (!this.disposed) this.refresh(true);
      }
    });
    this.pauseOperations.set(reason, operation);
    const cleanup = () => { if (this.pauseOperations.get(reason) === operation) this.pauseOperations.delete(reason); };
    void operation.then(() => {
      cleanup();
      const run = this.options.session.snapshot().campaign.activeRun;
      const desired = this.pauses.get(reason) === true;
      if (!failed && !this.disposed && !this.exiting && run && run.pauseReasons.includes(reason) !== desired) this.pause(reason, desired);
    }, cleanup);
    this.observe(operation);
  }
  resize(widthDip: number, heightDip: number, dpiScale: number): void {
    if (this.disposed || this.displayChanging || ![widthDip, heightDip, dpiScale].every(n => Number.isFinite(n) && n > 0)) return;
    const geometryChanged = this.options.viewport.widthDip !== Math.max(120, widthDip) || this.options.viewport.heightDip !== Math.max(120, heightDip);
    Object.assign(this.options.viewport, { widthDip: Math.max(120, widthDip), heightDip: Math.max(120, heightDip), dpiScale });
    if (geometryChanged) { this.options.session.remapViewport(this.options.viewport.widthDip, this.options.viewport.heightDip); this.driver.reset(); }
    this.options.renderer.resize(widthDip, heightDip, dpiScale);
  }
  setDisplay(displayId: string): void {
    if (!this.acceptingInput || displayId === this.scopeValue.displayId) return;
    this.changeScope(this.scopeValue.runId, displayId);
  }
  private changeScope(runId: string, displayId: string): void {
    if (this.changingScope) return;
    this.changingScope = true;
    // Retire the gesture while its old scope is still valid. Bridge.setScope also emits
    // an old-scope cancel, which must not keep the DOM interaction lock alive.
    try {
      this.options.onScopeChanging?.(); this.interacting = false;
      this.scopeValue = { runId, displayId, generation: this.scopeValue.generation + 1 };
      this.surfaceValue = null; this.nativeSurfaceHealthy = false; this.driver.reset();
      if (this.bridge) this.observe(this.bridge.setScope(this.scopeValue), '切换输入区域失败。');
    } finally { this.changingScope = false; }
  }
  handleNative(event: NativeCampaignRuntimeEvent): void {
    if (this.disposed) return;
    if ('scope' in event && (event.scope.runId !== this.scopeValue.runId || event.scope.displayId !== this.scopeValue.displayId || event.scope.generation !== this.scopeValue.generation)) {
      this.options.diagnostic('stale-scope', event.type); return;
    }
    if (event.type === 'quit-requested') { void this.quit(event.finishExit); return; }
    // Native bridge deliberately suppresses new grabs after quit. The tray Save command
    // remains an out-of-band, real user retry even while the WebView is click-through.
    if (event.type === 'save-requested' && this.exiting && this.exitCallback) { void this.quit(); return; }
    if ((this.disposed || this.exiting) || (this.displayChanging && event.type === 'grab')) return;
    if (event.type === 'grab') {
      if (event.grab.phase === 'start') this.interacting = true;
      try { this.options.onGrab?.(event); }
      finally { if (event.grab.phase === 'end' || event.grab.phase === 'cancel') this.interacting = false; }
    }
    else if (event.type === 'surface') {
      const healthy = event.surface.valid && event.surface.width === this.options.viewport.widthDip && event.surface.height === this.options.viewport.heightDip;
      this.nativeSurfaceHealthy = healthy;
      if (!healthy && this.options.surfaceFallback) {
        this.installPracticeSurface();
        this.pause('terrain-invalid', false); this.pause('surface', false); this.pause('desktop-detection', false);
        this.start(); return;
      }
      this.surfaceValue = event.surface;
      this.pause('terrain-invalid', !healthy);
      this.pause('surface', !healthy);
    } else if (event.type === 'pause') {
      const reason = event.source === 'surface' ? 'desktop-detection' : event.source === 'visibility' ? 'hidden' : 'runtime:native';
      if (event.source === 'surface' && this.options.surfaceFallback) {
        // A resume notification does not contain terrain. Only a surface event
        // can certify fresh native geometry; keep the fallback until it arrives.
        if (event.paused) { this.nativeSurfaceHealthy = false; this.installPracticeSurface(); }
        this.pause('desktop-detection', false); this.pause('terrain-invalid', false); this.pause('surface', false);
        this.start(); return;
      }
      if (event.source === 'visibility') this.setHidden(event.paused);
      else {
        // A pending placement can hold the application's async queue. Stop presentation
        // scheduling and cancel that request immediately, then commit the pause normally.
        if (event.paused) this.stop();
        this.pause(reason, event.paused);
        if (!event.paused) this.start();
      }
      if (event.source === 'native') this.options.audio.setSafetyHidden(event.paused);
    } else if (event.type === 'bin-geometry') this.options.onBinGeometry?.(event.geometry);
    else if (event.type === 'save-requested') this.checkpoint('native-save');
    else if (event.type === 'diagnostic') this.options.diagnostic(event.code, event.message);
  }
  refresh(updateUi = true): void {
    if (this.disposed || this.changingScope) return;
    const { application, session, audio, renderer } = this.options;
    const run = session.snapshot().campaign.activeRun;
    const old = this.previousRun;
    if ((run?.runId ?? 'lobby') !== this.scopeValue.runId) {
      this.changeScope(run?.runId ?? 'lobby', this.scopeValue.displayId);
      for (const [reason, paused] of this.pauses) if (paused) this.pause(reason, true);
    }
    if (old && run && old.runId === run.runId && session.revision !== this.submittedRevision) {
      for (const event of audioEventsForRunTransition(old, run)) audio.emit(event);
      // S07 committed receipt edges use the existing event mapper, never attempted actions.
      let cleaned = 0, captured = 0;
      for (const [id, receipt] of Object.entries(run.inventory.commands)) if (!(id in old.inventory.commands) && receipt.ok) {
        if (id.startsWith('["campaign-agent",')) {
          const parts: unknown = JSON.parse(id);
          if (Array.isArray(parts)) { if (parts[3] === 'capture') captured++; else if (parts[3] === 'clean') cleaned++; }
        } else if (id.startsWith('swat:input:')) for (const event of audioEventsForReceipt('swatter-hit', receipt)) audio.emit(event);
      }
      for (const event of audioEventsForRoleUpdate({ cleanedTotal: 0, capturedTotal: 0 },
        { cleanedTotal: cleaned, capturedTotal: captured, ...(captured ? { lastTongue: { sequence: run.tick } } : {}) })) audio.emit(event);
      if (cleaned) this.tutorial({ type: 'trash-cleaned' });
      if (captured) this.tutorial({ type: 'frog-ability-observed' });
      if (!old.frogUnlocked && run.frogUnlocked) this.tutorial({ type: 'frog-unlocked' });
      if (Object.values(run.inventory.objects).some(item => item.kind === 'corpse' && old.inventory.objects[item.id]?.hp > 0)) this.tutorial({ type: 'roach-killed' });
      if (old.phase !== run.phase && run.phase === 'retreat') this.tutorial({ type: 'shelter-observed' });
      if (run.phase !== old.phase) this.checkpoint('phase');
    } else if (old?.runId !== run?.runId) this.checkpoint('run-transition');
    audio.setPaused(!!run?.pauseReasons.length);
    const settings = application.settingsSnapshot(), key = JSON.stringify(settings);
    if (key !== this.settingsKey) { this.settingsKey = key; audio.setSettings(settings.audio); this.options.onAudioSettings?.(); renderer.setQuality(settings.visual.quality); }
    if (run && session.revision !== this.submittedRevision) renderer.submit(run);
    this.options.onPresentation?.(!!run);
    this.submittedRevision = session.revision; this.previousRun = run;
    if (updateUi && !this.interacting && !this.options.view.isBusy?.()) {
      const snapshot = application.applicationSnapshot();
      const signature = snapshot.mode === 'run' ? renderCampaignUi(snapshot.ui) : renderCampaignLobby(snapshot);
      if (signature !== this.uiSignature) { this.uiSignature = signature; this.options.view.update(snapshot); }
      this.lastUiAt = this.options.scheduler.now();
    }
  }
  checkpoint(reason: string): void {
    if (this.disposed || this.exiting) return;
    this.observe(this.options.session.checkpoint(reason), '保存失败，进度仍未保存。');
  }
  /** Page lifecycle cannot await shutdown. Deliberately makes no completion claim. */
  pageExit(): void { this.stop(); this.exiting = true; this.observe(this.drainAndFlush('page-exit'), '离开页面时保存失败。'); }
  private async drainAndFlush(reason: string): Promise<void> {
    await Promise.allSettled([...this.pending]);
    await this.options.session.flush(reason);
    if (this.options.session.dirty) throw new Error('Campaign changed during final flush');
  }
  quit(finishExit?: () => Promise<void>): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (finishExit) this.exitCallback = finishExit;
    if (this.exitAttempt) return this.exitAttempt;
    if (!this.exitCallback) return Promise.resolve(false);
    this.exiting = true; this.stop();
    const attempt = (async () => {
      try {
        await this.bridge?.cancel('quit');
        await this.drainAndFlush('quit');
        if (this.disposed) return false;
        await this.exitCallback!();
        await this.dispose(); return true;
      } catch (error) {
        if (!this.disposed) this.options.error(`保存未完成，尚未退出。请点重试，或使用托盘“保存”重试退出。 ${String(error)}`);
        return false;
      }
    })();
    this.exitAttempt = attempt;
    void attempt.finally(() => { this.exitAttempt = undefined; });
    return attempt;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true; this.stop();
    this.admittedDisplayCommands.clear();
    const released: Promise<void>[] = [];
    for (const cleanup of this.cleanups.splice(0)) { try { released.push(Promise.resolve(cleanup())); } catch { /* release all */ } }
    this.options.view.destroy(); this.options.audio.dispose(); this.options.renderer.dispose(); this.driver.reset();
    this.disposal = (async () => { await this.bridge?.dispose(); await Promise.allSettled([...released, ...this.pending]); })();
    return this.disposal;
  }
}
