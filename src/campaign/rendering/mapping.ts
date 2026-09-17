import type { ActorSnapshot, CampaignPhase, HouseState, RunState } from '../campaign-controller';
import type { GraphicsQuality } from '../campaign-settings';

/** Input-only contract: even nested inventories cannot be changed through this bridge. */
export type ReadonlyDomain<T> = T extends readonly (infer V)[] ? readonly ReadonlyDomain<V>[]
  : T extends object ? { readonly [K in keyof T]: ReadonlyDomain<T[K]> } : T;
export type CampaignRenderSource = ReadonlyDomain<RunState>;
export type CleanerHeightDip = 96 | 120 | 160;
export interface QualityPolicy {
  readonly pixelRatioCap: number;
  readonly shadows: boolean;
  readonly effects: boolean;
  readonly crowdLod: 1 | 2;
}
export const QUALITY_POLICIES: Readonly<Record<GraphicsQuality, QualityPolicy>> = Object.freeze({
  low: Object.freeze({ pixelRatioCap: 1, shadows: false, effects: false, crowdLod: 2 }),
  medium: Object.freeze({ pixelRatioCap: 1.5, shadows: false, effects: true, crowdLod: 1 }),
  high: Object.freeze({ pixelRatioCap: 2, shadows: true, effects: true, crowdLod: 1 }),
});
export function renderPixelRatio(dpiScale: number, quality: GraphicsQuality): number {
  return Math.min(Number.isFinite(dpiScale) && dpiScale > 0 ? dpiScale : 1, QUALITY_POLICIES[quality].pixelRatioCap);
}
export function interpolationAlpha(alpha: number): number { return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1; }
export function interpolateCoordinate(previous: number, current: number, alpha: number): number {
  return previous + (current - previous) * interpolationAlpha(alpha);
}
export function appearanceResourceId(actor: ReadonlyDomain<ActorSnapshot>): string {
  const id = actor.pose.appearanceId;
  if (actor.archetype === 'frog' && id === 'frog') return 'actor.frog';
  if (actor.archetype === 'cleaner' && (id === 'female' || id === 'male')) return `actor.cleaner.${id}`;
  return id; // Unknown appearances are explicit placeholders, never silently another character.
}
export function houseHealthFraction(house: Readonly<Pick<HouseState, 'hp' | 'maxHp'>>): number {
  return Number.isFinite(house.hp) && Number.isFinite(house.maxHp) && house.maxHp > 0
    ? Math.max(0, Math.min(1, house.hp / house.maxHp)) : 0;
}
/** Semantic intent can exceed the currently authored S06 clip set. */
export function actorActionIntent(actor: ReadonlyDomain<ActorSnapshot>, phase: CampaignPhase, carrying = false): string {
  if (actor.pose.activity === 'unavailable' || phase === 'defeat') return 'disabled';
  if (phase === 'victory') return 'celebrate';
  if (actor.atHome && (phase === 'siege' || phase === 'retreat')) return 'brace_home';
  if (actor.pose.activity === 'entering-home') return 'enter_home';
  if (actor.pose.activity === 'resting') return 'sleep';
  if (actor.pose.activity === 'exiting-home') return 'wake';
  // Physical motion wins over stale work activity; animations never imply an airborne hit.
  if (actor.pose.motion === 'jumping') return actor.archetype === 'frog' ? 'hop_air' : 'jump_air';
  if (actor.pose.motion === 'falling') return 'fall';
  if (actor.pose.motion === 'landing') return 'land';
  if (actor.pose.motion === 'climbing') return 'climb';
  if (actor.pose.activity === 'working') return actor.archetype === 'frog' ? 'tongue_fire' : 'clean';
  if (carrying && actor.pose.activity === 'returning-home') return 'carry';
  if (actor.pose.activity === 'travelling' || actor.pose.activity === 'returning-home' || Math.abs(actor.pose.vx) > 1e-6) return 'walk';
  return 'idle';
}
const FROG_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  fall: 'hop_air', jump_air: 'hop_air', jump_start: 'hop_start', walk: 'idle', carry: 'idle',
  sleep: 'idle', wake: 'idle', disabled: 'idle', brace_home: 'idle', celebrate: 'idle', climb: 'idle',
});
const CLEANER_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  fall: 'jump_air', enter_home: 'carry', sleep: 'idle', wake: 'idle', disabled: 'idle', brace_home: 'idle', celebrate: 'idle',
});
export function resolveClipName(intent: string, archetype: 'cleaner' | 'frog', available: ReadonlySet<string>): string | undefined {
  if (available.has(intent)) return intent;
  const fallback = (archetype === 'frog' ? FROG_FALLBACKS : CLEANER_FALLBACKS)[intent];
  if (fallback && available.has(fallback)) return fallback;
  return available.has('idle') ? 'idle' : undefined;
}
export function isLoopingClip(name: string): boolean {
  return name === 'idle' || name === 'walk' || name === 'climb' || name === 'clean' || name === 'carry' || name === 'jump_air';
}
