import * as THREE from 'three';
import species from '../../../assets/game/germanica/manifest.json';
import props from '../../../assets/game/props/manifest.json';
import { CampaignModelCache, DEFAULT_CAMPAIGN_RESOURCES, type CampaignResourceRegistry, type LoadedModel } from './resources';
import { setVatFrame, type VatAnimation } from '../../game/vat';
import { CampaignVatCache, type CampaignVatOptions, type CampaignVatSource } from './vat-source';

export type CrowdQuality = 'low' | 'medium' | 'high';
export interface CrowdItem {
  readonly id: string;
  readonly kind: 'trash' | 'egg' | 'bug' | 'elite' | 'nest' | 'corpse';
  readonly x: number; readonly y: number;
  readonly previousX: number; readonly previousY: number;
  readonly hp: number; readonly maxHp: number; readonly behavior: string;
  readonly stage?: 'none' | 'egg' | 'small' | 'medium' | 'adult';
  readonly heading?: number;
  readonly carriedEgg?: boolean;
  readonly action?: 'feeding' | 'mating' | 'laying';
  readonly actionElapsed?: number;
  readonly foodFraction?: number;
  /** Upstream ledger only. V4 has no crowd-block domain entity: never expand this into objects. */
  readonly count?: number;
}
export interface CampaignCrowdOptions {
  /** Production owns animated objective instances outside the mobile crowd. */
  externalNests?: boolean;
  onDiagnostic?: (message: string) => void;
  loader?: (url: string) => Promise<LoadedModel>;
  resources?: CampaignResourceRegistry;
  /** Enabled by default. CPU fixture loaders can explicitly opt out. */
  vat?: false | CampaignVatOptions;
}
interface Part { geometry: THREE.BufferGeometry; material: THREE.Material[] }
interface Source { parts: Part[]; placeholder: boolean; clips: readonly string[]; vat?: CampaignVatSource }
interface DisplaySlot { item: CrowdItem; offsetX: number; offsetY: number; detail: number; phase: number }
interface Chunk { meshes: THREE.InstancedMesh[]; animations: Array<VatAnimation | undefined> }
interface Batch {
  kind: CrowdItem['kind']; lod: 'lod1' | 'lod2'; source: Source;
  variant?: number;
  items: CrowdItem[]; slots: Record<CrowdQuality, DisplaySlot[]>; chunks: Chunk[]; sizeDip: number; unitLength: number;
}
interface CrowdMotion {
  x: number; y: number;
  dx: number; dy: number;
  pendingMovement: boolean;
  lastMovedAt: number;
  action?: CrowdItem['action'];
  actionElapsed: number;
  actionUpdatedAt: number;
  pendingAction: boolean;
}
// Ecology moves at 10 Hz while presentation is submitted at 60 Hz. Preserve
// locomotion through the intervening unchanged snapshots, then settle to Idle.
const CRAWL_HOLD_SECONDS = 0.15;
const CHUNK_SIZE = 256;
const KINDS: readonly CrowdItem['kind'][] = ['trash', 'egg', 'bug', 'elite', 'nest', 'corpse'];
const ADULT = species.forms.adult;
const EGG = species.forms.ootheca;
const FOODS = props.foods;

function stableIdHash(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return hash >>> 0;
}

/** Stable across frames and save/load because the persistent entity ID is the only input. */
export function trashVariantForId(id: string, variantCount = FOODS.length): number {
  if (!Number.isSafeInteger(variantCount) || variantCount < 1) throw new Error('Invalid trash variant count');
  return stableIdHash(id) % variantCount;
}

function ensureDrawableGroups(geometry: THREE.BufferGeometry, materialCount: number): void {
  const drawCount = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
  if (!(drawCount > 0) || !Number.isSafeInteger(drawCount)) throw new Error('Crowd GLB geometry has no finite draw range');
  // InstancedMesh receives a material array so VAT can clone/bind a uniform
  // material contract. Three only renders array materials through groups.
  // GLTFLoader commonly emits one material and no groups for one primitive.
  if (materialCount === 1) {
    geometry.clearGroups(); geometry.addGroup(0, drawCount, 0);
  } else if (!geometry.groups.length) {
    geometry.addGroup(0, drawCount, 0);
  }
}

/** Owns only crowd nodes in the caller's scene; no canvas, camera, simulation or domain writes.
 * The legacy GLB LODs use verified VAT sources with isolated per-chunk frame attributes.
 * Missing/invalid VAT retains the GLB's static bind pose and emits a diagnostic.
 * No shadow maps are requested at any quality. Counts >1 draw bounded representative
 * details only: their ledger remains one upstream record, never new domain objects.
 */
export class CampaignCrowdRenderer {
  private readonly cache: CampaignModelCache;
  private readonly vatCache: CampaignVatCache | undefined;
  private readonly batches: Batch[] = [];
  private readonly sources = new Set<Source>();
  private readonly transform = new THREE.Object3D();
  private readonly resources: CampaignResourceRegistry;
  private readonly completion: Promise<void>;
  private disposed = false;
  private readonly motion = new Map<string, CrowdMotion>();
  private lastRenderTime = -Infinity;

  constructor(private readonly scene: THREE.Scene, private readonly options: CampaignCrowdOptions = {}) {
    this.cache = new CampaignModelCache(options.loader);
    this.resources = options.resources ?? DEFAULT_CAMPAIGN_RESOURCES;
    this.vatCache = options.vat === false ? undefined : new CampaignVatCache(options.vat);
    const nest = this.resources['nest.demo'];
    for (const kind of KINDS) {
      const liveModel = kind === 'bug' || kind === 'elite' || kind === 'corpse';
      const source = this.placeholder(kind);
      if (kind === 'trash') {
        for (let variant = 0; variant < FOODS.length; variant++) this.batches.push({ kind, lod: 'lod1', variant, source,
          items: [], slots: { high: [], medium: [], low: [] }, chunks: [], sizeDip: FOODS[variant].bodyLengthDip, unitLength: 1 });
        continue;
      }
      const sizeDip = kind === 'egg' ? species.appearance.eggSizeDip
        : kind === 'nest' ? nest?.heightDip ?? 52 : species.display.bodyLengthDip * (kind === 'elite' ? 1.35 : 1);
      for (const lod of (liveModel ? ['lod1', 'lod2'] : ['lod1']) as Array<'lod1' | 'lod2'>) {
        this.batches.push({ kind, lod, source, items: [], slots: { high: [], medium: [], low: [] }, chunks: [], sizeDip, unitLength: 1 });
      }
    }
    if (!this.vatCache) this.diagnostic('Campaign crowd VAT explicitly disabled; using static legacy GLB LODs.');
    if (!nest) this.diagnostic('Campaign nest asset unavailable; development placeholder retained: registry has no nest.demo');
    // All loads and promise allocation happen once, outside the render loop.
    this.completion = this.loadSources();
  }

  ready(): Promise<void> { return this.completion; }

  sync(items: readonly CrowdItem[]): void {
    if (this.disposed) return;
    const ids = new Set<string>();
    // Validate before replacing the previous valid presentation snapshot.
    for (const item of items) {
      if (!item.id || ids.has(item.id) || !KINDS.includes(item.kind)
        || ![item.x, item.y, item.previousX, item.previousY].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
        || !Number.isFinite(item.hp) || !Number.isFinite(item.maxHp) || item.hp < 0 || item.hp > item.maxHp
        || (item.heading !== undefined && !Number.isFinite(item.heading))
        || (item.action !== undefined && !['feeding', 'mating', 'laying'].includes(item.action))
        || (item.actionElapsed !== undefined && (!Number.isFinite(item.actionElapsed) || item.actionElapsed < 0))
        || (item.foodFraction !== undefined && (!Number.isFinite(item.foodFraction) || item.foodFraction < 0 || item.foodFraction > 1))
        || (item.stage !== undefined && !['none', 'egg', 'small', 'medium', 'adult'].includes(item.stage))
        || (item.count !== undefined && (!Number.isSafeInteger(item.count) || item.count < 1))) {
        throw new Error('Invalid campaign crowd snapshot');
      }
      ids.add(item.id);
    }
    const snapshot = items.map(item => ({ ...item }));
    for (const id of this.motion.keys()) if (!ids.has(id)) this.motion.delete(id);
    for (const item of snapshot) {
      let state = this.motion.get(item.id);
      const dx = item.x - (state?.x ?? item.previousX), dy = item.y - (state?.y ?? item.previousY);
      if (!state) {
        state = { x: item.x, y: item.y, dx: 0, dy: 0, pendingMovement: false, lastMovedAt: -Infinity,
          actionElapsed: 0, actionUpdatedAt: 0, pendingAction: false };
        this.motion.set(item.id, state);
      }
      state.x = item.x; state.y = item.y;
      if (state.action !== item.action || state.actionElapsed !== (item.actionElapsed ?? 0)) {
        state.action = item.action; state.actionElapsed = item.actionElapsed ?? 0; state.pendingAction = true;
      }
      if (dx !== 0 || dy !== 0) {
        state.dx = dx; state.dy = dy;
        state.pendingMovement = true;
      }
      if (item.kind !== 'bug' && item.kind !== 'elite' || item.hp <= 0) {
        state.pendingMovement = false; state.lastMovedAt = -Infinity;
      }
    }
    for (const batch of this.batches) {
      batch.items = snapshot.filter(item => item.kind === batch.kind
        && (batch.kind !== 'trash' || batch.variant === trashVariantForId(item.id)));
      this.prepareSlots(batch);
      this.ensureChunks(batch);
    }
  }

  render(alpha: number, widthDip: number, heightDip: number, seconds: number, quality: CrowdQuality): void {
    if (this.disposed) return;
    const fraction = Number.isFinite(alpha) ? Math.max(0, Math.min(alpha, 1)) : 1;
    const width = Number.isFinite(widthDip) ? Math.max(1, widthDip) : 1;
    const height = Number.isFinite(heightDip) ? Math.max(1, heightDip) : 1;
    const time = Number.isFinite(seconds) ? seconds : 0;
    for (const state of this.motion.values()) {
      if (time < this.lastRenderTime) state.lastMovedAt = -Infinity;
      if (state.pendingMovement) { state.lastMovedAt = time; state.pendingMovement = false; }
      if (state.pendingAction || time < this.lastRenderTime) {
        state.actionUpdatedAt = time; state.pendingAction = false;
      }
    }
    this.lastRenderTime = time;
    for (const batch of this.batches) {
      const useLow = quality === 'low' && (batch.kind === 'bug' || batch.kind === 'elite' || batch.kind === 'corpse');
      const visible = batch.lod === (useLow ? 'lod2' : 'lod1');
      const slots = batch.slots[quality];
      for (let chunkIndex = 0; chunkIndex < batch.chunks.length; chunkIndex++) {
        const chunk = batch.chunks[chunkIndex].meshes;
        const animations = batch.chunks[chunkIndex].animations;
        const first = chunkIndex * CHUNK_SIZE;
        const count = Math.min(CHUNK_SIZE, Math.max(0, slots.length - first));
        for (let part = 0; part < chunk.length; part++) {
          chunk[part].visible = visible && count > 0;
          chunk[part].count = count;
          chunk[part].userData.ledger = chunk[part].userData.ledgerByQuality[quality];
          chunk[part].userData.ledgerCount = chunk[part].userData.ledgerCountByQuality[quality];
        }
        if (!visible) continue;
        for (let local = 0; local < count; local++) {
          const slot = slots[first + local], item = slot.item;
          const x = item.previousX + (item.x - item.previousX) * fraction;
          const y = item.previousY + (item.y - item.previousY) * fraction;
          const motion = this.motion.get(item.id)!;
          const dx = motion.dx * width;
          const dy = -motion.dy * height;
          const moving = time - motion.lastMovedAt <= CRAWL_HOLD_SECONDS;
          const activeAction = (item.kind === 'bug' || item.kind === 'elite') && item.hp > 0 ? item.action : undefined;
          const heading = activeAction || dx === 0 && dy === 0 ? -(item.heading ?? -Math.PI / 2) - Math.PI / 2 : Math.atan2(dy, dx) - Math.PI / 2;
          const growthScale = item.stage === 'small' ? 0.42 : item.stage === 'medium' ? 0.7 : 1;
          const foodScale = item.kind === 'trash' ? 0.45 + 0.55 * Math.sqrt(item.foodFraction ?? 1) : 1;
          const scale = batch.sizeDip / batch.unitLength * growthScale * foodScale;
          this.transform.position.set(x * width + slot.offsetX + (item.carriedEgg ? 8 : 0), (1 - y) * height + slot.offsetY + (item.carriedEgg ? 7 : 0), item.carriedEgg ? 8 : 3);
          // Corpse reuses the same GLB, rolled onto its side and held motionless.
          this.transform.rotation.set(0, item.kind === 'corpse' ? Math.PI / 2 : 0, heading, 'ZYX');
          this.transform.scale.setScalar(scale);
          this.transform.updateMatrix();
          for (let part = 0; part < chunk.length; part++) {
            chunk[part].setMatrixAt(local, this.transform.matrix);
            const animation = animations[part];
            if (animation) {
              const clip = item.kind === 'corpse' ? 'SleepLoop' : activeAction === 'feeding' ? 'FeedLoop'
                : activeAction === 'mating' ? 'MatingLoop' : activeAction === 'laying' ? 'Oviposit'
                : !moving ? 'Idle' : item.behavior === 'swift' ? 'Run' : 'Walk';
              const gaitRate = item.stage === 'small' ? 1.35 : item.stage === 'medium' ? 1.15 : 1;
              const actionTime = motion.actionElapsed + Math.max(0, Math.min(0.1, time - motion.actionUpdatedAt));
              setVatFrame(animation, local, clip, item.kind === 'corpse' ? 0 : activeAction ? actionTime : time * gaitRate,
                item.kind === 'corpse' || activeAction ? 0 : slot.phase);
            }
          }
        }
        for (let part = 0; part < chunk.length; part++) {
          chunk[part].instanceMatrix.needsUpdate = true;
          const animation = animations[part];
          if (animation) animation.attribute.needsUpdate = true;
        }
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const batch of this.batches) this.clearChunks(batch);
    for (const source of this.sources) {
      for (const part of source.parts) {
        part.geometry.dispose();
        for (const material of part.material) material.dispose();
      }
    }
    this.sources.clear();
    this.motion.clear();
    this.vatCache?.dispose();
    this.cache.dispose();
  }

  private diagnostic(message: string): void {
    // A diagnostic listener must not turn a recoverable asset failure into an unhandled rejection.
    try { this.options.onDiagnostic?.(message); } catch { /* presentation diagnostics are best effort */ }
  }

  private placeholder(kind: CrowdItem['kind']): Source {
    const geometry = kind === 'nest' ? new THREE.ConeGeometry(0.5, 0.4, 6) : new THREE.BoxGeometry(0.45, 1, 0.2);
    const material = new THREE.MeshStandardMaterial({ color: kind === 'nest' ? 0x905473 : 0xe08fdb, roughness: 1 });
    ensureDrawableGroups(geometry, 1);
    const source = { parts: [{ geometry, material: [material] }], placeholder: true, clips: [] };
    this.sources.add(source);
    return source;
  }

  private async loadSources(): Promise<void> {
    const paths: Array<{ url: string; kind: 'bug' | 'egg' | 'trash' | 'nest'; lod: 'lod1' | 'lod2'; unit: number; rotate: boolean; variant?: number; requiredClips?: readonly string[] }> = [
      { url: `/game/germanica/${ADULT.lods.lod1}`, kind: 'bug', lod: 'lod1', unit: ADULT.display.bodyLengthModel, rotate: true },
      { url: `/game/germanica/${ADULT.lods.lod2}`, kind: 'bug', lod: 'lod2', unit: ADULT.display.bodyLengthModel, rotate: true },
      { url: `/game/germanica/${EGG.lods.lod1}`, kind: 'egg', lod: 'lod1', unit: EGG.display.bodyLengthModel, rotate: true },
      ...FOODS.map((food, variant) => ({ url: `/game/props/${food.states.full}`, kind: 'trash' as const,
        lod: 'lod1' as const, unit: food.bodyLengthModel, rotate: true, variant })),
    ];
    const nest = this.resources['nest.demo'];
    if (nest && !this.options.externalNests) {
      if (!(nest.modelHeight && Number.isFinite(nest.modelHeight) && nest.modelHeight > 0)) {
        this.diagnostic('Campaign nest asset unavailable; development placeholder retained: nest.demo has no finite normalization span');
      } else {
        paths.push({ url: nest.url, kind: 'nest', lod: 'lod1', unit: nest.modelHeight, rotate: false, requiredClips: ['idle', 'pulse'] });
      }
    }
    await Promise.all(paths.map(async asset => {
      try {
        const loaded = await this.cache.load(asset.url);
        if (this.disposed) return;
        if (asset.requiredClips) {
          const available = new Set(loaded.animations.map(clip => clip.name));
          const missing = asset.requiredClips.filter(clip => !available.has(clip));
          if (missing.length) throw new Error(`GLB is missing required clips: ${missing.join(', ')}`);
        }
        const source = this.extract(loaded.scene, loaded.animations, asset.rotate);
        this.sources.add(source);
        if (asset.kind === 'bug' && this.vatCache) {
          try {
            source.vat = await this.vatCache.load(`/game/germanica/${ADULT.crowd.metadata}`, asset.lod, loaded.scene, asset.url);
          } catch (error) {
            if (!this.disposed) this.diagnostic(`Campaign crowd VAT unavailable; static GLB retained: ${asset.url}: ${String(error)}`);
          }
          if (this.disposed) return;
        }
        for (const batch of this.batches) {
          const match = asset.kind === 'bug' ? batch.kind === 'bug' || batch.kind === 'elite' || batch.kind === 'corpse' : batch.kind === asset.kind;
          if (!match || batch.lod !== asset.lod || (asset.kind === 'trash' && batch.variant !== asset.variant)) continue;
          const previousSource = batch.source, previousUnit = batch.unitLength, previousChunks = batch.chunks;
          batch.source = source; batch.unitLength = asset.unit; batch.chunks = [];
          try { this.ensureChunks(batch); }
          catch (error) {
            this.clearChunks(batch);
            batch.source = previousSource; batch.unitLength = previousUnit; batch.chunks = previousChunks;
            throw error;
          }
          for (const chunk of previousChunks) this.releaseChunk(chunk);
        }
        if (asset.kind === 'nest') this.diagnostic(`Campaign nest loaded as static instanced mesh; authored clips available: ${source.clips.join(', ')}`);
      } catch (error) {
        if (!this.disposed) this.diagnostic(`Campaign crowd asset unavailable; development placeholder retained: ${asset.url}: ${String(error)}`);
      }
    }));
  }

  private extract(model: THREE.Group, animations: readonly THREE.AnimationClip[], rotateForScreen: boolean): Source {
    const parts: Part[] = [];
    const rotate = rotateForScreen ? new THREE.Matrix4().makeRotationX(Math.PI / 2) : undefined;
    model.updateMatrixWorld(true);
    try {
      model.traverse(node => {
        if (!(node instanceof THREE.Mesh)) return;
        const part: Part = { geometry: node.geometry.clone(), material: [] };
        // Register immediately so a malformed source cannot leak partially cloned parts.
        parts.push(part);
        part.geometry.applyMatrix4(node.matrixWorld);
        if (rotate) part.geometry.applyMatrix4(rotate);
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) part.material.push(material.clone());
        ensureDrawableGroups(part.geometry, part.material.length);
      });
      if (!parts.length) throw new Error('Legacy GLB contains no mesh');
    } catch (error) {
      for (const part of parts) {
        part.geometry.dispose();
        for (const material of part.material) material.dispose();
      }
      throw error;
    }
    return { parts, placeholder: false, clips: animations.map(clip => clip.name) };
  }

  private ensureChunks(batch: Batch): void {
    const needed = Math.ceil(batch.slots.high.length / CHUNK_SIZE);
    while (batch.chunks.length < needed) {
      batch.chunks.push(this.createChunk(batch));
    }
    while (batch.chunks.length > needed) {
      this.releaseChunk(batch.chunks.pop()!);
    }
    for (let index = 0; index < batch.chunks.length; index++) {
      const ledgerByQuality = { high: [], medium: [], low: [] } as Record<CrowdQuality, Array<{ id: string; count: number }>>;
      const ledgerCountByQuality = { high: 0, medium: 0, low: 0 };
      for (const quality of ['high', 'medium', 'low'] as const) {
        const ledger = batch.slots[quality].slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
          .filter(slot => slot.detail === 0).map(slot => ({ id: slot.item.id, count: slot.item.count ?? 1 }));
        ledgerByQuality[quality] = ledger;
        ledgerCountByQuality[quality] = ledger.reduce((sum, item) => sum + item.count, 0);
      }
      for (const mesh of batch.chunks[index].meshes) {
        mesh.userData.ledgerByQuality = ledgerByQuality;
        mesh.userData.ledgerCountByQuality = ledgerCountByQuality;
      }
    }
  }

  private clearChunks(batch: Batch): void {
    for (const chunk of batch.chunks) this.releaseChunk(chunk);
    batch.chunks.length = 0;
  }

  private createChunk(batch: Batch): Chunk {
    const chunk: Chunk = { meshes: [], animations: [] };
    let pendingGeometry: THREE.BufferGeometry | undefined;
    let pendingMaterials: THREE.Material[] = [];
    try {
      for (const part of batch.source.parts) {
        // Record ownership before binding: even a failing adapter cannot leak clones.
        if (batch.source.vat) {
          pendingGeometry = part.geometry.clone();
          for (const material of part.material) pendingMaterials.push(material.clone());
        }
        const mesh = new THREE.InstancedMesh(pendingGeometry ?? part.geometry, batch.source.vat ? pendingMaterials : part.material, CHUNK_SIZE);
        mesh.userData.ownsGeometryMaterial = Boolean(batch.source.vat);
        chunk.meshes.push(mesh);
        pendingGeometry = undefined; pendingMaterials = [];
        chunk.animations.push(batch.source.vat?.attach(mesh));
        mesh.name = `campaign-crowd:${batch.kind}${batch.variant === undefined ? '' : `:variant-${batch.variant}`}:${batch.lod}`;
        mesh.frustumCulled = false; mesh.count = 0; mesh.visible = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.userData.developmentPlaceholder = batch.source.placeholder;
        mesh.userData.animation = batch.source.vat ? 'verified-vat'
          : batch.source.clips.length ? 'static-authored-clips' : 'static-bind-pose';
        mesh.userData.availableAnimations = [...batch.source.clips];
        this.scene.add(mesh);
      }
      return chunk;
    } catch (error) {
      pendingGeometry?.dispose();
      for (const material of pendingMaterials) material.dispose();
      this.releaseChunk(chunk);
      throw error;
    }
  }

  private releaseChunk(chunk: Chunk): void {
    for (const mesh of chunk.meshes) {
      this.scene.remove(mesh); mesh.dispose();
      if (mesh.userData.ownsGeometryMaterial) {
        mesh.geometry.dispose();
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
      }
    }
    for (const animation of chunk.animations) animation?.dispose();
  }

  private prepareSlots(batch: Batch): void {
    for (const quality of ['high', 'medium', 'low'] as const) {
      const slots: DisplaySlot[] = [];
      for (const item of batch.items) {
        const phase = stableIdHash(item.id) / 4294967296;
        const count = Math.min(item.count ?? 1, quality === 'high' ? 12 : quality === 'medium' ? 6 : 2);
        for (let detail = 0; detail < count; detail++) {
          const angle = detail * 2.39996323 + phase * Math.PI * 2;
          const radius = detail === 0 ? 0 : Math.sqrt(detail) * batch.sizeDip * 0.24;
          slots.push({ item, detail, phase: (phase + detail * 0.137) % 1, offsetX: Math.cos(angle) * radius, offsetY: Math.sin(angle) * radius });
        }
      }
      batch.slots[quality] = slots;
    }
  }
}
