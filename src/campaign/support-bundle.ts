import type { CampaignPhase, RunState } from "./campaign-controller";
import type { CampaignSettings } from "./campaign-settings";

export const SUPPORT_BUNDLE_SCHEMA = "desktop-creatures.support.v1" as const;
export const SUPPORT_BUNDLE_VERSION = 1 as const;
const moduleAsset = (() => {
  try { return new URL(import.meta.url).pathname.split("/").pop()?.replace(/[^0-9A-Za-z._-]/g, "-") || "development"; }
  catch { return "development"; }
})();
export const CAMPAIGN_BUILD = Object.freeze({
  appVersion: "1.1.0",
  /** A production Vite asset name carries its content hash; dev/test use a public module marker. */
  buildFingerprint: `desktop-creatures-1.1.0-campaign-v4-${moduleAsset}`.slice(0, 128),
});

export type SupportRuntimeKind = "browser-practice" | "tauri";
export type SupportHealth = "ok" | "degraded" | "unavailable" | "practice";
export type SupportFaultCode =
  | "desktop-surface"
  | "device-placement"
  | "input"
  | "native-bridge"
  | "navigation-budget"
  | "recycling-bin"
  | "renderer"
  | "runtime-consistency"
  | "watchdog"
  | "other";
export type SupportPauseReason = "player" | "panel" | "tutorial" | "desktop-detection" | "hidden" | "system";

export interface SupportBundle {
  readonly schema: typeof SUPPORT_BUNDLE_SCHEMA;
  readonly version: typeof SUPPORT_BUNDLE_VERSION;
  /** UTC calendar day only. This deliberately cannot encode a precise session time. */
  readonly exportedOn: string;
  readonly build: {
    readonly appVersion: string;
    readonly buildFingerprint: string;
    readonly runtimeKind: SupportRuntimeKind;
  };
  readonly anonymousFaults: readonly { readonly code: SupportFaultCode; readonly count: number }[];
  readonly moduleHealth: {
    readonly campaign: SupportHealth;
    readonly renderer: SupportHealth;
    readonly audio: SupportHealth;
    readonly storage: SupportHealth;
    readonly input: SupportHealth;
    readonly desktopSurface: SupportHealth;
  };
  readonly runtime: {
    readonly stage: "lobby" | "mission" | "settlement";
    readonly phase: "none" | CampaignPhase;
    readonly paused: boolean;
    readonly pauseReasons: readonly SupportPauseReason[];
  };
  readonly localSettings: {
    readonly language: "en" | "zh-CN";
    readonly audioMuted: boolean;
    readonly graphicsQuality: "low" | "medium" | "high";
    readonly uiScale: 1 | 1.5 | 2;
    readonly motionEffects: "off" | "reduced" | "full";
    readonly flashes: "off" | "reduced" | "full";
    readonly stains: "off" | "reduced" | "full";
    readonly swarmAtmosphere: "off" | "reduced" | "full";
    readonly intensity: "gentle" | "standard" | "intense";
    readonly detectionMode: "desktop" | "practice";
    readonly pauseWhenPanelOpen: boolean;
    readonly tutorialPrompts: boolean;
  };
}

export interface SupportBundleSource {
  readonly runtimeKind: SupportRuntimeKind;
  readonly settings: CampaignSettings;
  readonly run: Pick<RunState, "phase" | "pauseReasons"> | null;
  readonly anonymousFaults: readonly { readonly code: SupportFaultCode; readonly count: number }[];
  readonly moduleHealth: SupportBundle["moduleHealth"];
  readonly now?: Date;
  readonly build?: Readonly<typeof CAMPAIGN_BUILD>;
}

export interface SupportBundleSavePort {
  /** Saves locally and returns false when the player cancels a native picker. Never uploads. */
  save(bundle: SupportBundle): Promise<boolean>;
}

const FAULT_CODES = new Set<string>([
  "desktop-surface", "device-placement", "input", "native-bridge", "navigation-budget",
  "recycling-bin", "renderer", "runtime-consistency", "watchdog", "other",
] satisfies SupportFaultCode[]);
const HEALTH = new Set<string>(["ok", "degraded", "unavailable", "practice"] satisfies SupportHealth[]);
const PHASES = new Set<string>(["none", "preparation", "running", "retreat", "siege", "victory", "defeat", "abandoned"]);
const PAUSES = new Set<string>(["player", "panel", "tutorial", "desktop-detection", "hidden", "system"] satisfies SupportPauseReason[]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} contains unknown or missing fields`);
}
function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value)) throw new Error(`invalid ${label}`);
  return value as T;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${label}`);
  return value;
}
function safeText(value: unknown, label: string, pattern: RegExp, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) throw new Error(`invalid ${label}`);
  return value;
}
function utcDay(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("invalid export date");
  return value.toISOString().slice(0, 10);
}

function normalizePauseReason(reason: string): SupportPauseReason {
  if (reason === "user") return "player";
  if (reason === "tutorial") return "tutorial";
  if (reason === "hidden" || reason === "emergency-hide") return "hidden";
  if (["surface", "desktop-detection", "terrain-invalid"].includes(reason)) return "desktop-detection";
  if (reason.startsWith("panel:")) return "panel";
  return "system";
}

export function buildSupportBundle(source: SupportBundleSource): SupportBundle {
  const run = source.run;
  const terminal = !!run && ["victory", "defeat", "abandoned"].includes(run.phase);
  const faults = source.anonymousFaults
    .filter(item => FAULT_CODES.has(item.code) && Number.isSafeInteger(item.count) && item.count > 0)
    .map(item => ({ code: item.code, count: Math.min(9999, item.count) }))
    .sort((left, right) => left.code.localeCompare(right.code));
  const pauses = [...new Set((run?.pauseReasons ?? []).map(normalizePauseReason))].sort() as SupportPauseReason[];
  const settings = source.settings;
  return parseSupportBundle({
    schema: SUPPORT_BUNDLE_SCHEMA,
    version: SUPPORT_BUNDLE_VERSION,
    exportedOn: utcDay(source.now ?? new Date()),
    build: { ...(source.build ?? CAMPAIGN_BUILD), runtimeKind: source.runtimeKind },
    anonymousFaults: faults,
    moduleHealth: { ...source.moduleHealth },
    runtime: {
      stage: run ? terminal ? "settlement" : "mission" : "lobby",
      phase: run?.phase ?? "none",
      paused: pauses.length > 0,
      pauseReasons: pauses,
    },
    localSettings: {
      language: settings.language,
      audioMuted: settings.audio.master === 0,
      graphicsQuality: settings.visual.quality,
      uiScale: settings.visual.uiScale,
      motionEffects: settings.visual.motionEffects,
      flashes: settings.visual.flashes,
      stains: settings.visual.stains,
      swarmAtmosphere: settings.visual.swarmAtmosphere,
      intensity: settings.gameplay.intensity,
      detectionMode: settings.gameplay.detectionMode,
      pauseWhenPanelOpen: settings.gameplay.pauseWhenPanelOpen,
      tutorialPrompts: settings.gameplay.tutorialPrompts,
    },
  });
}

/** Strict schema boundary used before every browser/native write. Unknown fields never pass. */
export function parseSupportBundle(value: unknown): SupportBundle {
  exact(value, ["schema", "version", "exportedOn", "build", "anonymousFaults", "moduleHealth", "runtime", "localSettings"], "support bundle");
  if (value.schema !== SUPPORT_BUNDLE_SCHEMA || value.version !== SUPPORT_BUNDLE_VERSION) throw new Error("unsupported support bundle schema");
  const exportedOn = safeText(value.exportedOn, "exportedOn", /^\d{4}-\d{2}-\d{2}$/, 10);
  if (utcDay(new Date(`${exportedOn}T00:00:00.000Z`)) !== exportedOn) throw new Error("invalid exportedOn");

  exact(value.build, ["appVersion", "buildFingerprint", "runtimeKind"], "build");
  const build = {
    appVersion: safeText(value.build.appVersion, "appVersion", /^[0-9A-Za-z][0-9A-Za-z.+-]*$/, 48),
    buildFingerprint: safeText(value.build.buildFingerprint, "buildFingerprint", /^[0-9A-Za-z][0-9A-Za-z._@/+:-]*$/, 128),
    runtimeKind: oneOf<SupportRuntimeKind>(value.build.runtimeKind, new Set(["browser-practice", "tauri"]), "runtimeKind"),
  };

  if (!Array.isArray(value.anonymousFaults) || value.anonymousFaults.length > FAULT_CODES.size) throw new Error("invalid anonymousFaults");
  const seenFaults = new Set<string>();
  const anonymousFaults = value.anonymousFaults.map((item, index) => {
    exact(item, ["code", "count"], `anonymousFaults[${index}]`);
    const code = oneOf<SupportFaultCode>(item.code, FAULT_CODES, "fault code");
    if (seenFaults.has(code)) throw new Error("duplicate fault code");
    seenFaults.add(code);
    if (!Number.isSafeInteger(item.count) || (item.count as number) < 1 || (item.count as number) > 9999) throw new Error("invalid fault count");
    return { code, count: item.count as number };
  });

  exact(value.moduleHealth, ["campaign", "renderer", "audio", "storage", "input", "desktopSurface"], "moduleHealth");
  const moduleHealth = {
    campaign: oneOf<SupportHealth>(value.moduleHealth.campaign, HEALTH, "campaign health"),
    renderer: oneOf<SupportHealth>(value.moduleHealth.renderer, HEALTH, "renderer health"),
    audio: oneOf<SupportHealth>(value.moduleHealth.audio, HEALTH, "audio health"),
    storage: oneOf<SupportHealth>(value.moduleHealth.storage, HEALTH, "storage health"),
    input: oneOf<SupportHealth>(value.moduleHealth.input, HEALTH, "input health"),
    desktopSurface: oneOf<SupportHealth>(value.moduleHealth.desktopSurface, HEALTH, "desktop surface health"),
  };

  exact(value.runtime, ["stage", "phase", "paused", "pauseReasons"], "runtime");
  if (!Array.isArray(value.runtime.pauseReasons) || value.runtime.pauseReasons.length > PAUSES.size) throw new Error("invalid pauseReasons");
  const pauseReasons = value.runtime.pauseReasons.map(reason => oneOf<SupportPauseReason>(reason, PAUSES, "pause reason"));
  if (new Set(pauseReasons).size !== pauseReasons.length) throw new Error("duplicate pause reason");
  const runtime = {
    stage: oneOf<SupportBundle["runtime"]["stage"]>(value.runtime.stage, new Set(["lobby", "mission", "settlement"]), "stage"),
    phase: oneOf<SupportBundle["runtime"]["phase"]>(value.runtime.phase, PHASES, "phase"),
    paused: bool(value.runtime.paused, "paused"),
    pauseReasons,
  };
  if (runtime.paused !== (pauseReasons.length > 0)) throw new Error("pause state mismatch");

  exact(value.localSettings, ["language", "audioMuted", "graphicsQuality", "uiScale", "motionEffects", "flashes", "stains", "swarmAtmosphere", "intensity", "detectionMode", "pauseWhenPanelOpen", "tutorialPrompts"], "localSettings");
  const effects = new Set(["off", "reduced", "full"]);
  const localSettings = {
    language: oneOf<"en" | "zh-CN">(value.localSettings.language, new Set(["en", "zh-CN"]), "language"),
    audioMuted: bool(value.localSettings.audioMuted, "audioMuted"),
    graphicsQuality: oneOf<"low" | "medium" | "high">(value.localSettings.graphicsQuality, new Set(["low", "medium", "high"]), "graphicsQuality"),
    uiScale: value.localSettings.uiScale,
    motionEffects: oneOf<"off" | "reduced" | "full">(value.localSettings.motionEffects, effects, "motionEffects"),
    flashes: oneOf<"off" | "reduced" | "full">(value.localSettings.flashes, effects, "flashes"),
    stains: oneOf<"off" | "reduced" | "full">(value.localSettings.stains, effects, "stains"),
    swarmAtmosphere: oneOf<"off" | "reduced" | "full">(value.localSettings.swarmAtmosphere, effects, "swarmAtmosphere"),
    intensity: oneOf<"gentle" | "standard" | "intense">(value.localSettings.intensity, new Set(["gentle", "standard", "intense"]), "intensity"),
    detectionMode: oneOf<"desktop" | "practice">(value.localSettings.detectionMode, new Set(["desktop", "practice"]), "detectionMode"),
    pauseWhenPanelOpen: bool(value.localSettings.pauseWhenPanelOpen, "pauseWhenPanelOpen"),
    tutorialPrompts: bool(value.localSettings.tutorialPrompts, "tutorialPrompts"),
  };
  if (![1, 1.5, 2].includes(localSettings.uiScale as number)) throw new Error("invalid uiScale");
  return structuredClone({ schema: SUPPORT_BUNDLE_SCHEMA, version: SUPPORT_BUNDLE_VERSION, exportedOn, build,
    anonymousFaults, moduleHealth, runtime, localSettings }) as SupportBundle;
}

export class AnonymousFaultCounter {
  private readonly counts = new Map<SupportFaultCode, number>();
  record(rawCode: string): void {
    const code = classifyFault(rawCode);
    this.counts.set(code, Math.min(9999, (this.counts.get(code) ?? 0) + 1));
  }
  snapshot(): readonly { readonly code: SupportFaultCode; readonly count: number }[] {
    return [...this.counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([code, count]) => ({ code, count }));
  }
}

export function classifyFault(rawCode: string): SupportFaultCode {
  if (rawCode === "renderer") return "renderer";
  if (rawCode.startsWith("input-") || ["regions", "grab-payload", "pause-payload"].includes(rawCode)) return "input";
  if (rawCode.startsWith("placement-")) return "device-placement";
  if (rawCode.startsWith("surface-") || rawCode === "viewport-rebuild-required") return "desktop-surface";
  if (["native-start", "native-write", "native-cancel"].includes(rawCode)) return "native-bridge";
  if (["navigation-budget-exhausted", "approach-budget-exhausted"].includes(rawCode)) return "navigation-budget";
  if (rawCode === "bin-geometry") return "recycling-bin";
  if (rawCode === "heartbeat") return "watchdog";
  if (["invalid-fixed-step", "duplicate-tick", "stale-scope"].includes(rawCode)) return "runtime-consistency";
  return "other";
}

export class SupportBundleExporter {
  private exporting = false;
  constructor(
    private readonly source: () => SupportBundleSource,
    private readonly port: SupportBundleSavePort,
  ) {}
  get busy(): boolean { return this.exporting; }
  async exportFromUserGesture(event: Readonly<{ isTrusted: boolean; type: string }>): Promise<"saved" | "cancelled" | "ignored"> {
    if (this.exporting || !event.isTrusted || !["click", "keydown"].includes(event.type)) return "ignored";
    this.exporting = true;
    try { return await this.port.save(buildSupportBundle(this.source())) ? "saved" : "cancelled"; }
    finally { this.exporting = false; }
  }
}
