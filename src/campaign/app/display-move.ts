import type { CampaignDisplayInfo, CampaignDisplayState, NativeCampaignHost } from '../native/types';
import { check, parseDisplayState } from '../native/validation';

export interface CampaignDisplayMoveState { native?: CampaignDisplayState; moving: boolean; error?: string }
export interface CampaignDisplayMovePorts {
  /** Synchronously stop input/scheduling, then cancel and await the durable checkpoint. */
  prepare(): Promise<void>;
  bind(state: CampaignDisplayState, display: CampaignDisplayInfo): Promise<void>;
  waitForSurface(display: CampaignDisplayInfo): Promise<void>;
  release(): Promise<void>;
}

/** Moves the fixed owner WebView. It never opens, replaces or settles a Session. */
export class CampaignDisplayController {
  private value: CampaignDisplayMoveState = { moving: false };
  private listeners = new Set<() => void>();
  private attempt?: Promise<boolean>;
  private polling?: Promise<void>;
  private disposed = false;
  private cleanup?: () => void;
  private topologyFailure = '';
  /** Remains latched through errors; only successful native completion releases it. */
  private safetyPaused = false;
  constructor(private readonly host: NativeCampaignHost, private readonly ports: CampaignDisplayMovePorts) {}
  getState(): CampaignDisplayMoveState { return structuredClone(this.value); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private update(patch: Partial<CampaignDisplayMoveState>): void {
    this.value = { ...this.value, ...patch }; for (const listener of this.listeners) listener();
  }
  private live(): void { check(!this.disposed, 'Display controller disposed'); }
  private async prepare(): Promise<void> { this.safetyPaused = true; await this.ports.prepare(); }
  private async prepareFailureOnce(): Promise<void> { if (!this.safetyPaused) await this.prepare(); }
  private async read(): Promise<CampaignDisplayState> {
    const state = parseDisplayState(await this.host.invoke('campaign_display_state')); this.live();
    this.update({ native: state }); return state;
  }
  async start(): Promise<void> {
    await this.refresh(); this.live();
    this.cleanup = this.host.every(1000, () => { void this.refresh(); });
  }
  refresh(): Promise<void> {
    if (this.disposed || this.attempt) return Promise.resolve();
    if (this.polling) return this.polling;
    const previous = this.value.native;
    this.polling = (async () => {
      try {
        const state = await this.read();
        const changed = previous && (previous.bindingGeneration !== state.bindingGeneration || previous.displayId !== state.displayId);
        if (state.phase !== 'ready' || changed) {
          const fingerprint = `${state.bindingGeneration}:${state.topologyRevision}:${state.phase}`;
          if (fingerprint === this.topologyFailure) return;
          this.topologyFailure = fingerprint;
          const recoverTopology = state.phase === 'topology-changed' || state.phase === 'awaiting-surface' || (state.phase === 'ready' && changed);
          if (recoverTopology && state.displayId && state.displays.some(display => display.id === state.displayId)) await this.move(state.displayId);
          else {
            await this.prepareFailureOnce();
            this.update({ error: this.value.error ?? state.error ?? 'Current display disconnected. Select an available display to recover.' });
          }
        }
      } catch (error) {
        if (!this.disposed) {
          try { await this.prepareFailureOnce(); } catch { /* keep the display pause on either failure */ }
          this.update({ error: String(error) });
        }
      }
    })().finally(() => { this.polling = undefined; });
    return this.polling;
  }
  move(targetDisplayId: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.attempt) return this.attempt;
    this.update({ moving: true, error: undefined });
    this.attempt = this.moveOnce(targetDisplayId).finally(() => { this.attempt = undefined; this.update({ moving: false }); });
    return this.attempt;
  }
  private async moveOnce(targetDisplayId: string): Promise<boolean> {
    try {
      await this.prepare(); this.live();
      let state = await this.read();
      check(state.displays.some(display => display.id === targetDisplayId), 'Target display is no longer available');
      // Rust acknowledges retry of an already moved target without incrementing again.
      state = parseDisplayState(await this.host.invoke('campaign_move_display', {
        expectedDisplayId: state.displayId, bindingGeneration: state.bindingGeneration,
        topologyRevision: state.topologyRevision, targetDisplayId,
      }));
      this.live(); this.update({ native: state });
      check(state.displayId === targetDisplayId && ['awaiting-surface', 'ready'].includes(state.phase), state.error ?? 'Native display move failed');
      const display = state.displays.find(candidate => candidate.id === targetDisplayId);
      check(display, 'Target display disappeared during move');
      await this.ports.bind(state, display); this.live();
      await this.ports.waitForSurface(display); this.live();
      const completed = parseDisplayState(await this.host.invoke('campaign_complete_display_move', {
        displayId: state.displayId, bindingGeneration: state.bindingGeneration,
      }));
      this.live(); this.update({ native: completed });
      check(completed.phase === 'ready' && completed.displayId === state.displayId && completed.bindingGeneration === state.bindingGeneration, 'Display binding changed before completion');
      await this.ports.release(); this.safetyPaused = false; this.topologyFailure = ''; this.update({ error: undefined }); return true;
    } catch (error) {
      if (!this.disposed) {
        const state = this.value.native;
        if (state?.displayId) {
          try {
            const failed = parseDisplayState(await this.host.invoke('campaign_abort_display_move', { displayId: state.displayId, bindingGeneration: state.bindingGeneration }));
            this.update({ native: failed });
          } catch { /* Rust may already have invalidated this binding; remain paused. */ }
        }
        this.update({ error: String(error) });
      }
      return false;
    }
  }
  dispose(): void { this.disposed = true; this.cleanup?.(); this.listeners.clear(); }
}
