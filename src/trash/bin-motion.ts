/** Reversible lid motion with a short exit grace period to avoid edge chatter. */
export class BinMotion {
  openness = 0;
  private grace = 0;

  step(dt: number, active: boolean, reducedMotion = false): 'open' | 'close' | undefined {
    const elapsed = Math.max(0, Math.min(dt, .05));
    this.grace = active ? .18 : Math.max(0, this.grace - elapsed);
    const target = active || this.grace > 0;
    const before = this.openness;
    const duration = reducedMotion ? .12 : target ? .52 : .44;
    this.openness = Math.max(0, Math.min(1, before + (target ? elapsed : -elapsed) / duration));
    if (before === 0 && this.openness > 0) return 'open';
    if (before > 0 && this.openness === 0) return 'close';
    return undefined;
  }

  /** Smooth acceleration/deceleration without overshooting the mechanical hinge. */
  get pose(): number {
    return this.openness * this.openness * (3 - 2 * this.openness);
  }
}
