import * as THREE from 'three';
import type { CampaignRenderSource } from './mapping';

export type BagFill = 'empty' | 'half_full' | 'full';
export interface BagPresentation { readonly load: number; readonly capacity: number; readonly fill: BagFill; readonly collected: boolean }
export interface VisualFeedback {
  readonly bag: BagPresentation;
  readonly repairs: readonly string[];
  readonly hits: ReadonlyArray<{ id: string; targetId: string; x: number; y: number }>;
  readonly nestDeaths: ReadonlySet<string>;
}

/** Retains scalar comparison baselines only. No run, authority or callback is held. */
export class CampaignVisualObserver {
  private runId = '';
  private tick = 0;
  private load = 0;
  private commands = new Set<string>();
  private kills = new Set<string>();
  private houses = new Map<string, { repaired: boolean; hp: number }>();

  observe(run: CampaignRenderSource): VisualFeedback {
    const fresh = this.runId !== run.runId || run.tick < this.tick;
    const capacity = run.inventory.containers.playerBag?.capacity ?? 0;
    let load = 0;
    for (const item of Object.values(run.inventory.objects)) if (item.owner === 'playerBag') load += item.weight;
    // partial is a visual category, not an invented 50% capacity rule. sealed in
    // V4 means incubation isolation and is true even for an empty player bag.
    const fill: BagFill = load <= 0 ? 'empty' : load >= capacity ? 'full' : 'half_full';
    const repairs: string[] = [], hits: Array<{ id: string; targetId: string; x: number; y: number }> = [];
    const nestDeaths = new Set<string>();
    for (const house of run.houses) {
      const before = this.houses.get(house.id);
      // Repaired is the one-use authority marker. Several fixed steps can be
      // coalesced into one submit, so later siege damage may erase the HP gain.
      if (!fresh && before && !before.repaired && house.repaired) repairs.push(house.id);
    }
    for (const [id, receipt] of Object.entries(run.inventory.commands)) {
      if (fresh || this.commands.has(id) || !receipt.ok || !id.startsWith('swat:')) continue;
      try {
        const signature: unknown = JSON.parse(receipt.signature);
        if (!Array.isArray(signature) || signature.length !== 4 || signature[0] !== 'damage'
          || typeof signature[1] !== 'string' || !id.endsWith(`:${signature[1]}`)) continue;
        const item = run.inventory.objects[signature[1]];
        if (item) hits.push({ id, targetId: item.id, x: item.x, y: item.y });
      } catch { /* A malformed optional visual receipt must not interrupt presentation. */ }
    }
    for (const event of run.economy.events) {
      if (!fresh && !this.kills.has(event.id) && event.kind === 'kill' && event.enemy === 'nest') nestDeaths.add(event.targetId);
    }
    const bag = { load, capacity, fill, collected: !fresh && load > this.load };
    this.runId = run.runId; this.tick = run.tick; this.load = load;
    this.commands = new Set(Object.keys(run.inventory.commands));
    this.kills = new Set(run.economy.events.map(event => event.id));
    this.houses = new Map(run.houses.map(house => [house.id, { repaired: house.repaired, hp: house.hp }]));
    return { bag, repairs, hits, nestDeaths };
  }
  clear(): void { this.runId = ''; this.tick = 0; this.load = 0; this.commands.clear(); this.kills.clear(); this.houses.clear(); }
}

/** Bounded, original development VFX. No particle carries gameplay state. */
export class CampaignFeedbackMark {
  readonly root = new THREE.Group();
  private elapsed = 0;
  private readonly material: THREE.LineBasicMaterial;
  private readonly geometry: THREE.BufferGeometry;
  constructor(readonly kind: 'hit' | 'repair' | 'electric', readonly duration: number) {
    this.root.name = `feedback:${kind}`;
    this.root.userData.developmentPlaceholder = true;
    this.root.userData.artApproved = false;
    this.root.userData.visualOnly = true;
    const points: number[] = [];
    const count = kind === 'electric' ? 3 : 6;
    for (let i = 0; i < count; i++) {
      const angle = i * Math.PI * 2 / count;
      const inner = kind === 'electric' ? 2 : 4, outer = kind === 'repair' ? 14 : 10;
      points.push(Math.cos(angle) * inner, Math.sin(angle) * inner, 0, Math.cos(angle + 0.2) * outer, Math.sin(angle + 0.2) * outer, 0);
    }
    this.geometry = new THREE.BufferGeometry(); this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.material = new THREE.LineBasicMaterial({ color: kind === 'repair' ? 0x92dbbd : 0x78dcec, transparent: true, opacity: 0.85, depthTest: false });
    const lines = new THREE.LineSegments(this.geometry, this.material); lines.renderOrder = 10; this.root.add(lines);
  }
  get finished(): boolean { return this.elapsed >= this.duration; }
  update(delta: number, detailed: boolean): void {
    this.elapsed += delta;
    const progress = this.duration === Infinity ? 0 : Math.min(1, this.elapsed / this.duration);
    // A steady non-flashing mark remains when detailed effects are disabled.
    this.root.scale.setScalar(detailed ? 1 + progress * 0.35 : 1);
    this.material.opacity = detailed ? 0.85 * (1 - progress) : 0.65;
  }
  dispose(): void { this.root.removeFromParent(); this.geometry.dispose(); this.material.dispose(); }
}
