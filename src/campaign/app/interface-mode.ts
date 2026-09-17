import type { NativeCampaignHost, Unlisten } from '../native/types';

/** Requests Rust window policy. Never fabricates a trusted event or unlocks audio. */
export class CampaignInterfaceMode {
  private active = false;
  private disposed = false;
  private tail: Promise<void> = Promise.resolve();
  private cleanup: Unlisten[] = [];
  private disposal?: Promise<void>;
  private pendingEnable = false;
  private requestSequence = 0;
  private presentedHasRun?: boolean;
  constructor(private readonly host: NativeCampaignHost, private readonly changed: (enabled: boolean) => void,
    private readonly error: (message: string) => void) {}
  get enabled(): boolean { return this.active; }
  async start(): Promise<void> {
    const unlisten = await this.host.listen('campaign://interface-mode', value => {
      if (!this.disposed && typeof value === 'boolean') { this.pendingEnable = false; this.active = value; this.changed(value); }
    });
    if (this.disposed) { unlisten(); return; }
    this.cleanup.push(unlisten, this.host.onLifecycle(event => {
      if ((this.active || this.pendingEnable) && ['escape', 'blur', 'hidden'].includes(event)) void this.set(false);
    }));
  }
  set(enabled: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const sequence = ++this.requestSequence;
    this.pendingEnable = enabled;
    const operation = this.tail.then(async () => {
      if (this.disposed && enabled) return;
      try { await this.host.invoke('campaign_set_interface_mode', { enabled }); }
      catch (error) { if (this.requestSequence === sequence) this.pendingEnable = false; throw error; }
    });
    this.tail = operation.catch(error => { if (!this.disposed) this.error(`界面交互切换失败：${String(error)}`); });
    return this.tail;
  }
  /** Applies the native window policy only when presentation crosses the lobby/run boundary.
   * Lifecycle and manual disables deliberately leave this edge marker intact, so a repeated
   * lobby refresh cannot reclaim focus after Escape, blur, or an explicit return to desktop. */
  presentation(hasRun: boolean): Promise<void> {
    if (this.disposed || this.presentedHasRun === hasRun) return Promise.resolve();
    this.presentedHasRun = hasRun;
    return this.set(!hasRun);
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true; this.active = false;
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.disposal = this.tail.then(async () => {
      await this.host.invoke('campaign_set_interface_mode', { enabled: false });
    }).catch(error => this.error(`恢复桌面穿透失败：${String(error)}`));
    return this.disposal;
  }
}
