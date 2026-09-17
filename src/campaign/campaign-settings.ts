import { FALLBACK_LOCALE, resolveLocale, type Locale } from "./i18n";

export type GraphicsQuality = "low" | "medium" | "high";
export type CampaignIntensity = "gentle" | "standard" | "intense";
export type DetectionMode = "desktop" | "practice";
export type EffectLevel = "off" | "reduced" | "full";
export type UiScale = 1 | 1.5 | 2;

export interface CampaignAudioSettings {
  readonly master: number;
  readonly music: number;
  readonly effects: number;
  readonly alerts: number;
}

export interface CampaignVisualSettings {
  readonly quality: GraphicsQuality;
  readonly uiScale: UiScale;
  readonly motionEffects: EffectLevel;
  readonly flashes: EffectLevel;
  readonly stains: EffectLevel;
  readonly swarmAtmosphere: EffectLevel;
  /** Alerts always retain a non-audio channel, even when every audio slider is zero. */
  readonly visualAlerts: true;
}

export interface CampaignGameplaySettings {
  readonly intensity: CampaignIntensity;
  readonly detectionMode: DetectionMode;
  /** Next new mission preference only. Rust owns the current physical binding. */
  readonly displayId: string;
  readonly pauseWhenPanelOpen: boolean;
  readonly tutorialPrompts: boolean;
}

/** Machine-local preferences: this object must not be included in the Steam campaign save. */
export interface CampaignSettings {
  readonly schemaVersion: 1;
  readonly storageScope: "machine";
  readonly language: Locale;
  readonly audio: CampaignAudioSettings;
  readonly visual: CampaignVisualSettings;
  readonly gameplay: CampaignGameplaySettings;
  readonly diagnosticsConsent: boolean;
}

export interface CampaignSettingsPatch {
  readonly language?: unknown;
  readonly audio?: Partial<Record<keyof CampaignAudioSettings, unknown>>;
  readonly visual?: Partial<Record<keyof CampaignVisualSettings, unknown>>;
  readonly gameplay?: Partial<Record<keyof CampaignGameplaySettings, unknown>>;
  readonly diagnosticsConsent?: unknown;
}

const GRAPHICS_QUALITIES = new Set<string>(["low", "medium", "high"] satisfies GraphicsQuality[]);
const INTENSITIES = new Set<string>(["gentle", "standard", "intense"] satisfies CampaignIntensity[]);
const DETECTION_MODES = new Set<string>(["desktop", "practice"] satisfies DetectionMode[]);
const EFFECT_LEVELS = new Set<string>(["off", "reduced", "full"] satisfies EffectLevel[]);
const UI_SCALES = new Set<number>([1, 1.5, 2] satisfies UiScale[]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedVolume(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function member<Value extends string>(value: unknown, allowed: ReadonlySet<string>, fallback: Value): Value {
  return typeof value === "string" && allowed.has(value) ? value as Value : fallback;
}

function displayId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 160
    ? value
    : "primary";
}

export function createDefaultCampaignSettings(systemLanguage: unknown = FALLBACK_LOCALE): CampaignSettings {
  return {
    schemaVersion: 1,
    storageScope: "machine",
    language: resolveLocale(systemLanguage),
    audio: { master: 0.8, music: 0.55, effects: 0.8, alerts: 0.85 },
    visual: {
      quality: "medium",
      uiScale: 1,
      motionEffects: "full",
      flashes: "reduced",
      stains: "full",
      swarmAtmosphere: "full",
      visualAlerts: true,
    },
    gameplay: {
      intensity: "standard",
      detectionMode: "desktop",
      displayId: "primary",
      pauseWhenPanelOpen: true,
      tutorialPrompts: true,
    },
    diagnosticsConsent: false,
  };
}

/** Sanitizes the local settings trust boundary and returns a fresh, JSON-safe object. */
export function normalizeCampaignSettings(value: unknown, systemLanguage: unknown = FALLBACK_LOCALE): CampaignSettings {
  const defaults = createDefaultCampaignSettings(systemLanguage);
  const root = record(value);
  const audio = record(root.audio);
  const visual = record(root.visual);
  const gameplay = record(root.gameplay);
  const uiScale = typeof visual.uiScale === "number" && UI_SCALES.has(visual.uiScale)
    ? visual.uiScale as UiScale
    : defaults.visual.uiScale;
  return {
    schemaVersion: 1,
    storageScope: "machine",
    language: resolveLocale(root.language, defaults.language),
    audio: {
      master: boundedVolume(audio.master, defaults.audio.master),
      music: boundedVolume(audio.music, defaults.audio.music),
      effects: boundedVolume(audio.effects, defaults.audio.effects),
      alerts: boundedVolume(audio.alerts, defaults.audio.alerts),
    },
    visual: {
      quality: member(visual.quality, GRAPHICS_QUALITIES, defaults.visual.quality),
      uiScale,
      motionEffects: member(visual.motionEffects, EFFECT_LEVELS, defaults.visual.motionEffects),
      flashes: member(visual.flashes, EFFECT_LEVELS, defaults.visual.flashes),
      stains: member(visual.stains, EFFECT_LEVELS, defaults.visual.stains),
      swarmAtmosphere: member(visual.swarmAtmosphere, EFFECT_LEVELS, defaults.visual.swarmAtmosphere),
      visualAlerts: true,
    },
    gameplay: {
      intensity: member(gameplay.intensity, INTENSITIES, defaults.gameplay.intensity),
      detectionMode: member(gameplay.detectionMode, DETECTION_MODES, defaults.gameplay.detectionMode),
      displayId: displayId(gameplay.displayId),
      pauseWhenPanelOpen: boolean(gameplay.pauseWhenPanelOpen, defaults.gameplay.pauseWhenPanelOpen),
      tutorialPrompts: boolean(gameplay.tutorialPrompts, defaults.gameplay.tutorialPrompts),
    },
    diagnosticsConsent: boolean(root.diagnosticsConsent, defaults.diagnosticsConsent),
  };
}

export function updateCampaignSettings(
  current: CampaignSettings,
  patch: CampaignSettingsPatch,
): CampaignSettings {
  return normalizeCampaignSettings({
    ...current,
    ...patch,
    audio: { ...current.audio, ...patch.audio },
    visual: { ...current.visual, ...patch.visual },
    gameplay: { ...current.gameplay, ...patch.gameplay },
  }, current.language);
}

export function parseCampaignSettings(serialized: string | unknown, systemLanguage: unknown = FALLBACK_LOCALE): CampaignSettings {
  let value = serialized;
  if (typeof serialized === "string") {
    try { value = JSON.parse(serialized) as unknown; }
    catch { return createDefaultCampaignSettings(systemLanguage); }
  }
  return normalizeCampaignSettings(value, systemLanguage);
}

export function serializeCampaignSettings(settings: CampaignSettings): string {
  return JSON.stringify(normalizeCampaignSettings(settings, settings.language));
}
