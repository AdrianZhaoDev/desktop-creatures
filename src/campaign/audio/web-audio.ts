import type { CampaignAudioOutput, CampaignSoundCommand, CampaignSoundCue } from "./types";

type ContextFactory = () => AudioContext | null;

interface Tone {
  readonly frequency: number;
  readonly endFrequency?: number;
  readonly wave: OscillatorType;
  readonly delayMs: number;
  readonly durationMs: number;
  readonly amplitude: number;
}

const tone = (
  frequency: number,
  wave: OscillatorType,
  durationMs: number,
  amplitude: number,
  delayMs = 0,
  endFrequency?: number,
): Tone => ({ frequency, wave, durationMs, amplitude, delayMs, endFrequency });

/** Original procedural bleeps: intentionally a functional first-pass, not final mix approval. */
const RECIPES: Readonly<Record<CampaignSoundCue, readonly Tone[]>> = Object.freeze({
  "clean-sweep": [tone(520, "triangle", 70, 0.18, 0, 650)],
  "tongue-fire": [tone(330, "sine", 95, 0.2, 0, 610)],
  capture: [tone(660, "triangle", 70, 0.18), tone(880, "sine", 65, 0.14, 42)],
  "swatter-hit": [tone(150, "square", 45, 0.13, 0, 85), tone(980, "sine", 42, 0.1)],
  "swatter-overheat": [tone(380, "sawtooth", 130, 0.13, 0, 170), tone(240, "square", 90, 0.09, 115)],
  "item-pickup": [tone(720, "sine", 55, 0.16, 0, 840)],
  "bag-dispose": [tone(440, "triangle", 85, 0.18), tone(700, "sine", 105, 0.16, 55)],
  "purchase-failed": [tone(260, "square", 70, 0.1), tone(190, "square", 90, 0.09, 70)],
  "purchase-success": [tone(590, "triangle", 70, 0.15), tone(790, "triangle", 90, 0.14, 65)],
  "home-hit": [tone(120, "triangle", 100, 0.2, 0, 82)],
  "home-low": [tone(290, "sine", 150, 0.2), tone(230, "sine", 160, 0.18, 190)],
  retreat: [tone(520, "triangle", 160, 0.17, 0, 310), tone(390, "triangle", 180, 0.16, 135, 220)],
  victory: [tone(523, "triangle", 120, 0.16), tone(659, "triangle", 120, 0.15, 105), tone(784, "sine", 210, 0.16, 210)],
  defeat: [tone(392, "triangle", 150, 0.17, 0, 310), tone(294, "triangle", 180, 0.16, 130, 196)],
  "ui-confirm": [tone(760, "sine", 42, 0.11)],
});

function defaultContextFactory(): AudioContext | null {
  const constructors = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextClass = constructors.AudioContext ?? constructors.webkitAudioContext;
  if (!AudioContextClass) return null;
  try { return new AudioContextClass(); } catch { return null; }
}

function safeDisconnect(node: AudioNode): void {
  try { node.disconnect(); } catch { /* Already disconnected or unavailable. */ }
}

export interface WebAudioCampaignOutputOptions {
  /** Test seam and host-specific factory. It is never called before explicit unlock. */
  readonly contextFactory?: ContextFactory;
}

interface Voice {
  readonly oscillator: OscillatorNode;
  readonly gain: GainNode;
}

export class WebAudioCampaignOutput implements CampaignAudioOutput {
  private context?: AudioContext;
  private readonly voices = new Set<Voice>();
  private disposed = false;

  constructor(private readonly contextFactory: ContextFactory = defaultContextFactory) {}

  isReady(): boolean { return !this.disposed && this.context?.state === "running"; }

  async unlockFromUserGesture(): Promise<boolean> {
    if (this.disposed) return false;
    try {
      if (!this.context) this.context = this.contextFactory() ?? undefined;
      const context = this.context;
      if (!context || context.state === "closed") return false;
      if (context.state === "suspended") await context.resume();
      return context.state === "running";
    } catch { return false; }
  }

  play(command: CampaignSoundCommand): void {
    const context = this.context;
    if (this.disposed || !context || context.state !== "running" || command.volume <= 0) return;
    const recipe = RECIPES[command.cue];
    if (!recipe) return;
    const countLift = Math.min(0.12, Math.max(0, command.count - 1) * 0.018);
    for (const spec of recipe) this.startTone(context, spec, command.volume, countLift);
  }

  stopAll(): void {
    const stopAt = this.context?.currentTime ?? 0;
    for (const voice of [...this.voices]) {
      try { voice.oscillator.stop(stopAt); } catch { /* A stopped source cannot be stopped twice. */ }
      this.release(voice);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== "closed") {
      try { void context.close().catch(() => undefined); } catch { /* Optional backend teardown. */ }
    }
  }

  private startTone(context: AudioContext, spec: Tone, volume: number, countLift: number): void {
    let oscillator: OscillatorNode | undefined;
    let gain: GainNode | undefined;
    try {
      oscillator = context.createOscillator();
      gain = context.createGain();
      const startsAt = context.currentTime + 0.005 + spec.delayMs / 1000;
      const endsAt = startsAt + spec.durationMs / 1000;
      oscillator.type = spec.wave;
      oscillator.frequency.setValueAtTime(spec.frequency * (1 + countLift), startsAt);
      if (spec.endFrequency) oscillator.frequency.exponentialRampToValueAtTime(spec.endFrequency * (1 + countLift), endsAt);
      const peak = Math.max(0.0001, Math.min(0.25, volume * spec.amplitude));
      gain.gain.setValueAtTime(0.0001, startsAt);
      gain.gain.linearRampToValueAtTime(peak, startsAt + Math.min(0.012, spec.durationMs / 4000));
      gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
      oscillator.connect(gain);
      gain.connect(context.destination);
      const voice: Voice = { oscillator, gain };
      oscillator.onended = () => this.release(voice);
      this.voices.add(voice);
      oscillator.start(startsAt);
      oscillator.stop(endsAt + 0.01);
    } catch {
      if (oscillator) safeDisconnect(oscillator);
      if (gain) safeDisconnect(gain);
    }
  }

  private release(voice: Voice): void {
    voice.oscillator.onended = null;
    safeDisconnect(voice.oscillator);
    safeDisconnect(voice.gain);
    this.voices.delete(voice);
  }
}

export function createWebAudioCampaignOutput(options: WebAudioCampaignOutputOptions = {}): WebAudioCampaignOutput {
  return new WebAudioCampaignOutput(options.contextFactory);
}
