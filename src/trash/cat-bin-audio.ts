export type CatBinSound = "open" | "close" | "receive";

type ContextConstructor = typeof AudioContext;

interface ActiveVoice {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}

const SOUND_URLS: Readonly<Record<CatBinSound, string>> = Object.freeze({
  open: "/game/props/cat-bin-open.wav",
  close: "/game/props/cat-bin-close.wav",
  receive: "/game/props/cat-bin-receive.wav",
});

const CUE_COOLDOWN_MS: Readonly<Record<CatBinSound, number>> = Object.freeze({
  open: 420,
  close: 280,
  receive: 140,
});

const GLOBAL_COOLDOWN_MS = 105;
const RESUMED_PLAY_MAX_AGE_MS = 120;
const OUTPUT_GAIN = 0.34;
const FALLBACK_GAIN = 0.32;

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function createContext(): AudioContext | undefined {
  const host = globalThis as typeof globalThis & { webkitAudioContext?: ContextConstructor };
  const AudioContextClass = host.AudioContext ?? host.webkitAudioContext;
  if (!AudioContextClass) return undefined;
  try { return new AudioContextClass(); } catch { return undefined; }
}

function disconnect(node: AudioNode): void {
  try { node.disconnect(); } catch { /* The browser may already have released it. */ }
}

/**
 * Small, self-contained audio player for the cat-shaped recycle bin.
 *
 * Call unlock() from pointerdown whenever possible. Hover playback also attempts
 * to resume WebAudio for native webviews that allow it, but browser autoplay
 * policy may still keep the context suspended until a user activation.
 */
export class CatBinAudio {
  private isEnabled = true;
  private outputVolume = 1;
  private context?: AudioContext;
  private readonly encoded = new Map<CatBinSound, ArrayBuffer>();
  private readonly buffers = new Map<CatBinSound, AudioBuffer>();
  private readonly decoding = new Set<CatBinSound>();
  private readonly fallback = new Map<CatBinSound, HTMLAudioElement>();
  private readonly voices = new Set<ActiveVoice>();
  private readonly lastCueAt = new Map<CatBinSound, number>();
  private lastPlayedAt = Number.NEGATIVE_INFINITY;
  private lastResumeAttemptAt = Number.NEGATIVE_INFINITY;
  private generation = 0;
  private disposed = false;

  constructor() {
    this.context = createContext();
    for (const sound of Object.keys(SOUND_URLS) as CatBinSound[]) {
      void this.load(sound).catch(() => undefined);
    }
  }

  get enabled(): boolean { return this.isEnabled; }

  set enabled(value: boolean) {
    const enabled = Boolean(value);
    if (enabled === this.isEnabled) return;
    this.isEnabled = enabled;
    this.generation += 1;
    if (!enabled) this.stopAll();
  }

  get volume(): number { return this.outputVolume; }

  set volume(value: number) {
    const volume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    if (volume === this.outputVolume) return;
    this.outputVolume = volume;
    if (volume === 0) {
      this.generation += 1;
      this.stopAll();
    } else {
      for (const voice of this.voices) {
        try { voice.gain.gain.setValueAtTime(OUTPUT_GAIN * volume, voice.gain.context.currentTime); } catch { /* Voice may have ended. */ }
      }
    }
    for (const audio of this.fallback.values()) audio.volume = FALLBACK_GAIN * volume;
  }

  play(sound: CatBinSound): void {
    if (!this.isEnabled || this.outputVolume <= 0 || this.disposed) return;
    const context = this.ensureContext();
    const buffer = this.buffers.get(sound);

    if (context && buffer) {
      if (context.state === "running") {
        this.startBuffer(context, sound, buffer);
        return;
      }
      this.tryResumeForRecentPlay(context, sound);
      return;
    }

    if (context && context.state !== "closed") this.tryResumeForRecentPlay(context, sound);
    this.playFallback(sound);
  }

  /** Retry this from each pointerdown; user activation rules vary by browser/webview. */
  unlock(): void {
    if (this.disposed) return;
    const context = this.ensureContext();
    if (!context || context.state === "closed") return;
    this.decodeAvailable();
    if (context.state === "running") return;
    try {
      void context.resume().then(() => this.decodeAvailable()).catch(() => undefined);
    } catch { /* Autoplay policy can reject synchronously in some embedded hosts. */ }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.stopAll();
    this.encoded.clear();
    this.buffers.clear();
    this.decoding.clear();
    this.fallback.clear();
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== "closed") {
      try { void context.close().catch(() => undefined); } catch { /* Optional backend teardown. */ }
    }
  }

  private ensureContext(): AudioContext | undefined {
    if (!this.context || this.context.state === "closed") {
      this.context = createContext();
      this.decodeAvailable();
    }
    return this.context;
  }

  private async load(sound: CatBinSound): Promise<void> {
    try {
      const response = await fetch(SOUND_URLS[sound]);
      if (!response.ok || this.disposed) return;
      const bytes = await response.arrayBuffer();
      if (this.disposed) return;
      this.encoded.set(sound, bytes);
      this.decode(sound);
    } catch { /* Missing assets leave a silent, retry-safe player. */ }
  }

  private decodeAvailable(): void {
    for (const sound of this.encoded.keys()) this.decode(sound);
  }

  private decode(sound: CatBinSound): void {
    const context = this.context;
    const bytes = this.encoded.get(sound);
    if (this.disposed || !context || context.state === "closed" || !bytes || this.buffers.has(sound) || this.decoding.has(sound)) return;
    this.decoding.add(sound);
    try {
      void context.decodeAudioData(bytes.slice(0)).then((buffer) => {
        if (!this.disposed && this.context === context && context.state !== "closed") this.buffers.set(sound, buffer);
      }).catch(() => undefined).finally(() => this.decoding.delete(sound));
    } catch {
      this.decoding.delete(sound);
    }
  }

  private tryResumeForRecentPlay(context: AudioContext, sound: CatBinSound): void {
    const requestedAt = monotonicNow();
    if (requestedAt - this.lastResumeAttemptAt < 250) return;
    this.lastResumeAttemptAt = requestedAt;
    const generation = this.generation;
    try {
      void context.resume().then(() => {
        this.decodeAvailable();
        const buffer = this.buffers.get(sound);
        if (
          buffer
          && this.isEnabled
          && !this.disposed
          && generation === this.generation
          && context.state === "running"
          && monotonicNow() - requestedAt <= RESUMED_PLAY_MAX_AGE_MS
        ) this.startBuffer(context, sound, buffer);
      }).catch(() => undefined);
    } catch { /* A blocked hover resume is expected under strict autoplay policy. */ }
  }

  private canStart(sound: CatBinSound, now: number): boolean {
    if (!this.isEnabled || this.outputVolume <= 0 || this.disposed || now - this.lastPlayedAt < GLOBAL_COOLDOWN_MS) return false;
    return now - (this.lastCueAt.get(sound) ?? Number.NEGATIVE_INFINITY) >= CUE_COOLDOWN_MS[sound];
  }

  private markStarted(sound: CatBinSound, now: number): void {
    this.lastPlayedAt = now;
    this.lastCueAt.set(sound, now);
  }

  private startBuffer(context: AudioContext, sound: CatBinSound, buffer: AudioBuffer): void {
    const now = monotonicNow();
    if (!this.canStart(sound, now)) return;
    let source: AudioBufferSourceNode | undefined;
    let gain: GainNode | undefined;
    try {
      source = context.createBufferSource();
      gain = context.createGain();
      source.buffer = buffer;
      gain.gain.setValueAtTime(OUTPUT_GAIN * this.outputVolume, context.currentTime);
      source.connect(gain);
      gain.connect(context.destination);
      const voice: ActiveVoice = { source, gain };
      source.onended = () => this.releaseVoice(voice);
      this.voices.add(voice);
      source.start();
      this.markStarted(sound, now);
    } catch {
      if (source) disconnect(source);
      if (gain) disconnect(gain);
    }
  }

  private playFallback(sound: CatBinSound): void {
    if (typeof Audio === "undefined") return;
    const now = monotonicNow();
    if (!this.canStart(sound, now)) return;
    let audio = this.fallback.get(sound);
    try {
      if (!audio) {
        audio = new Audio(SOUND_URLS[sound]);
        audio.preload = "auto";
        audio.volume = FALLBACK_GAIN * this.outputVolume;
        this.fallback.set(sound, audio);
      }
      audio.currentTime = 0;
      const generation = this.generation;
      const playback = audio.play();
      this.markStarted(sound, now);
      if (playback) {
        void playback.then(() => {
          if (!this.isEnabled || this.disposed || generation !== this.generation) {
            audio?.pause();
            if (audio) audio.currentTime = 0;
          }
        }).catch(() => undefined);
      }
    } catch { /* HTMLAudio fallback may also be blocked until pointerdown. */ }
  }

  private stopAll(): void {
    for (const voice of [...this.voices]) {
      voice.source.onended = null;
      try { voice.source.stop(); } catch { /* A stopped source cannot be stopped twice. */ }
      this.releaseVoice(voice);
    }
    for (const audio of this.fallback.values()) {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch { /* The media backend may already be gone. */ }
    }
  }

  private releaseVoice(voice: ActiveVoice): void {
    voice.source.onended = null;
    disconnect(voice.source);
    disconnect(voice.gain);
    this.voices.delete(voice);
  }
}
