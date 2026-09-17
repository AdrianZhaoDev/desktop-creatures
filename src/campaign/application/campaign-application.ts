import {
  continueAfterSettlement,
  startCampaignInSave,
  type GameSaveV4,
} from "../campaign-save-v4";
import {
  maintainCatcher,
  placeTrap,
  purchaseRunUpgrade,
  removeTrap,
  repairHouse,
  setCampaignPaused,
  startRun,
  type TrapKind,
} from "../campaign-controller";
import type { RunUpgradeId } from "../economy";
import {
  createDefaultCampaignSettings,
  parseCampaignSettings,
  serializeCampaignSettings,
  updateCampaignSettings,
  type CampaignSettings,
  type CampaignSettingsPatch,
} from "../campaign-settings";
import type { CampaignSessionDocument } from "../campaign-session-v4";
import { CampaignSessionV4 } from "../campaign-session-v4";
import { CLEANER_STAMINA, FROG_STAMINA } from "../actor-state";
import type { S07DomainAdapter } from "../integration/s07-domain-adapter";
import { purchaseResearch, resetResearch } from "../research";
import {
  createTutorialState,
  parseTutorialState,
  reduceTutorial,
  serializeTutorialState,
  tutorialPauseRequested,
  type TutorialEvent,
  type TutorialState,
} from "../tutorial";
import {
  snapshotCampaignUi,
  type CampaignUiCommand,
  type CampaignUiCommandBody,
  type CampaignUiLocalState,
  type CampaignUiPanel,
  type CampaignUiSnapshot,
  type CampaignUiTool,
  type StrategyPriority,
} from "../ui/model";

/** Machine-local stores are deliberately profile-free and cannot address V4/Steam files. */
export interface SettingsStoragePort {
  read(): Promise<string | null>;
  /** null restores an absent value during a cross-store rollback. */
  writeAtomic(serialized: string | null): Promise<void>;
}

/** Machine-local stores are deliberately profile-free and cannot address V4/Steam files. */
export interface TutorialStoragePort {
  read(): Promise<string | null>;
  /** null restores an absent value during a cross-store rollback. */
  writeAtomic(serialized: string | null): Promise<void>;
}

export interface RunIdentity {
  readonly runId: string;
  readonly seed: number;
}

/** Retry identities come from the platform owner, never wall time or ambient randomness. */
export interface RunIdentityPort {
  nextRun(previous: Readonly<{ runId: string; missionId: string }>): Promise<RunIdentity> | RunIdentity;
}

export interface TrustedDevicePlacement {
  readonly placementId: string;
  readonly position: Readonly<{ x: number; y: number }>;
  readonly validGround: boolean;
}

/** The runtime resolves live terrain independently of all UI-controlled fields. */
export interface DevicePlacementContextPort {
  resolve(command: Readonly<{ commandId: string; deviceId: string; runId: string }>): Promise<TrustedDevicePlacement | null> | TrustedDevicePlacement | null;
}

export interface CampaignViewContext {
  readonly missionTitle?: string;
  readonly availableDisplays?: readonly { readonly id: string; readonly label: string }[];
  readonly failureReason?: "both-homes-fallen" | "abandoned" | "unknown";
}

export interface CampaignViewContextPort {
  read(): CampaignViewContext;
}

export type RuntimePauseReason =
  | "display-change"
  | "surface"
  | "hidden"
  | "emergency-hide"
  | "desktop-detection"
  | "terrain-invalid"
  | "input-capture"
  | `runtime:${string}`;

export type CampaignApplicationEffect =
  | { readonly type: "campaign-started"; readonly runId: string; readonly missionId: "demo-1" }
  | { readonly type: "appearance-selected"; readonly appearanceId: "female" | "male" }
  | { readonly type: "panel-changed"; readonly panel: CampaignUiPanel }
  | { readonly type: "pause-reasons-changed"; readonly reasons: readonly string[] }
  | { readonly type: "tool-changed"; readonly tool: CampaignUiTool | null }
  | { readonly type: "strategy-changed"; readonly actorId: string; readonly priority: StrategyPriority }
  | { readonly type: "run-upgrade-purchased"; readonly upgradeId: RunUpgradeId }
  | { readonly type: "device-placed"; readonly deviceId: string; readonly placementId: string }
  | { readonly type: "device-maintained"; readonly trapId: string }
  | { readonly type: "device-removed"; readonly trapId: string }
  | { readonly type: "research-purchased"; readonly nodeId: string }
  | { readonly type: "research-reset"; readonly refund: number }
  | { readonly type: "house-repaired"; readonly houseId: string }
  | { readonly type: "run-retried"; readonly previousRunId: string; readonly runId: string }
  | { readonly type: "run-continued"; readonly previousRunId: string }
  | { readonly type: "settings-changed"; readonly path: string }
  | { readonly type: "tutorial-changed"; readonly event: TutorialEvent["type"] }
  | { readonly type: "campaign-dirty" }
  | { readonly type: "runtime-pause-changed"; readonly reason: RuntimePauseReason; readonly paused: boolean };

export type CampaignCommandFailureReason =
  | "invalid-command"
  | "command-id-conflict"
  | "stale-revision"
  | "active-run-exists"
  | "invalid-run-identity"
  | "invalid-appearance"
  | "no-active-run"
  | "run-not-terminal"
  | "campaign-frozen"
  | "upgrade-unavailable"
  | "unsupported-device"
  | "invalid-trap-id"
  | "placement-unavailable"
  | "invalid-placement-context"
  | "invalid-trap"
  | "invalid-ground"
  | "slots"
  | "parts"
  | "not-repairable"
  | "research-unavailable"
  | "invalid-settings-path"
  | "invalid-settings-value"
  | "missing-actor"
  | "strategy-unavailable"
  | "missing-trap"
  | "maintenance-required"
  | "refund-unavailable"
  | "settings-storage-failed"
  | "tutorial-storage-failed"
  | "campaign-storage-failed"
  | "local-rollback-failed"
  | `domain:${string}`;

export interface CampaignCommandSuccess {
  readonly ok: true;
  readonly reason: "ok";
  readonly commandId: string;
  readonly replayed: boolean;
  readonly durability: "clean" | "dirty";
  readonly revision: string;
  readonly effects: readonly CampaignApplicationEffect[];
  readonly snapshot: CampaignUiSnapshot | null;
}

export interface CampaignCommandFailure {
  readonly ok: false;
  readonly reason: CampaignCommandFailureReason;
  readonly commandId: string;
  readonly replayed: boolean;
  readonly durability: "clean" | "dirty";
  readonly revision: string;
  /** A failed command never publishes semantic effects. */
  readonly effects: readonly [];
  readonly snapshot: CampaignUiSnapshot | null;
}

export type CampaignCommandResult = CampaignCommandSuccess | CampaignCommandFailure;

export type CampaignCheckpointResult =
  | { readonly ok: true; readonly reason: "ok"; readonly dirty: false; readonly revision: string }
  | { readonly ok: false; readonly reason: "campaign-storage-failed"; readonly dirty: true; readonly revision: string };

export interface CampaignApplicationOptions {
  readonly session: CampaignSessionV4;
  readonly settingsStorage: SettingsStoragePort;
  readonly tutorialStorage: TutorialStoragePort;
  readonly runIdentity: RunIdentityPort;
  readonly placementContext: DevicePlacementContextPort;
  readonly systemLanguage?: unknown;
  readonly initialUi?: Partial<CampaignUiLocalState>;
  readonly viewContext?: CampaignViewContextPort;
}

export interface CampaignLobbySnapshot {
  readonly mode: "lobby";
  readonly revision: string;
  readonly meta: GameSaveV4["meta"];
  readonly settlement: GameSaveV4["recentSettlement"];
  readonly settings: CampaignSettings;
  readonly tutorial: TutorialState;
  readonly ui: CampaignUiLocalState;
  readonly availableDisplays: readonly { readonly id: string; readonly label: string }[];
}

export type CampaignApplicationSnapshot =
  | { readonly mode: "run"; readonly revision: string; readonly ui: CampaignUiSnapshot }
  | CampaignLobbySnapshot;

interface StoredResult {
  readonly signature: string;
  readonly ok: boolean;
  readonly reason: "ok" | CampaignCommandFailureReason;
}

interface PreparedMutation {
  settings: CampaignSettings;
  tutorial: TutorialState;
  ui: MutableUiState;
  settingsChanged: boolean;
  tutorialChanged: boolean;
  domainMutation?: (save: GameSaveV4, adapter: S07DomainAdapter | null) => void;
  /** Device domain receipts record rejected attempts and must survive checkpoints. */
  persistDomainRejection?: boolean;
  effects: CampaignApplicationEffect[];
}

interface MutableUiState {
  panel: CampaignUiPanel;
  equippedTool: CampaignUiTool | null;
  strategyByActor: Record<string, StrategyPriority>;
  dismissedResultRunId: string | null;
}

class DomainRejected extends Error {
  constructor(readonly reason: CampaignCommandFailureReason) { super(reason); }
}

const PANEL_PAUSE_REASON: Readonly<Partial<Record<Exclude<CampaignUiPanel, "none">, string>>> = Object.freeze({
  shop: "panel:shop",
  research: "panel:research",
  strategy: "panel:strategy",
  settings: "panel:settings",
  result: "panel:result",
});
const OWNED_PANEL_REASONS = Object.freeze(Object.values(PANEL_PAUSE_REASON));
const SAFE_STALE_COMMAND = (command: CampaignUiCommand): boolean =>
  command.type === "panel.close" || (command.type === "tool.equip" && command.tool === null);
const SUPPORTED_TRAPS = new Set<string>(["bait", "glue", "catcher", "ladder"] satisfies TrapKind[]);
const ACTIVE_PRIORITIES = new Set<string>(["clean", "nearHome"] satisfies StrategyPriority[]);

function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function cloneUi(ui: CampaignUiLocalState): MutableUiState {
  return { panel: ui.panel, equippedTool: ui.equippedTool, strategyByActor: { ...ui.strategyByActor }, dismissedResultRunId: ui.dismissedResultRunId ?? null };
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function validTrapId(value: unknown): value is string { return validId(value) && value.trim() === value; }
function normalizeStrategyByActor(value: unknown): Record<string, StrategyPriority> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const normalized: Record<string, StrategyPriority> = {};
  for (const actorId of Object.keys(source).filter(validId).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
    const priority = source[actorId];
    Object.defineProperty(normalized, actorId, {
      value: priority === "clean" || priority === "nearHome" ? priority : "clean",
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return normalized;
}

function syncPanelPause(save: GameSaveV4, panel: CampaignUiPanel, enabled: boolean): void {
  const run = save.activeRun;
  if (!run) return;
  for (const reason of OWNED_PANEL_REASONS) setCampaignPaused(run, reason, false);
  if (panel !== "none" && enabled) setCampaignPaused(run, PANEL_PAUSE_REASON[panel]!, true);
}

function syncTutorialPause(save: GameSaveV4, tutorial: TutorialState): void {
  if (save.activeRun) setCampaignPaused(save.activeRun, "tutorial", tutorialPauseRequested(tutorial));
}

function domainFailureReason(reason: string): CampaignCommandFailureReason {
  const known = new Set(["campaign-frozen", "upgrade-unavailable", "invalid-trap", "invalid-ground", "slots", "parts", "not-repairable", "missing-trap", "maintenance-required", "refund-unavailable"]);
  return known.has(reason) ? reason as CampaignCommandFailureReason : `domain:${reason}`;
}
function receiptOrThrow(receipt: Readonly<{ ok: boolean; reason: string }>): void {
  if (!receipt.ok) throw new DomainRejected(domainFailureReason(receipt.reason));
}

function settingsPatch(path: string, value: string | number | boolean, displays: readonly { id: string }[]): CampaignSettingsPatch | null | false {
  const enumValue = (allowed: readonly string[]): boolean => typeof value === "string" && allowed.includes(value);
  if (path === "language") return enumValue(["zh-CN", "en"]) ? { language: value } : false;
  if (["audio.master", "audio.music", "audio.effects", "audio.alerts"].includes(path)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return false;
    return { audio: { [path.slice(6)]: value } } as CampaignSettingsPatch;
  }
  if (path === "visual.quality") return enumValue(["low", "medium", "high"]) ? { visual: { quality: value } } : false;
  if (path === "visual.uiScale") return typeof value === "number" && [1, 1.5, 2].includes(value) ? { visual: { uiScale: value } } : false;
  if (["visual.motionEffects", "visual.flashes", "visual.stains", "visual.swarmAtmosphere"].includes(path)) {
    if (!enumValue(["off", "reduced", "full"])) return false;
    return { visual: { [path.slice(7)]: value } } as CampaignSettingsPatch;
  }
  if (path === "gameplay.intensity") return enumValue(["gentle", "standard", "intense"]) ? { gameplay: { intensity: value } } : false;
  if (path === "gameplay.detectionMode") return enumValue(["desktop", "practice"]) ? { gameplay: { detectionMode: value } } : false;
  if (path === "gameplay.displayId") return typeof value === "string" && displays.some(display => display.id === value) ? { gameplay: { displayId: value } } : false;
  if (path === "gameplay.pauseWhenPanelOpen" || path === "gameplay.tutorialPrompts") {
    if (typeof value !== "boolean") return false;
    return { gameplay: { [path.slice(9)]: value } } as CampaignSettingsPatch;
  }
  if (path === "diagnosticsConsent") return typeof value === "boolean" ? { diagnosticsConsent: value } : false;
  return null;
}

function commandSignature(command: CampaignUiCommand): string {
  // Device identity survives checkpoints through domain receipts. A refreshed read
  // revision is concurrency metadata, not a different maintenance/removal payload.
  return command.type === "device.maintain" || command.type === "device.remove"
    ? JSON.stringify([command.type, command.trapId]) : JSON.stringify(command);
}

/** Excludes 60 Hz clocks, actor poses, swatter motion, ecology gauges, and siege HP churn.
 * Those values are revalidated by domain functions at commit time instead of making every
 * click stale. Identity, phase, pauses, currency, purchases, progression and topology remain
 * semantic concurrency boundaries.
 */
function semanticCampaign(document: CampaignSessionDocument): string {
  const campaign = document.campaign;
  const run = campaign.activeRun;
  return JSON.stringify({
    profile: campaign.profile,
    meta: campaign.meta,
    recentSettlement: campaign.recentSettlement,
    run: run && {
      runId: run.runId,
      missionId: run.missionId,
      phase: run.phase,
      pauseReasons: run.pauseReasons,
      economy: run.economy,
      upgrades: run.upgrades,
      researchNodes: run.researchNodes,
      containers: run.inventory.containers,
      commands: run.inventory.commands,
      objectOwners: Object.values(run.inventory.objects).map(item => [item.id, item.kind, item.owner]),
      houses: run.houses.map(house => [house.id, house.repaired, house.locked, house.hp <= 0]),
      traps: run.traps.map(trap => [trap.id, trap.kind, trap.x, trap.y, trap.paid, trap.purchaseCommandId, trap.inventoryId]),
      trapSlots: run.trapSlots,
      frogUnlocked: run.frogUnlocked,
    },
  });
}

export class CampaignApplication {
  private readonly receipts = new Map<string, StoredResult>();
  private tail: Promise<void> = Promise.resolve();
  private revisionNumber = 0;
  private commandSequence = 0;
  private observedCampaign: string;

  private constructor(
    private readonly options: CampaignApplicationOptions,
    private settings: CampaignSettings,
    private tutorial: TutorialState,
    private ui: CampaignUiLocalState,
    private settingsRaw: string | null,
    private tutorialRaw: string | null,
  ) {
    this.observedCampaign = semanticCampaign(options.session.snapshot());
    // Domain receipts survive restart while this dispatcher is machine-local. Continue
    // their high-water mark so a new purchase cannot replay a previous launch's command.
    const run = options.session.snapshot().campaign.activeRun;
    if (run) {
      const prefix = `${run.runId}:application:`;
      const ids = [...Object.keys(run.inventory.commands), ...run.traps.map(trap => trap.purchaseCommandId)];
      for (const key of Object.keys(run.economy.purchases)) {
        const tuple: unknown = JSON.parse(key); // already validated by Session.open
        if (Array.isArray(tuple) && ['spend', 'refund', 'unused-refund'].includes(tuple[0])) {
          for (const id of tuple.slice(1)) if (typeof id === 'string') ids.push(id);
        }
      }
      for (const storedId of ids) {
        const id = ['upgrade:', 'trap:', 'repair:'].some(tag => storedId.startsWith(tag)) ? storedId.slice(storedId.indexOf(':') + 1) : storedId;
        if (!id.startsWith(prefix) || !/^\d+$/.test(id.slice(prefix.length))) continue;
        const sequence = Number(id.slice(prefix.length));
        if (Number.isSafeInteger(sequence) && sequence > this.commandSequence) this.commandSequence = sequence;
      }
    }
  }

  static async open(options: CampaignApplicationOptions): Promise<CampaignApplication> {
    const [settingsRaw, tutorialRaw] = await Promise.all([
      options.settingsStorage.read(),
      options.tutorialStorage.read(),
    ]);
    const settings = settingsRaw === null ? createDefaultCampaignSettings(options.systemLanguage) : parseCampaignSettings(settingsRaw, options.systemLanguage);
    const tutorial = tutorialRaw === null ? createTutorialState() : parseTutorialState(tutorialRaw);
    const panel = options.initialUi?.panel ?? "none";
    const equippedTool = options.initialUi?.equippedTool ?? null;
    const ui: CampaignUiLocalState = {
      panel,
      equippedTool,
      strategyByActor: normalizeStrategyByActor(options.initialUi?.strategyByActor),
      dismissedResultRunId: options.initialUi?.dismissedResultRunId ?? null,
    };
    const application = new CampaignApplication(options, settings, tutorial, ui, settingsRaw, tutorialRaw);
    const run = options.session.snapshot().campaign.activeRun;
    const panelReason = panel === "none" || !settings.gameplay.pauseWhenPanelOpen ? null : PANEL_PAUSE_REASON[panel];
    if (run && (panelReason !== null && panelReason !== undefined && !run.pauseReasons.includes(panelReason)
      || tutorialPauseRequested(tutorial) && !run.pauseReasons.includes("tutorial"))) {
      options.session.command(({ save }) => {
        syncPanelPause(save, panel, settings.gameplay.pauseWhenPanelOpen);
        syncTutorialPause(save, tutorial);
      });
      application.observedCampaign = semanticCampaign(options.session.snapshot());
      application.revisionNumber++;
    }
    return application;
  }

  private refreshObservedCampaign(): CampaignSessionDocument {
    const document = this.options.session.snapshot();
    const serialized = semanticCampaign(document);
    if (serialized !== this.observedCampaign) {
      this.observedCampaign = serialized;
      this.revisionNumber++;
    }
    return document;
  }

  revision(): string {
    const document = this.refreshObservedCampaign();
    return `${document.campaign.activeRun?.runId ?? "no-run"}:application:${this.revisionNumber}`;
  }

  /** Returns null between runs; permanent research commands still use revision(). */
  snapshot(): CampaignUiSnapshot | null {
    const document = this.refreshObservedCampaign();
    const run = document.campaign.activeRun;
    if (!run) return null;
    const context = this.options.viewContext?.read() ?? {};
    const snapshot = snapshotCampaignUi({
      run,
      meta: document.campaign.meta,
      settings: this.settings,
      tutorial: this.tutorial,
      ui: this.ui,
      settlement: document.campaign.recentSettlement,
      ...context,
    });
    return Object.freeze({ ...snapshot, revision: `${run.runId}:application:${this.revisionNumber}` });
  }

  /** The application snapshot never fabricates a RunState while between missions. */
  applicationSnapshot(): CampaignApplicationSnapshot {
    const runSnapshot = this.snapshot();
    const revision = this.revision();
    if (runSnapshot) return { mode: "run", revision, ui: runSnapshot };
    const campaign = this.options.session.snapshot().campaign;
    const context = this.options.viewContext?.read() ?? {};
    return Object.freeze({
      mode: "lobby",
      revision,
      meta: structuredClone(campaign.meta),
      settlement: structuredClone(campaign.recentSettlement),
      settings: structuredClone(this.settings),
      tutorial: structuredClone(this.tutorial),
      ui: structuredClone(this.ui),
      availableDisplays: structuredClone(context.availableDisplays?.length ? context.availableDisplays : [{ id: "primary", label: "Primary" }]),
    });
  }

  /** Preferred adapter entry: IDs remain monotonic across UI remounts in this owner. */
  createCommand(body: CampaignUiCommandBody): CampaignUiCommand {
    if (this.commandSequence >= Number.MAX_SAFE_INTEGER) throw new Error('Campaign command sequence exhausted');
    const runId = this.options.session.snapshot().campaign.activeRun?.runId ?? "lobby";
    return { ...body, commandId: `${runId}:application:${++this.commandSequence}`, readRevision: this.revision() } as CampaignUiCommand;
  }

  settingsSnapshot(): CampaignSettings { return structuredClone(this.settings); }
  tutorialSnapshot(): TutorialState { return structuredClone(this.tutorial); }
  uiSnapshot(): CampaignUiLocalState { return structuredClone(this.ui); }

  dispatch(command: CampaignUiCommand): Promise<CampaignCommandResult> {
    return this.enqueue(() => this.dispatchNow(command));
  }

  /** Simulation/runtime events have an explicit path instead of masquerading as UI commands. */
  dispatchTutorialEvent(event: TutorialEvent, eventId?: string): Promise<CampaignCommandResult> {
    const id = eventId ?? `${this.options.session.snapshot().campaign.activeRun?.runId ?? "lobby"}:tutorial:${++this.commandSequence}`;
    return this.enqueue(() => this.dispatchTutorialNow(event, id));
  }

  /** Hidden/detection/input safety reasons are supplied by the runtime, never inferred from UI visibility. */
  setRuntimePauseReason(reason: RuntimePauseReason, paused: boolean | (() => boolean)): Promise<CampaignCommandResult> {
    return this.enqueue(() => this.runtimePauseNow(reason, typeof paused === 'function' ? paused() : paused));
  }

  /** Serialized house interaction. The resident follows the persisted timed exit routine. */
  callResidentOut(houseId: string): Promise<CampaignCommandResult> {
    const expectedRevision = this.revision();
    const expectedRunId = this.options.session.snapshot().campaign.activeRun?.runId;
    const commandId = this.commandSequence < Number.MAX_SAFE_INTEGER
      ? `${expectedRunId ?? "no-run"}:application:${++this.commandSequence}` : "resident-call:exhausted";
    return this.enqueue(() => this.callResidentOutNow(commandId, houseId, expectedRevision, expectedRunId));
  }

  /** Persistence is an explicit low-frequency boundary. A failed write keeps live state dirty. */
  async checkpoint(reason = "application"): Promise<CampaignCheckpointResult> {
    try {
      await this.options.session.checkpoint(reason);
      return { ok: true, reason: "ok", dirty: false, revision: this.revision() };
    } catch {
      return { ok: false, reason: "campaign-storage-failed", dirty: true, revision: this.revision() };
    }
  }

  private enqueue(work: () => Promise<CampaignCommandResult>): Promise<CampaignCommandResult> {
    const operation = this.tail.then(work, work);
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private failure(commandId: string, reason: CampaignCommandFailureReason, replayed = false): CampaignCommandFailure {
    return { ok: false, reason, commandId, replayed, durability: this.options.session.dirty ? "dirty" : "clean", revision: this.revision(), effects: [], snapshot: this.snapshot() };
  }

  private success(commandId: string, effects: readonly CampaignApplicationEffect[], replayed = false): CampaignCommandSuccess {
    return { ok: true, reason: "ok", commandId, replayed, durability: this.options.session.dirty ? "dirty" : "clean", revision: this.revision(), effects, snapshot: this.snapshot() };
  }

  private replay(commandId: string, stored: StoredResult): CampaignCommandResult {
    return stored.ok ? this.success(commandId, [], true) : this.failure(commandId, stored.reason as CampaignCommandFailureReason, true);
  }

  private storeResult(commandId: string, signature: string, result: CampaignCommandResult): CampaignCommandResult {
    this.receipts.set(commandId, { signature, ok: result.ok, reason: result.reason });
    return result;
  }

  /** Recognize completed device transactions without entering Session.command.
   * Replaying through commit would mark the save dirty and republish effects/audio,
   * even though the domain correctly prevented another release or refund.
   */
  private persistedDeviceReplay(command: CampaignUiCommand): CampaignCommandResult | null {
    const run = this.options.session.snapshot().campaign.activeRun;
    if (!run || !Object.prototype.hasOwnProperty.call(run.inventory.commands, command.commandId)) return null;
    const receipt = run.inventory.commands[command.commandId];
    let tuple: unknown;
    try { tuple = JSON.parse(receipt.signature); } catch { tuple = null; }
    let body: Extract<CampaignUiCommandBody, { type: "device.maintain" | "device.remove" }> | null = null;
    if (Array.isArray(tuple) && typeof tuple[1] === "string") {
      if (tuple.length === 2 && tuple[0] === "remove-trap") body = { type: "device.remove", trapId: tuple[1] };
      else if (tuple.length === 2 && tuple[0] === "maintain-catcher"
        || tuple.length === 4 && tuple[0] === "residue-batch" && run.inventory.containers[tuple[1]]?.kind === "trap") {
        body = { type: "device.maintain", trapId: tuple[1] };
      }
    }
    if (!body) {
      return command.type === "device.maintain" || command.type === "device.remove"
        ? this.failure(command.commandId, "command-id-conflict") : null;
    }
    const signature = JSON.stringify([body.type, body.trapId]);
    if (signature !== commandSignature(command)) return this.failure(command.commandId, "command-id-conflict");
    const stored: StoredResult = { signature, ok: receipt.ok, reason: receipt.ok ? "ok" : domainFailureReason(receipt.reason) };
    this.receipts.set(command.commandId, stored);
    return this.replay(command.commandId, stored);
  }

  private async dispatchNow(command: CampaignUiCommand): Promise<CampaignCommandResult> {
    if (!command || typeof command !== "object" || !validId(command.commandId) || !validId(command.readRevision) || typeof command.type !== "string") {
      return this.failure(typeof command?.commandId === "string" ? command.commandId : "invalid", "invalid-command");
    }
    const signature = commandSignature(command);
    const stored = this.receipts.get(command.commandId);
    if (stored) return stored.signature === signature ? this.replay(command.commandId, stored) : this.failure(command.commandId, "command-id-conflict");

    const persisted = this.persistedDeviceReplay(command);
    if (persisted) return persisted;

    const currentRevision = this.revision();
    if (command.readRevision !== currentRevision && !SAFE_STALE_COMMAND(command)) {
      return this.storeResult(command.commandId, signature, this.failure(command.commandId, "stale-revision"));
    }

    let prepared: PreparedMutation;
    try { prepared = await this.prepare(command); }
    catch (error) {
      const reason = error instanceof DomainRejected ? error.reason : "invalid-command";
      return this.storeResult(command.commandId, signature, this.failure(command.commandId, reason));
    }
    const result = await this.commit(command.commandId, prepared);
    return this.storeResult(command.commandId, signature, result);
  }

  private async prepare(command: CampaignUiCommand): Promise<PreparedMutation> {
    const document = this.options.session.snapshot();
    const run = document.campaign.activeRun;
    const ui = cloneUi(this.ui);
    let settings = this.settings;
    let tutorial = this.tutorial;
    let settingsChanged = false;
    let tutorialChanged = false;
    let preparedDomainReceipt = false;
    let domainMutation: PreparedMutation["domainMutation"];
    const effects: CampaignApplicationEffect[] = [];
    const requireRun = () => { if (!run) throw new DomainRejected("no-active-run"); return run; };

    switch (command.type) {
      case "campaign.start": {
        if (run) throw new DomainRejected("active-run-exists");
        const missionId = "demo-1" as const;
        const identity = await this.options.runIdentity.nextRun({ runId: "none", missionId });
        if (!identity || !validId(identity.runId) || !Number.isSafeInteger(identity.seed) || identity.seed < 0 || identity.seed > 0xffffffff
          || document.campaign.meta.settledRunIds.includes(identity.runId)) throw new DomainRejected("invalid-run-identity");
        domainMutation = save => {
          if (save.activeRun) throw new DomainRejected("active-run-exists");
          if (save.meta.settledRunIds.includes(identity.runId)) throw new DomainRejected("invalid-run-identity");
          startCampaignInSave(save, identity.runId, missionId, identity.seed);
          startRun(save.activeRun!);
        };
        ui.panel = "none"; ui.dismissedResultRunId = null; ui.equippedTool = null;
        effects.push({ type: "campaign-started", runId: identity.runId, missionId });
        break;
      }
      case "appearance.select": {
        if (run) throw new DomainRejected("active-run-exists");
        if (command.appearanceId !== "female" && command.appearanceId !== "male") throw new DomainRejected("invalid-appearance");
        domainMutation = save => {
          if (save.activeRun) throw new DomainRejected("active-run-exists");
          save.meta.appearanceId = command.appearanceId;
        };
        effects.push({ type: "appearance-selected", appearanceId: command.appearanceId });
        break;
      }
      case "panel.open": {
        if (!["shop", "research", "strategy", "result", "settings"].includes(command.panel)) throw new DomainRejected("invalid-command");
        ui.panel = command.panel;
        if (command.panel === "result") ui.dismissedResultRunId = null;
        domainMutation = save => syncPanelPause(save, ui.panel, settings.gameplay.pauseWhenPanelOpen);
        effects.push({ type: "panel-changed", panel: ui.panel });
        break;
      }
      case "panel.close": {
        if (run && ui.panel === "result") ui.dismissedResultRunId = run.runId;
        ui.panel = "none";
        domainMutation = save => syncPanelPause(save, "none", settings.gameplay.pauseWhenPanelOpen);
        effects.push({ type: "panel-changed", panel: "none" });
        break;
      }
      case "campaign.pause-toggle": {
        requireRun();
        domainMutation = save => {
          if (!save.activeRun) throw new DomainRejected("no-active-run");
          setCampaignPaused(save.activeRun, "user", !save.activeRun.pauseReasons.includes("user"));
        };
        break;
      }
      case "tool.equip": {
        if (command.tool !== null && !["bag", "swatter", "trap"].includes(command.tool)) throw new DomainRejected("invalid-command");
        if (command.tool !== null) requireRun();
        ui.equippedTool = command.tool;
        effects.push({ type: "tool-changed", tool: command.tool });
        if (command.tool !== null) {
          tutorial = reduceTutorial(tutorial, { type: "tool-equipped", tool: command.tool });
          tutorialChanged = !sameJson(tutorial, this.tutorial);
          domainMutation = save => syncTutorialPause(save, tutorial);
          if (tutorialChanged) effects.push({ type: "tutorial-changed", event: "tool-equipped" });
        }
        break;
      }
      case "upgrade.purchase": {
        requireRun();
        domainMutation = save => receiptOrThrow(purchaseRunUpgrade(save.activeRun!, command.commandId, command.upgradeId));
        effects.push({ type: "run-upgrade-purchased", upgradeId: command.upgradeId });
        break;
      }
      case "device.place": {
        const active = requireRun();
        if (!SUPPORTED_TRAPS.has(command.deviceId)) throw new DomainRejected("unsupported-device");
        const placement = await this.options.placementContext.resolve({ commandId: command.commandId, deviceId: command.deviceId, runId: active.runId });
        if (!placement) throw new DomainRejected("placement-unavailable");
        if (!validId(placement.placementId) || !placement.position || !Number.isFinite(placement.position.x) || !Number.isFinite(placement.position.y) || typeof placement.validGround !== "boolean") {
          throw new DomainRejected("invalid-placement-context");
        }
        const trusted = structuredClone(placement);
        domainMutation = save => {
          if (save.activeRun?.runId !== active.runId) throw new DomainRejected("stale-revision");
          receiptOrThrow(placeTrap(save.activeRun, command.commandId, trusted.placementId, command.deviceId as TrapKind, trusted.position, trusted.validGround));
        };
        effects.push({ type: "device-placed", deviceId: command.deviceId, placementId: trusted.placementId });
        break;
      }
      case "device.maintain": {
        requireRun();
        if (!validTrapId(command.trapId)) throw new DomainRejected("invalid-trap-id");
        domainMutation = save => receiptOrThrow(maintainCatcher(save.activeRun!, command.commandId, command.trapId));
        preparedDomainReceipt = true;
        effects.push({ type: "device-maintained", trapId: command.trapId });
        break;
      }
      case "device.remove": {
        requireRun();
        if (!validTrapId(command.trapId)) throw new DomainRejected("invalid-trap-id");
        domainMutation = save => receiptOrThrow(removeTrap(save.activeRun!, command.commandId, command.trapId));
        preparedDomainReceipt = true;
        effects.push({ type: "device-removed", trapId: command.trapId });
        break;
      }
      case "research.purchase": {
        if (document.campaign.activeRun) throw new DomainRejected("research-unavailable");
        domainMutation = save => { if (!purchaseResearch(save.meta, command.nodeId, save.activeRun !== null)) throw new DomainRejected("research-unavailable"); };
        effects.push({ type: "research-purchased", nodeId: command.nodeId });
        break;
      }
      case "research.reset": {
        if (document.campaign.activeRun) throw new DomainRejected("research-unavailable");
        const effect: { type: "research-reset"; refund: number } = { type: "research-reset", refund: 0 };
        domainMutation = save => {
          const result = resetResearch(save.meta, save.activeRun !== null);
          if (result === null) throw new DomainRejected("research-unavailable");
          effect.refund = result;
        };
        effects.push(effect);
        break;
      }
      case "strategy.set": {
        const active = requireRun();
        if (!validId(command.actorId) || !active.actors.some(actor => actor.id === command.actorId)) throw new DomainRejected("missing-actor");
        if (!ACTIVE_PRIORITIES.has(command.priority)) throw new DomainRejected("strategy-unavailable");
        ui.strategyByActor = { ...ui.strategyByActor, [command.actorId]: command.priority };
        effects.push({ type: "strategy-changed", actorId: command.actorId, priority: command.priority });
        break;
      }
      case "house.repair": {
        requireRun();
        domainMutation = save => receiptOrThrow(repairHouse(save.activeRun!, command.commandId, command.houseId));
        effects.push({ type: "house-repaired", houseId: command.houseId });
        break;
      }
      case "result.retry": {
        const previous = requireRun();
        if (!previous || !["victory", "defeat", "abandoned"].includes(previous.phase)) throw new DomainRejected("run-not-terminal");
        const identity = await this.options.runIdentity.nextRun({ runId: previous.runId, missionId: previous.missionId });
        if (!identity || !validId(identity.runId) || !Number.isSafeInteger(identity.seed) || identity.seed < 0 || identity.seed > 0xffffffff) throw new DomainRejected("invalid-command");
        const previousRunId = previous.runId;
        domainMutation = save => {
          if (save.activeRun?.runId !== previousRunId || !["victory", "defeat", "abandoned"].includes(save.activeRun.phase)) throw new DomainRejected("stale-revision");
          continueAfterSettlement(save);
          if (save.activeRun) throw new DomainRejected("run-not-terminal");
          startCampaignInSave(save, identity.runId, previous.missionId, identity.seed);
          startRun(save.activeRun!);
        };
        ui.panel = "none"; ui.dismissedResultRunId = null; ui.equippedTool = null;
        effects.push({ type: "run-retried", previousRunId, runId: identity.runId });
        break;
      }
      case "result.continue": {
        const previous = requireRun();
        if (!["victory", "defeat", "abandoned"].includes(previous.phase)) throw new DomainRejected("run-not-terminal");
        domainMutation = save => {
          if (save.activeRun?.runId !== previous.runId || !["victory", "defeat", "abandoned"].includes(save.activeRun.phase)) throw new DomainRejected("stale-revision");
          continueAfterSettlement(save);
          if (save.activeRun) throw new DomainRejected("run-not-terminal");
        };
        ui.panel = "research"; ui.dismissedResultRunId = previous.runId; ui.equippedTool = null;
        effects.push({ type: "run-continued", previousRunId: previous.runId });
        break;
      }
      case "settings.update": {
        const displays = this.options.viewContext?.read().availableDisplays ?? [{ id: "primary" }];
        const patch = settingsPatch(command.path, command.value, displays);
        if (patch === null) throw new DomainRejected("invalid-settings-path");
        if (patch === false) throw new DomainRejected("invalid-settings-value");
        settings = updateCampaignSettings(settings, patch);
        settingsChanged = !sameJson(settings, this.settings);
        if (command.path === "gameplay.pauseWhenPanelOpen") domainMutation = save => syncPanelPause(save, ui.panel, settings.gameplay.pauseWhenPanelOpen);
        effects.push({ type: "settings-changed", path: command.path });
        break;
      }
      case "tutorial.dismiss":
      case "tutorial.skip-step":
      case "tutorial.skip-all": {
        const event: TutorialEvent = command.type === "tutorial.dismiss" ? { type: "dismiss-prompt" } : command.type === "tutorial.skip-step" ? { type: "skip-step" } : { type: "skip-all" };
        tutorial = reduceTutorial(tutorial, event);
        tutorialChanged = !sameJson(tutorial, this.tutorial);
        domainMutation = save => syncTutorialPause(save, tutorial);
        effects.push({ type: "tutorial-changed", event: event.type });
        break;
      }
      default: throw new DomainRejected("invalid-command");
    }
    return { settings, tutorial, ui, settingsChanged, tutorialChanged, domainMutation, persistDomainRejection: preparedDomainReceipt, effects };
  }

  private async commit(commandId: string, prepared: PreparedMutation): Promise<CampaignCommandResult> {
    const beforeSettingsRaw = this.settingsRaw;
    const beforeTutorialRaw = this.tutorialRaw;
    const nextSettingsRaw = prepared.settingsChanged ? serializeCampaignSettings(prepared.settings) : beforeSettingsRaw;
    const nextTutorialRaw = prepared.tutorialChanged ? serializeTutorialState(prepared.tutorial) : beforeTutorialRaw;
    const written: Array<"settings" | "tutorial"> = [];
    try {
      if (prepared.settingsChanged) { await this.options.settingsStorage.writeAtomic(nextSettingsRaw); written.push("settings"); }
      if (prepared.tutorialChanged) { await this.options.tutorialStorage.writeAtomic(nextTutorialRaw); written.push("tutorial"); }
    } catch {
      const failed = prepared.settingsChanged && !written.includes("settings") ? "settings-storage-failed" : "tutorial-storage-failed";
      if (written.length && !await this.rollbackLocal(written, beforeSettingsRaw, beforeTutorialRaw)) return this.failure(commandId, "local-rollback-failed");
      return this.failure(commandId, failed);
    }

    if (prepared.domainMutation) {
      const outcome: { persistedRejection?: DomainRejected } = {};
      try {
        this.options.session.command(({ save, adapter }) => {
          if (!prepared.persistDomainRejection) prepared.domainMutation!(save, adapter);
          else {
            try { prepared.domainMutation!(save, adapter); }
            catch (error) {
              if (error instanceof DomainRejected && save.activeRun
                && Object.prototype.hasOwnProperty.call(save.activeRun.inventory.commands, commandId)) outcome.persistedRejection = error;
              else throw error;
            }
          }
        });
      } catch (error) {
        if (written.length && !await this.rollbackLocal(written, beforeSettingsRaw, beforeTutorialRaw)) return this.failure(commandId, "local-rollback-failed");
        if (error instanceof DomainRejected) return this.failure(commandId, error.reason);
        return this.failure(commandId, "domain:transaction-failed");
      }
      if (outcome.persistedRejection) return this.failure(commandId, outcome.persistedRejection.reason);
    }

    this.settings = prepared.settings;
    this.tutorial = prepared.tutorial;
    this.ui = prepared.ui;
    this.settingsRaw = nextSettingsRaw;
    this.tutorialRaw = nextTutorialRaw;
    this.observedCampaign = semanticCampaign(this.options.session.snapshot());
    this.revisionNumber++;
    const pauseReasons = this.options.session.snapshot().campaign.activeRun?.pauseReasons;
    if (pauseReasons && prepared.domainMutation) prepared.effects.push({ type: "pause-reasons-changed", reasons: [...pauseReasons] });
    if (prepared.domainMutation && this.options.session.dirty) prepared.effects.push({ type: "campaign-dirty" });
    return this.success(commandId, prepared.effects);
  }

  private async rollbackLocal(written: readonly ("settings" | "tutorial")[], settingsRaw: string | null, tutorialRaw: string | null): Promise<boolean> {
    let ok = true;
    for (const store of [...written].reverse()) {
      try {
        if (store === "settings") await this.options.settingsStorage.writeAtomic(settingsRaw);
        else await this.options.tutorialStorage.writeAtomic(tutorialRaw);
      } catch { ok = false; }
    }
    return ok;
  }

  private async dispatchTutorialNow(event: TutorialEvent, eventId: string): Promise<CampaignCommandResult> {
    if (!validId(eventId) || !event || typeof event.type !== "string") return this.failure(eventId || "invalid", "invalid-command");
    const signature = JSON.stringify(["tutorial", event]);
    const stored = this.receipts.get(eventId);
    if (stored) return stored.signature === signature ? this.replay(eventId, stored) : this.failure(eventId, "command-id-conflict");
    const next = reduceTutorial(this.tutorial, event);
    const prepared: PreparedMutation = {
      settings: this.settings,
      tutorial: next,
      ui: cloneUi(this.ui),
      settingsChanged: false,
      tutorialChanged: !sameJson(next, this.tutorial),
      domainMutation: save => syncTutorialPause(save, next),
      effects: sameJson(next, this.tutorial) ? [] : [{ type: "tutorial-changed", event: event.type }],
    };
    const result = await this.commit(eventId, prepared);
    return this.storeResult(eventId, signature, result);
  }

  private async runtimePauseNow(reason: RuntimePauseReason, paused: boolean): Promise<CampaignCommandResult> {
    const commandId = `runtime-pause:${reason}:${paused}`;
    if (!validId(reason) || OWNED_PANEL_REASONS.includes(reason)) return this.failure(commandId, "invalid-command");
    if (!this.options.session.snapshot().campaign.activeRun) return this.failure(commandId, "no-active-run");
    const prepared: PreparedMutation = {
      settings: this.settings,
      tutorial: this.tutorial,
      ui: cloneUi(this.ui),
      settingsChanged: false,
      tutorialChanged: false,
      domainMutation: save => setCampaignPaused(save.activeRun!, reason, paused),
      effects: [{ type: "runtime-pause-changed", reason, paused }],
    };
    return this.commit(commandId, prepared);
  }

  private async callResidentOutNow(commandId: string, houseId: string, expectedRevision: string,
    expectedRunId: string | undefined): Promise<CampaignCommandResult> {
    if (commandId === "resident-call:exhausted") return this.failure(commandId, "invalid-command");
    if (!validId(houseId)) return this.failure(commandId, "domain:wrong-house");
    if (this.revision() !== expectedRevision) return this.failure(commandId, "stale-revision");
    const document = this.options.session.snapshot();
    const run = document.campaign.activeRun;
    if (!run || expectedRunId === undefined) return this.failure(commandId, "no-active-run");
    if (run.runId !== expectedRunId) return this.failure(commandId, "stale-revision");
    const house = run.houses.find(candidate => candidate.id === houseId);
    const actor = house && run.actors.find(candidate => candidate.houseId === house.id);
    if (!house || !actor) return this.failure(commandId, "domain:wrong-house");
    if (run.phase !== "running" || run.pauseReasons.length) return this.failure(commandId, "campaign-frozen");
    if (house.hp <= 0 || actor.pose.activity === "unavailable") return this.failure(commandId, "domain:house-destroyed");
    if (actor.pose.activity === "returning-home" || actor.pose.activity === "entering-home") {
      return this.failure(commandId, "domain:home-entry-pending");
    }
    if (actor.pose.activity === "exiting-home") return this.success(commandId, []);
    const profile = actor.archetype === "frog" ? FROG_STAMINA : CLEANER_STAMINA;
    if (actor.pose.stamina <= profile.returnHomeAt) return this.failure(commandId, "domain:too-tired");
    if (!actor.atHome) return this.success(commandId, []);
    if (actor.pose.activity !== "resting") return this.failure(commandId, "domain:invalid-state");

    const expectedActorId = actor.id;
    const prepared: PreparedMutation = {
      settings: this.settings,
      tutorial: this.tutorial,
      ui: cloneUi(this.ui),
      settingsChanged: false,
      tutorialChanged: false,
      domainMutation: (save, adapter) => {
        const liveHouse = save.activeRun?.houses.find(candidate => candidate.id === houseId);
        const liveActor = save.activeRun?.actors.find(candidate => candidate.id === expectedActorId);
        if (save.activeRun?.runId !== expectedRunId || !adapter || adapter.run !== save.activeRun
          || !liveHouse || !liveActor || liveActor.houseId !== houseId) throw new DomainRejected("stale-revision");
        receiptOrThrow(adapter.callResidentOut(commandId, houseId));
      },
      effects: [],
    };
    return this.commit(commandId, prepared);
  }
}
