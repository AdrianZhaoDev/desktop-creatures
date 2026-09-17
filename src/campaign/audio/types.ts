import type { CampaignAudioSettings } from "../campaign-settings";

export type CampaignAudioEventType =
  | "clean-sweep"
  | "tongue-fire"
  | "capture"
  | "swatter-hit"
  | "swatter-overheat"
  | "item-pickup"
  | "bag-dispose"
  | "purchase-failed"
  | "purchase-success"
  | "home-hit"
  | "home-low"
  | "retreat"
  | "victory"
  | "defeat"
  | "ui-confirm";

export interface CampaignAudioEvent {
  readonly type: CampaignAudioEventType;
  /** Number of equivalent events represented by this message. Invalid values become one. */
  readonly count?: number;
}

export type CampaignAudioChannel = "effects" | "alerts";
export type CampaignSoundCue = CampaignAudioEventType;

/** A fully resolved, side-effect-only request delivered to an audio backend. */
export interface CampaignSoundCommand {
  readonly cue: CampaignSoundCue;
  readonly channel: CampaignAudioChannel;
  readonly volume: number;
  readonly count: number;
  readonly issuedAtMs: number;
}

/** Injectable output port. Implementations must never be required by simulation state. */
export interface CampaignAudioOutput {
  /** False before a gesture unlock and whenever the backend is suspended/unavailable. */
  isReady(): boolean;
  /** Must only be invoked synchronously from a real user gesture handler. */
  unlockFromUserGesture(): Promise<boolean>;
  play(command: CampaignSoundCommand): void;
  stopAll(): void;
  dispose(): void;
}

export interface CampaignAudioScheduler {
  now(): number;
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface CampaignAudio {
  emit(event: CampaignAudioEvent): void;
  setSettings(settings: CampaignAudioSettings): void;
  setPaused(paused: boolean): void;
  setDocumentHidden(hidden: boolean): void;
  setSafetyHidden(hidden: boolean): void;
  unlockFromUserGesture(): Promise<boolean>;
  stop(): void;
  dispose(): void;
}

export interface CampaignVisibilityDocument {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}
