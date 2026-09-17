import type { CampaignAudioSettings } from "../campaign-settings";
import type {
  CampaignAudio,
  CampaignAudioChannel,
  CampaignAudioEvent,
  CampaignAudioEventType,
  CampaignAudioOutput,
  CampaignAudioScheduler,
  CampaignSoundCommand,
  CampaignVisibilityDocument,
} from "./types";

interface CuePolicy {
  readonly channel: CampaignAudioChannel;
  readonly gain: number;
  readonly aggregateMs: number;
  readonly minimumIntervalMs: number;
  readonly maximumCount: number;
}

const effect = (gain: number, aggregateMs = 0, minimumIntervalMs = 0, maximumCount = 1): CuePolicy =>
  ({ channel: "effects", gain, aggregateMs, minimumIntervalMs, maximumCount });
const alert = (gain: number, minimumIntervalMs = 0): CuePolicy =>
  ({ channel: "alerts", gain, aggregateMs: 0, minimumIntervalMs, maximumCount: 1 });

export const CAMPAIGN_CUE_POLICY: Readonly<Record<CampaignAudioEventType, CuePolicy>> = Object.freeze({
  "clean-sweep": effect(0.55, 36, 90, 8),
  "tongue-fire": effect(0.62, 22, 120, 4),
  capture: effect(0.68, 28, 90, 8),
  "swatter-hit": effect(0.72, 28, 85, 8),
  "swatter-overheat": alert(0.8, 600),
  "item-pickup": effect(0.5, 32, 90, 8),
  "bag-dispose": effect(0.72, 0, 180),
  "purchase-failed": effect(0.58, 0, 180),
  "purchase-success": effect(0.62, 0, 120),
  "home-hit": effect(0.7, 42, 180, 6),
  "home-low": alert(0.88, 1200),
  retreat: alert(0.9, 1000),
  victory: alert(0.85, 1000),
  defeat: alert(0.9, 1000),
  "ui-confirm": effect(0.42, 0, 45),
});

interface PendingBatch {
  count: number;
  handle: unknown;
}

const browserScheduler: CampaignAudioScheduler = {
  now: () => performance.now(),
  set: (delayMs, callback) => globalThis.setTimeout(callback, delayMs),
  clear: handle => globalThis.clearTimeout(handle as number),
};

function clampedVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function eventCount(value: number | undefined, maximum: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return 1;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function safeCall(callback: () => void): void {
  try { callback(); } catch { /* Audio is optional and may never affect simulation. */ }
}

export class CampaignAudioDirector implements CampaignAudio {
  private settings: CampaignAudioSettings;
  private readonly pending = new Map<CampaignAudioEventType, PendingBatch>();
  private readonly lastIssuedAt = new Map<CampaignAudioEventType, number>();
  private paused = false;
  private documentHidden = false;
  private safetyHidden = false;
  private disposed = false;

  constructor(
    private readonly output: CampaignAudioOutput,
    settings: CampaignAudioSettings,
    private readonly scheduler: CampaignAudioScheduler = browserScheduler,
  ) {
    this.settings = { ...settings };
  }

  emit(event: CampaignAudioEvent): void {
    if (this.disposed || this.silenced || !this.outputReady()) return;
    const policy = CAMPAIGN_CUE_POLICY[event.type];
    if (this.volumeFor(policy) <= 0) return;
    const count = eventCount(event.count, policy.maximumCount);
    if (policy.aggregateMs <= 0) {
      this.issue(event.type, count, policy);
      return;
    }
    const existing = this.pending.get(event.type);
    if (existing) {
      existing.count = Math.min(policy.maximumCount, existing.count + count);
      return;
    }
    const pending: PendingBatch = { count, handle: undefined };
    try { pending.handle = this.scheduler.set(policy.aggregateMs, () => this.flush(event.type)); }
    catch { return; }
    this.pending.set(event.type, pending);
  }

  setSettings(settings: CampaignAudioSettings): void {
    if (this.disposed) return;
    this.settings = { ...settings };
    // Settings apply immediately to already-scheduled and currently sounding effects.
    this.silenceNow();
  }

  setPaused(paused: boolean): void { this.setGate("paused", paused); }
  setDocumentHidden(hidden: boolean): void { this.setGate("documentHidden", hidden); }
  setSafetyHidden(hidden: boolean): void { this.setGate("safetyHidden", hidden); }

  async unlockFromUserGesture(): Promise<boolean> {
    if (this.disposed) return false;
    try { return await this.output.unlockFromUserGesture(); }
    catch { return false; }
  }

  stop(): void { if (!this.disposed) this.silenceNow(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending();
    safeCall(() => this.output.stopAll());
    safeCall(() => this.output.dispose());
    this.lastIssuedAt.clear();
  }

  private get silenced(): boolean { return this.paused || this.documentHidden || this.safetyHidden; }

  private outputReady(): boolean {
    try { return this.output.isReady(); } catch { return false; }
  }

  private setGate(gate: "paused" | "documentHidden" | "safetyHidden", value: boolean): void {
    if (this.disposed || this[gate] === value) return;
    this[gate] = value;
    if (value) this.silenceNow();
  }

  private volumeFor(policy: CuePolicy): number {
    return clampedVolume(this.settings.master)
      * clampedVolume(this.settings[policy.channel])
      * policy.gain;
  }

  private flush(type: CampaignAudioEventType): void {
    const pending = this.pending.get(type);
    if (!pending) return;
    this.pending.delete(type);
    if (this.disposed || this.silenced) return;
    const policy = CAMPAIGN_CUE_POLICY[type];
    this.issue(type, pending.count, policy);
  }

  private issue(type: CampaignAudioEventType, count: number, policy: CuePolicy): void {
    if (!this.outputReady()) return;
    let now: number;
    try { now = this.scheduler.now(); } catch { return; }
    if (!Number.isFinite(now)) return;
    const last = this.lastIssuedAt.get(type);
    if (last !== undefined && now - last < policy.minimumIntervalMs) return;
    const volume = this.volumeFor(policy);
    if (volume <= 0) return;
    const command: CampaignSoundCommand = {
      cue: type,
      channel: policy.channel,
      volume,
      count,
      issuedAtMs: now,
    };
    this.lastIssuedAt.set(type, now);
    safeCall(() => this.output.play(command));
  }

  private cancelPending(): void {
    for (const batch of this.pending.values()) safeCall(() => this.scheduler.clear(batch.handle));
    this.pending.clear();
  }

  private silenceNow(): void {
    this.cancelPending();
    safeCall(() => this.output.stopAll());
  }
}

/** Keeps document visibility outside the director so tests and native safety code use the same gate. */
export function bindCampaignAudioVisibility(
  audio: Pick<CampaignAudio, "setDocumentHidden">,
  documentLike: CampaignVisibilityDocument,
): () => void {
  const update = (): void => audio.setDocumentHidden(documentLike.hidden);
  update();
  documentLike.addEventListener("visibilitychange", update);
  return () => documentLike.removeEventListener("visibilitychange", update);
}
