import { createGameSaveV4, migrateGameSaveV4Ecology, migrateLegacySave, settleCampaignInSave, validateGameSaveV4, type GameSaveV4 } from './campaign-save-v4';
import { FIXED_STEP, isPaused, isTerminal, type ClockAdvance } from './campaign-controller';
import { S07DomainAdapter, validateS07HomeProgress, type CampaignViewport, type S07HomeProgress } from './integration/s07-domain-adapter';
import { cancelSwatter, hasKey } from './tool-system';
import { compactCampaignHistory } from './campaign-history';

/** Only durable home routine progress accompanies V4; never native handles, paths or reservations. */
export interface CampaignSessionDocument {
  sessionVersion: 1;
  campaign: GameSaveV4;
  s07Homes: S07HomeProgress | null;
}
export interface CampaignStoragePort {
  read(profile: string): Promise<string | null>;
  writeAtomic(profile: string, json: string): Promise<void>;
  /** Preserve bytes verbatim, be idempotent, and never replace a different legacy backup. */
  preserveLegacy(profile: string, raw: string): Promise<void>;
  /** Create-once backup of the exact pre-cycle V4 main before an in-place schema upgrade. */
  preserveCycleV1?(profile: string, raw: string): Promise<void>;
}
export type CampaignRustInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export const CAMPAIGN_STORAGE_COMMANDS = Object.freeze({
  read: 'read_campaign_session', writeAtomic: 'write_campaign_session_atomic', preserveLegacy: 'preserve_campaign_legacy',
  preserveCycleV1: 'preserve_campaign_cycle_v1',
});

/** Native implementations must use a profile-separated path and atomic main/temp/backup write.
 * Names are explicit because the existing game-save.json commands belong to the legacy world.
 */
export function createRustCampaignStorage(invoke: CampaignRustInvoke,
  commands: { read: string; writeAtomic: string; preserveLegacy: string; preserveCycleV1: string } = CAMPAIGN_STORAGE_COMMANDS): CampaignStoragePort {
  if (Object.values(commands).some(name => !name || ['load_game_state', 'save_game_state', 'load_game_backup'].includes(name))
    || new Set(Object.values(commands)).size !== 4) throw new Error('Dedicated campaign storage commands required');
  const profileValid = (profile: string) => { createGameSaveV4(profile); };
  return {
    read: profile => { profileValid(profile); return invoke<string | null>(commands.read, { profile }); },
    writeAtomic: (profile, json) => { profileValid(profile); return invoke<void>(commands.writeAtomic, { profile, json }); },
    preserveLegacy: (profile, raw) => { profileValid(profile); return invoke<void>(commands.preserveLegacy, { profile, raw }); },
    preserveCycleV1: (profile, raw) => { profileValid(profile); return invoke<void>(commands.preserveCycleV1, { profile, raw }); },
  };
}

export function validateCampaignSessionDocument(value: unknown, profile?: string): CampaignSessionDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid campaign session');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || !['sessionVersion', 'campaign', 's07Homes'].every(key => hasKey(record, key))
    || record.sessionVersion !== 1) throw new Error('Unsupported campaign session; preserve original file');
  const campaign = validateGameSaveV4(record.campaign, profile);
  return { sessionVersion: 1, campaign, s07Homes: validateS07HomeProgress(record.s07Homes, campaign.activeRun) };
}

export interface CampaignCheckpoint {
  /** Borrowed live document; do not retain it or attach externally mutable values. */
  save: GameSaveV4;
  /** Borrowed live adapter, valid only inside the synchronous callback. Do not retain it. */
  adapter: S07DomainAdapter | null;
}

/** Trusted driver advances navigation/physics/stamina/homes, never the campaign clock itself.
 * It must maintain domain invariants; full durable validation also runs on commands/checkpoints.
 */
export type CampaignFixedStepHook = (adapter: S07DomainAdapter, seconds: number) => void;
export interface CampaignLiveSessionOptions {
  now?: () => number;
  checkpointIntervalMs?: number;
  beforeDomainStep?: CampaignFixedStepHook;
}

/** Sole live document/run owner. All commands are synchronous transactions on this adapter;
 * rollback copies and immutable queued checkpoint strings are never simulation authorities.
 * Disk I/O is serialized separately and cannot block or replace newer live state.
 */
export class CampaignSessionV4 {
  private live: CampaignSessionDocument;
  private adapter: S07DomainAdapter | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private mutating = false;
  private liveRevision = 0;
  private isDirty = false;
  private dirtySince: number | null = null;
  private lastCheckpointAt = -Infinity;
  private remainder = 0;
  private readonly now: () => number;
  private readonly checkpointIntervalMs: number;
  private readonly viewport: CampaignViewport;
  private dueWrite: Promise<CampaignSessionDocument> | null = null;

  constructor(initial: CampaignSessionDocument, private readonly storage: CampaignStoragePort,
    viewport: CampaignViewport, private readonly options: CampaignLiveSessionOptions = {}) {
    this.live = validateCampaignSessionDocument(initial);
    if (![viewport.widthDip, viewport.heightDip].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid campaign viewport');
    this.viewport = { ...viewport };
    this.now = options.now ?? (() => performance.now());
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? 7500;
    if (!Number.isFinite(this.checkpointIntervalMs) || this.checkpointIntervalMs < 5000 || this.checkpointIntervalMs > 10000) throw new Error('Checkpoint interval must be 5–10 seconds');
    const run = this.live.campaign.activeRun;
    if (run) {
      // User pause survives; transient windows, terrain, native gesture/session and UI do not.
      run.pauseReasons = run.pauseReasons.filter(reason => reason === 'user');
      cancelSwatter(run.swatter);
    }
    this.rebuildAdapter();
  }

  get revision(): number { return this.liveRevision; }
  get dirty(): boolean { return this.isDirty; }

  snapshot(): CampaignSessionDocument {
    this.assertOutsideMutation();
    return structuredClone(this.live);
  }

  /** No await, disk I/O, or nested session calls in a callback. Use adapter for S07 pose/home
   * changes and save for domain/meta/inventory commands. Returned values are detached copies.
   * Exceptions restore durable state and rebuild safe transient coordination from that state.
   */
  liveMutate<T>(mutate: (context: CampaignCheckpoint) => T): T {
    return this.transaction(mutate);
  }
  mutate<T>(mutate: (context: CampaignCheckpoint) => T): T { return this.liveMutate(mutate); }
  command<T>(mutate: (context: CampaignCheckpoint) => T): T { return this.liveMutate(mutate); }

  /** Explicit physical-display boundary, including equal-size/DPI-only migrations.
   * Preserve this Session and adapter, normalized durable positions and receipts. All
   * paths, surface supports and reservations must be reacquired on the new surface.
   * Also update the hydration viewport so rollback/new runs cannot restore old geometry. */
  remapViewport(widthDip: number, heightDip: number): void {
    if (![widthDip, heightDip].every(value => Number.isFinite(value) && value >= 120)) {
      throw new Error('Invalid campaign DIP viewport');
    }
    this.transaction(({ adapter }) => {
      const scaleX = widthDip / this.viewport.widthDip, scaleY = heightDip / this.viewport.heightDip;
      if (adapter) {
        for (const actor of adapter.actors) {
          actor.body.x *= scaleX; actor.body.y *= scaleY;
          actor.body.vx *= scaleX; actor.body.vy *= scaleY;
          actor.body.support = undefined; actor.body.grip = undefined;
          actor.body.dropThrough = undefined; actor.body.releasedGrip = undefined;
          adapter.coordinator.releaseActor(actor); adapter.ledger.releaseActorReservations(actor.id);
          actor.task = undefined;
          if (actor.activity === 'travelling' || actor.activity === 'working') actor.activity = 'idle';
        }
        for (const home of adapter.homes) Object.assign(home, { x: home.x * scaleX, y: home.y * scaleY });
      }
      Object.assign(this.viewport, { widthDip, heightDip });
      this.remainder = 0;
    });
  }

  /** Compatibility: publishes the synchronous live mutation immediately, then persists its
   * captured revision. A storage failure rejects but keeps the live change dirty for retry.
   * Normal UI commands should use liveMutate; never call update on the 60Hz path.
   */
  async update(mutate: (checkpoint: CampaignCheckpoint) => void): Promise<CampaignSessionDocument> {
    this.liveMutate(mutate);
    return this.checkpoint('update');
  }

  /** One clock owned here. Default adapter.advance already steps the campaign. With a driver,
   * each bounded fixed step invokes the driver and exactly one adapter.step instead.
   */
  advance(elapsedSeconds: number, beforeDomainStep = this.options.beforeDomainStep): ClockAdvance {
    this.assertOutsideMutation();
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new Error('Invalid campaign clock');
    const run = this.live.campaign.activeRun;
    if (!run || isPaused(run) || isTerminal(run) || run.phase === 'preparation') {
      this.remainder = 0;
      return { remainder: 0, droppedSeconds: 0, steps: 0, effects: [] };
    }
    // Sub-step frames only affect this transient clock, not the durable revision.
    if (elapsedSeconds + this.remainder + 1e-12 < FIXED_STEP) {
      this.remainder += elapsedSeconds;
      return { remainder: this.remainder, droppedSeconds: 0, steps: 0, effects: [] };
    }
    const advanced = this.transaction(({ adapter }) => {
      const initialTick = run.tick;
      let result: ClockAdvance;
      if (!beforeDomainStep) result = adapter!.advance(elapsedSeconds, this.remainder);
      else {
        const accumulated = elapsedSeconds + this.remainder;
        const steps = Math.min(6, Math.floor((accumulated + 1e-12) / FIXED_STEP));
        const leftover = Math.max(0, accumulated - steps * FIXED_STEP);
        const kept = leftover % FIXED_STEP;
        result = { remainder: kept, droppedSeconds: leftover - kept, steps: 0, effects: [] };
        for (let i = 0; i < steps; i++) {
          if (isPaused(run) || isTerminal(run) || run.phase === 'preparation') break;
          const tick = run.tick;
          this.requireSynchronous(beforeDomainStep(adapter!, FIXED_STEP));
          if (run.tick !== tick || this.live.campaign.activeRun !== run) throw new Error('Fixed-step driver must not advance or replace the campaign');
          result.effects.push(...adapter!.step());
          result.steps++;
        }
      }
      result.steps = run.tick - initialTick;
      this.remainder = result.remainder;
      return result;
    }, true);
    return { ...advanced, remainder: this.remainder };
  }

  /** Explicit phase/settlement/quit/manual checkpoint; captures revision N now, not when the
   * write queue reaches it. Normalize only the detached save, keeping live gestures/tasks.
   */
  checkpoint(_reason = 'manual'): Promise<CampaignSessionDocument> {
    this.assertOutsideMutation();
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error('Invalid checkpoint clock');
    const document = this.durableSnapshot();
    const revision = this.liveRevision;
    const json = JSON.stringify(document); // immutable even while simulation continues
    this.lastCheckpointAt = now;
    const operation = this.writeTail.then(async () => {
      await this.storage.writeAtomic(document.campaign.profile, json);
      if (this.liveRevision === revision) { this.isDirty = false; this.dirtySince = null; }
      return document;
    });
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  /** Call after stopping the caller's frame loop for a final quit flush. It includes every
   * mutation before this call; newer commands remain dirty and require a later flush.
   */
  flush(reason = 'flush'): Promise<CampaignSessionDocument> { return this.checkpoint(reason); }

  /** Caller-owned low-frequency scheduling; no timer, I/O, or checkpoint inside advance.
   * nowMs must share the origin of options.now (performance.now by default).
   */
  checkpointIfDue(nowMs = this.now()): Promise<CampaignSessionDocument> | null {
    this.assertOutsideMutation();
    if (!Number.isFinite(nowMs)) throw new Error('Invalid checkpoint clock');
    if (this.dueWrite) return this.dueWrite;
    if (!this.isDirty || this.dirtySince === null || nowMs - Math.max(this.dirtySince, this.lastCheckpointAt) < this.checkpointIntervalMs) return null;
    const operation = this.checkpoint('interval');
    this.lastCheckpointAt = nowMs;
    this.dueWrite = operation;
    void operation.then(() => { this.dueWrite = null; }, () => { this.dueWrite = null; });
    return operation;
  }

  private assertOutsideMutation(): void {
    if (this.mutating) throw new Error('Campaign mutations must be synchronous and non-reentrant');
  }
  private requireSynchronous(value: unknown): void {
    if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
      if (value instanceof Promise) void value.catch(() => {});
      throw new Error('Campaign mutations must be synchronous');
    }
  }
  private transaction<T>(mutate: (context: CampaignCheckpoint) => T, frame = false): T {
    this.assertOutsideMutation();
    // The trusted frame port can only borrow adapter/run. Keep rollback for that run and
    // settlement, without walking/copying an arbitrarily large immutable legacy import.
    // User commands and persistence retain full schema/cross-ledger validation.
    const before: CampaignSessionDocument = frame ? {
      sessionVersion: 1,
      campaign: { ...this.live.campaign, activeRun: structuredClone(this.live.campaign.activeRun),
        meta: structuredClone(this.live.campaign.meta), recentSettlement: structuredClone(this.live.campaign.recentSettlement) },
      s07Homes: structuredClone(this.live.s07Homes),
    } : structuredClone(this.live);
    const priorRemainder = this.remainder;
    const priorViewport = { ...this.viewport };
    this.mutating = true;
    try {
      const result = mutate({ save: this.live.campaign, adapter: this.adapter });
      this.requireSynchronous(result);
      const detached = structuredClone(result);
      // Only a new/removed RunState changes adapter lifetime. Settings/shop/commands do not.
      if (this.live.campaign.activeRun !== this.adapter?.run && (this.live.campaign.activeRun || this.adapter)) {
        this.live.s07Homes = null;
        this.rebuildAdapter();
        this.remainder = 0;
      }
      this.syncAdapter(before);
      const historyRun = this.live.campaign.activeRun;
      if (historyRun?.ecology.cycleVersion === 2 && !isPaused(historyRun) && !isTerminal(historyRun)
        && (historyRun.tick % 600 === 0 || Object.keys(historyRun.inventory.objects).length > 768)) {
        const homeVisits = Object.fromEntries((this.live.s07Homes?.homes ?? [])
          .filter(home => home.visitSequence > 0).map(home => [home.id, home.visitSequence - 1]));
        compactCampaignHistory(historyRun, homeVisits);
      }
      settleCampaignInSave(this.live.campaign);
      if (!frame || this.frameNeedsValidation(before)) validateCampaignSessionDocument(this.live, before.campaign.profile);
      const run = this.live.campaign.activeRun;
      if (!run || isPaused(run) || isTerminal(run) || run.phase === 'preparation'
        || before.campaign.activeRun?.pauseReasons.length) this.remainder = 0;
      const now = this.now();
      if (!Number.isFinite(now)) throw new Error('Invalid checkpoint clock');
      if (this.liveRevision === Number.MAX_SAFE_INTEGER) throw new Error('Campaign revision exhausted');
      this.liveRevision++;
      if (!this.isDirty) this.dirtySince = now;
      this.isDirty = true;
      return detached;
    } catch (error) {
      this.live = before;
      this.remainder = priorRemainder;
      Object.assign(this.viewport, priorViewport);
      this.rebuildAdapter(); // drops possibly corrupt paths/reservations, keeps home progress
      throw error;
    } finally { this.mutating = false; }
  }

  private rebuildAdapter(): void {
    const run = this.live.campaign.activeRun;
    this.adapter = run ? new S07DomainAdapter(run, this.viewport, this.live.s07Homes) : null;
    this.adapter?.flush();
    this.live.s07Homes = this.adapter?.homeProgress() ?? null;
  }
  private frameNeedsValidation(before: CampaignSessionDocument): boolean {
    const run = this.live.campaign.activeRun, previous = before.campaign.activeRun;
    if (!run || !previous) return true;
    if (!Number.isSafeInteger(run.tick) || run.tick < 0 || run.tick >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid campaign tick');
    validateS07HomeProgress(this.live.s07Homes, run);
    // New ecology objects, command receipts, economy events and phase/settlement transitions
    // can exhaust V4 budgets. Validate those growth boundaries before accepting the frame;
    // ordinary numeric clock/pose advancement does not rewalk immutable legacy history.
    return run.phase !== previous.phase || run.traps.length !== previous.traps.length
      || run.economy.events.length !== previous.economy.events.length
      || Object.keys(run.inventory.objects).length !== Object.keys(previous.inventory.objects).length
      || Object.keys(run.inventory.containers).length !== Object.keys(previous.inventory.containers).length
      || Object.keys(run.inventory.commands).length !== Object.keys(previous.inventory.commands).length
      || Object.keys(run.economy.purchases).length !== Object.keys(previous.economy.purchases).length;
  }
  private syncAdapter(before?: CampaignSessionDocument): void {
    const adapter = this.adapter;
    if (!adapter) return;
    const run = adapter.run;
    for (const actor of adapter.actors) {
      const saved = run.actors.find(value => value.id === actor.id)!;
      const previous = before?.campaign.activeRun?.actors.find(value => value.id === actor.id);
      // Existing setting commands can update a saved appearance without resetting tasks.
      if (previous && saved.pose.appearanceId !== previous.pose.appearanceId) Object.assign(actor, { appearanceId: saved.pose.appearanceId });
      if (run.phase !== 'running' && actor.task) {
        adapter.coordinator.releaseActor(actor); adapter.ledger.releaseActorReservations(actor.id);
        actor.task = undefined;
        if (actor.activity === 'travelling' || actor.activity === 'working') actor.activity = 'idle';
      }
    }
    adapter.present(run.houses);
    adapter.flush();
    this.live.s07Homes = adapter.homeProgress();
  }
  private durableSnapshot(): CampaignSessionDocument {
    // Every transaction flushes before publication; flush again at this explicit boundary.
    this.syncAdapter();
    const document = structuredClone(this.live), run = document.campaign.activeRun;
    if (run) {
      this.adapter?.restorePlayerObjectDragsForSnapshot(run);
      run.pauseReasons = run.pauseReasons.filter(reason => reason === 'user');
      cancelSwatter(run.swatter);
      run.swatter.start = { x: 0, y: 0 }; run.swatter.end = { x: 0, y: 0 };
      for (const actor of run.actors) {
        actor.pose.taskId = null;
        if (actor.pose.activity === 'travelling' || actor.pose.activity === 'working') actor.pose.activity = 'idle';
      }
    }
    return validateCampaignSessionDocument(document, this.live.campaign.profile);
  }

  static async open(options: {
    profile: string; storage: CampaignStoragePort; viewport: CampaignViewport;
    liveOptions?: CampaignLiveSessionOptions;
    /** Explicit legacy import; no implicit legacy path overwrite. */
    legacyRaw?: string; validateLegacy?: (value: unknown) => unknown;
  }): Promise<CampaignSessionV4> {
    createGameSaveV4(options.profile); // Validate before native I/O.
    const raw = await options.storage.read(options.profile);
    let document: CampaignSessionDocument;
    let migrated = false;
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && hasKey(parsed, 'sessionVersion')) {
        const record = parsed as Record<string, unknown>;
        if (Object.keys(record).length !== 3 || !['sessionVersion', 'campaign', 's07Homes'].every(key => hasKey(record, key))
          || record.sessionVersion !== 1) throw new Error('Unsupported campaign session; preserve original file');
        const migration = migrateGameSaveV4Ecology(record.campaign, options.profile);
        if (migration.migrated) {
          validateS07HomeProgress(record.s07Homes, (record.campaign as GameSaveV4).activeRun);
          document = { sessionVersion: 1, campaign: migration.save, s07Homes: null };
          migrated = true;
        } else document = validateCampaignSessionDocument(parsed, options.profile);
      } else {
        const migration = migrateGameSaveV4Ecology(parsed, options.profile);
        document = { sessionVersion: 1, campaign: migration.save, s07Homes: null };
        migrated = migration.migrated;
      }
      if (migrated) {
        if (!options.storage.preserveCycleV1) throw new Error('Pre-cycle V4 backup storage is unavailable; original save was not changed');
        await options.storage.preserveCycleV1(options.profile, raw);
      }
    } else {
      let campaign = createGameSaveV4(options.profile);
      if (options.legacyRaw !== undefined) {
        if (!options.validateLegacy) throw new Error('Existing legacy validator required');
        const migration = migrateLegacySave(options.legacyRaw, options.validateLegacy, options.profile);
        await options.storage.preserveLegacy(options.profile, migration.rawBackup);
        campaign = migration.save; migrated = true;
      }
      document = { sessionVersion: 1, campaign, s07Homes: null };
    }
    const session = new CampaignSessionV4(document, options.storage, options.viewport, options.liveOptions);
    if (migrated) await session.update(() => {});
    return session;
  }
}

