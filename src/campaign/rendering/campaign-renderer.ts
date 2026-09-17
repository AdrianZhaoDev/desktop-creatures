import * as THREE from 'three';
import type { CampaignPhase } from '../campaign-controller';
import type { GraphicsQuality } from '../campaign-settings';
import { deriveRunAttributes } from '../economy';
import nestManifest from '../../../assets/steam-v1/s07-s09/demo-main-nest/manifest.json';
import { deriveHomeVisualState } from '../homes';
import { ECOLOGY_CYCLE } from '../ecology-cycle-types';
import { CampaignCrowdRenderer, type CrowdItem } from './crowd';
import { CampaignModelVisual } from './model-visual';
import { CampaignFeedbackMark, CampaignVisualObserver, type BagPresentation } from './visual-feedback';
import { CampaignModelCache, DEFAULT_CAMPAIGN_RESOURCES, type CampaignResourceRegistry } from './resources';
import { actorActionIntent, appearanceResourceId, houseHealthFraction, interpolateCoordinate,
  interpolationAlpha, QUALITY_POLICIES, renderPixelRatio, type CampaignRenderSource, type CleanerHeightDip } from './mapping';

export const CAMPAIGN_VISUAL_HEIGHT_DIP = Object.freeze({ house: 160, cleaner: 96, frog: 44 });

/** Injectable GPU boundary; tests use real Three scene objects with a mock backend. */
export interface CampaignRenderBackend {
  setClearColor(color: number, alpha: number): void;
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
  shadowMap: { enabled: boolean; needsUpdate?: boolean };
}
export interface CampaignCrowdPort {
  sync(items: readonly CrowdItem[]): void;
  render(alpha: number, widthDip: number, heightDip: number, seconds: number, quality: GraphicsQuality): void;
  ready(): Promise<void>;
  dispose(): void;
}
export interface CampaignRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly widthDip: number;
  readonly heightDip: number;
  readonly dpiScale?: number;
  readonly quality?: GraphicsQuality;
  readonly cleanerHeightDip?: CleanerHeightDip;
  readonly resources?: CampaignResourceRegistry;
  /** Borrowed caches are never disposed by this renderer; release after all users. */
  readonly cache?: CampaignModelCache;
  readonly createBackend?: (canvas: HTMLCanvasElement) => CampaignRenderBackend;
  readonly createCrowd?: (scene: THREE.Scene, report: (message: string) => void) => CampaignCrowdPort;
  readonly onDiagnostic?: (message: string) => void;
  /** Layout-only dock, supplied by the host. It neither owns input nor inventory. */
  readonly toolDock?: () => { x: number; y: number };
  readonly detailedEffects?: () => boolean;
}
interface VisualRecord {
  readonly key: string; readonly visual: CampaignModelVisual; readonly status: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  readonly health?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  x: number; y: number; previousX: number; previousY: number; seen: number; pointDip?: boolean; facingYaw?: number;
}
interface HomeInteractionState { doorOpen: boolean; propsToken: number }
function defaultBackend(canvas: HTMLCanvasElement): CampaignRenderBackend {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

/**
 * A single transparent scene/camera/backend, driven by externally committed V4 snapshots.
 * submit copies presentation fields. render interpolates those copies and animates GLBs;
 * neither method retains or invokes an authority, hit handler, clock, or inventory writer.
 * Host owns scheduling and must call resize with DIP geometry after window/DPI changes.
 */
export class CampaignRenderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 2000);
  private readonly backend: CampaignRenderBackend;
  private readonly cache: CampaignModelCache;
  private readonly ownsCache: boolean;
  private readonly resources: CampaignResourceRegistry;
  private readonly crowd: CampaignCrowdPort;
  private readonly records = new Map<string, VisualRecord>();
  private readonly homeInteractions = new Map<string, HomeInteractionState>();
  private readonly pending = new Set<Promise<void>>();
  private readonly messages = new Set<string>();
  private readonly sun = new THREE.DirectionalLight(0xfff4e5, 2.4);
  private readonly cleanerHeight: CleanerHeightDip;
  private width = 1;
  private height = 1;
  private dpiScale = 1;
  private quality: GraphicsQuality;
  private disposed = false;
  private lost = false;
  private runId = '';
  private phase: CampaignPhase = 'preparation';
  private paused = true;
  private revision = 0;
  private lastSubmittedTick = -1;
  private previousItems = new Map<string, CrowdItem>();
  private lastSeconds?: number;
  private visualSeconds = 0;
  private readonly observer = new CampaignVisualObserver();
  private bag: BagPresentation = { load: 0, capacity: 0, fill: 'empty', collected: false };
  private bagFillRemaining = 0;
  private readonly nestCompleted = new Set<string>();
  private readonly repairing = new Set<string>();
  private crowdItems: CrowdItem[] = [];
  private readonly feedback = new Map<string, { mark: CampaignFeedbackMark; x: number; y: number; anchorId?: string; anchor?: string }>();
  private readonly anchorPoint = new THREE.Vector3();
  private readonly anchorQuaternion = new THREE.Quaternion();
  private readonly mountOffset = new THREE.Vector3();
  private readonly mountQuaternion = new THREE.Quaternion();
  private readonly mountEuler = new THREE.Euler();
  private readonly contextLost = (event: Event): void => {
    event.preventDefault(); this.lost = true; this.lastSeconds = undefined;
    this.report('WebGL context lost; presentation suspended, authority remains host-owned');
  };
  private readonly contextRestored = (): void => {
    if (this.disposed) return;
    this.lost = false; this.lastSeconds = undefined;
    this.backend.shadowMap.needsUpdate = true;
    this.resize(this.width, this.height, this.dpiScale);
    this.report('WebGL context restored; next render reuses cached resources');
  };
  private readonly report = (message: string): void => {
    if (this.disposed || this.messages.has(message)) return;
    this.messages.add(message);
    try { this.options.onDiagnostic?.(message); } catch { /* Diagnostics cannot break recovery or loading. */ }
  };

  constructor(private readonly options: CampaignRendererOptions) {
    if (![options.widthDip, options.heightDip].every(value => Number.isFinite(value) && value > 0)) throw new Error('Campaign viewport must be positive DIP');
    this.cleanerHeight = options.cleanerHeightDip ?? CAMPAIGN_VISUAL_HEIGHT_DIP.cleaner;
    if (![96, 120, 160].includes(this.cleanerHeight)) throw new Error('Cleaner review height must be 96, 120 or 160 DIP');
    this.quality = options.quality ?? 'medium';
    this.cache = options.cache ?? new CampaignModelCache(); this.ownsCache = !options.cache;
    this.resources = { ...DEFAULT_CAMPAIGN_RESOURCES, ...options.resources };
    this.backend = (options.createBackend ?? defaultBackend)(options.canvas);
    this.backend.setClearColor(0x000000, 0);
    this.camera.position.z = 1000;
    this.scene.add(new THREE.HemisphereLight(0xe6f4ff, 0x6a6b72, 2));
    this.sun.position.set(-200, 400, 600); this.scene.add(this.sun); this.scene.add(this.sun.target);
    this.crowd = options.createCrowd?.(this.scene, this.report)
      ?? new CampaignCrowdRenderer(this.scene, { onDiagnostic: this.report, resources: this.resources, externalNests: true });
    options.canvas.addEventListener('webglcontextlost', this.contextLost);
    options.canvas.addEventListener('webglcontextrestored', this.contextRestored);
    this.resize(options.widthDip, options.heightDip, options.dpiScale ?? 1);
    this.setQuality(this.quality);
  }

  resize(widthDip: number, heightDip: number, dpiScale = this.dpiScale): void {
    if (this.disposed) return;
    if (![widthDip, heightDip, dpiScale].every(value => Number.isFinite(value) && value > 0)) {
      this.report('Ignored invalid/zero resize; retaining last valid DIP viewport'); return;
    }
    this.width = widthDip; this.height = heightDip; this.dpiScale = dpiScale;
    this.camera.left = 0; this.camera.right = widthDip; this.camera.top = heightDip; this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
    this.backend.setPixelRatio(renderPixelRatio(dpiScale, this.quality));
    this.backend.setSize(widthDip, heightDip, false);
    this.options.canvas.style.width = `${widthDip}px`; this.options.canvas.style.height = `${heightDip}px`;
    this.sun.position.set(widthDip * 0.3, heightDip + 300, 600); this.sun.target.position.set(widthDip * 0.5, heightDip * 0.5, 0);
    this.sun.shadow.camera.left = -widthDip; this.sun.shadow.camera.right = widthDip;
    this.sun.shadow.camera.top = heightDip; this.sun.shadow.camera.bottom = -heightDip;
    this.sun.shadow.camera.far = 2500; this.sun.shadow.camera.updateProjectionMatrix();
  }
  setQuality(quality: GraphicsQuality): void {
    if (this.disposed) return;
    this.quality = quality;
    const policy = QUALITY_POLICIES[quality];
    this.backend.shadowMap.enabled = policy.shadows; this.sun.castShadow = policy.shadows;
    this.backend.setPixelRatio(renderPixelRatio(this.dpiScale, quality));
    for (const record of this.records.values()) record.visual.setShadows(policy.shadows);
  }

  interactHome(houseId: string, action: 'door' | 'props' | 'call'): boolean {
    if (this.disposed) return false;
    const record = this.records.get(`house:${houseId}`);
    if (!record || record.visual.root.userData.houseState === 'destroyed') return false;
    const state = this.homeInteractions.get(houseId) ?? { doorOpen: false, propsToken: 0 };
    if (action === 'door') {
      const open = !state.doorOpen;
      if (!record.visual.setControl('door', open || record.visual.root.userData.transitOpen === true)) return false;
      state.doorOpen = open;
    } else if (action === 'call') {
      if (!record.visual.setControl('door', true)) return false;
      state.doorOpen = true;
    } else {
      const token = state.propsToken + 1;
      if (!record.visual.triggerInteraction('props', `${token}`)) return false;
      record.visual.setControl('door', true);
      state.doorOpen = true;
      state.propsToken = token;
    }
    this.homeInteractions.set(houseId, state);
    return true;
  }

  submit(run: CampaignRenderSource): void {
    if (this.disposed) return;
    const freshRun = run.runId !== this.runId || run.tick < this.lastSubmittedTick;
    if (freshRun) {
      this.clearRecords(); this.previousItems.clear(); this.runId = run.runId;
      this.lastSeconds = undefined; this.visualSeconds = 0;
      this.clearFeedback(); this.observer.clear(); this.nestCompleted.clear(); this.repairing.clear(); this.homeInteractions.clear();
      this.bag = { load: 0, capacity: 0, fill: 'empty', collected: false }; this.bagFillRemaining = 0;
    }
    this.lastSubmittedTick = run.tick;
    if (this.paused !== (run.pauseReasons.length > 0)) this.lastSeconds = undefined;
    this.revision++; this.phase = run.phase; this.paused = run.pauseReasons.length > 0;
    const observed = this.observer.observe(run);
    const load = Object.values(run.inventory.objects).reduce((total, item) => item.owner === 'cleanerPack' ? total + item.weight : total, 0);
    const capacity = run.inventory.containers.cleanerPack?.capacity ?? 0;
    this.bag = { load, capacity, fill: load <= 0 ? 'empty' : load >= capacity ? 'full' : 'half_full',
      collected: !freshRun && load > this.bag.load };
    if (this.bag.load <= 0) this.bagFillRemaining = 0;
    else if (this.bag.collected) this.bagFillRemaining = 0.65;
    this.scene.userData.campaignPhase = run.phase;
    for (const actor of run.actors) {
      if (actor.archetype === 'frog' && !run.frogUnlocked) continue;
      const record = this.touch(`actor:${actor.id}`, appearanceResourceId(actor), actor.pose.x, actor.pose.y,
        actor.archetype === 'frog' ? CAMPAIGN_VISUAL_HEIGHT_DIP.frog : this.cleanerHeight, actor.archetype);
      let carrying = false;
      for (const id in run.inventory.objects) if (run.inventory.objects[id].owner === actor.inventoryId) { carrying = true; break; }
      const intent = actorActionIntent(actor, run.phase, carrying);
      record.visual.bind(intent, actor.pose.taskId ?? '');
      record.visual.root.userData.domainId = actor.id;
      record.visual.root.userData.insideHome = actor.atHome;
      record.visual.root.userData.disabled = actor.pose.activity === 'unavailable';
      record.visual.root.visible = actor.pose.activity !== 'unavailable';
      if (Math.abs(actor.pose.vx) > 1e-6) record.facingYaw = actor.pose.vx < 0 ? -Math.PI / 3 : Math.PI / 3;
      record.visual.facing.rotation.y = actor.pose.motion === 'climbing' ? Math.PI : record.facingYaw ?? 0;
      this.status(record, run.phase === 'retreat' || run.phase === 'siege' || run.phase === 'victory' || run.phase === 'defeat');
      if (actor.archetype === 'cleaner') {
        const pack = this.touch(`actor-pack:${actor.id}`, 'tool.bag', actor.pose.x, actor.pose.y, 32);
        pack.visual.root.userData.domainId = actor.id;
        pack.visual.root.userData.containerId = 'cleanerPack';
        pack.visual.root.userData.load = this.bag.load; pack.visual.root.userData.capacity = this.bag.capacity;
        pack.visual.root.userData.mountedTo = `actor:${actor.id}`;
        pack.visual.root.visible = !actor.atHome && actor.pose.activity !== 'unavailable';
        pack.visual.root.scale.setScalar(this.cleanerHeight / CAMPAIGN_VISUAL_HEIGHT_DIP.cleaner);
        pack.visual.bind(this.bagIntent());
      }
    }
    for (const house of run.houses) {
      if (house.id === 'home.frog' && !run.frogUnlocked) continue;
      const state = deriveHomeVisualState(house);
      const resourceId = state === 'intact' ? house.id : `${house.id}.${state}`;
      const record = this.touch(`house:${house.id}`, resourceId, house.x, house.y, CAMPAIGN_VISUAL_HEIGHT_DIP.house, undefined, true,
        // Only intact may use the registered base asset. Every damaged/breached
        // state must load its own art or remain an explicit same-size placeholder.
        state === 'intact' ? house.id : undefined);
      const hp = houseHealthFraction(house);
      record.visual.root.userData.domainId = house.id; record.visual.root.userData.houseState = state;
      record.visual.root.userData.damageStage = state === 'destroyed' ? 3 : state === 'heavy-damaged' ? 2
        : state === 'light-damaged' ? 1 : 0;
      record.visual.root.userData.residentAtHome = run.actors.some(actor => actor.houseId === house.id && actor.atHome);
      record.visual.root.userData.locked = house.locked;
      const resident = run.actors.find(actor => actor.houseId === house.id);
      const autoOpen = resident?.pose.activity === 'entering-home' || resident?.pose.activity === 'exiting-home';
      const interaction = this.homeInteractions.get(house.id);
      record.visual.root.userData.transitOpen = autoOpen;
      record.visual.setControl('door', autoOpen || interaction?.doorOpen === true);
      if (interaction?.propsToken) record.visual.triggerInteraction('props', `${interaction.propsToken}`);
      if (record.health) {
        record.health.visible = hp > 0; record.health.scale.x = hp; record.health.position.x = -60 + 60 * hp;
        record.health.material.color.setHex(hp < 0.4 ? 0xed6856 : hp < 0.7 ? 0xedbb54 : 0x72d1ac);
      }
      this.status(record, run.phase === 'retreat' || run.phase === 'siege' || run.phase === 'victory' || run.phase === 'defeat' || hp <= 0);
    }
    for (const trap of run.traps) {
      const record = this.touch(`trap:${trap.id}`, `trap.${trap.kind}`, trap.x, trap.y, trap.kind === 'ladder' ? this.height * 0.3 : 32);
      record.visual.root.userData.domainId = trap.id;
      record.visual.root.userData.remaining = trap.remaining; record.visual.root.userData.uses = trap.uses;
    }
    // A released hot swatter rests at the dock; persisted (0,0) gesture positions
    // are never replayed. Heat is reversible temperature, never invented wear.
    if (run.swatter.active || run.swatter.heat > 0 || run.swatter.overheated) {
      const record = this.touch('tool:swatter', 'tool.swatter', run.swatter.end.x, run.swatter.end.y, 48);
      record.pointDip = true;
      const state = run.swatter.overheated ? 'overheated' : run.swatter.active ? 'active' : 'idle';
      record.visual.root.userData.overheated = run.swatter.overheated;
      record.visual.root.userData.active = run.swatter.active;
      record.visual.root.userData.heat = run.swatter.heat;
      record.visual.root.userData.durabilityAvailable = false;
      record.visual.bind(state);
      const capacity = deriveRunAttributes(run.upgrades, [...run.researchNodes]).swatHeat;
      const heat = Math.max(0, Math.min(1, run.swatter.heat / capacity));
      record.visual.setMaterialSignal(run.swatter.overheated ? 0xf07e3b : 0x42cadb, run.swatter.overheated ? 0.8 : (run.swatter.active ? 0.22 : 0.03) + heat * 0.3);
      if (run.swatter.active && !run.swatter.overheated) {
        this.addFeedback('electric:swatter', 'electric', Infinity, 0, 0, 'tool:swatter', 'mesh_center');
      } else this.removeFeedback('electric:swatter');
    } else this.removeFeedback('electric:swatter');
    for (const houseId of observed.repairs) {
      this.repairing.add(houseId);
      const house = run.houses.find(value => value.id === houseId)!;
      this.addFeedback(`repair:${houseId}`, 'repair', 2, house.x, house.y, `house:${houseId}`, 'repair');
      this.addFeedback(`repair-kit:${houseId}`, 'repair', 2, house.x, house.y, `repair:${houseId}`, 'effect');
    }
    for (const houseId of this.repairing) {
      const house = run.houses.find(value => value.id === houseId);
      if (!house || house.hp <= 0) {
        this.repairing.delete(houseId); this.removeFeedback(`repair:${houseId}`); this.removeFeedback(`repair-kit:${houseId}`); continue;
      }
      const record = this.touch(`repair:${houseId}`, 'aid.repair', house.x, house.y, 32);
      record.visual.root.userData.domainId = houseId;
      record.visual.root.userData.visualOnly = true;
      record.visual.bind('use', houseId);
    }
    for (const hit of observed.hits) {
      this.addFeedback(`hit:${hit.id}`, 'hit', 0.45, hit.x, hit.y);
      if (this.records.has('tool:swatter')) this.addFeedback(`swatter-hit:${hit.id}`, 'hit', 0.25, hit.x, hit.y, 'tool:swatter', 'spark');
    }
    const items: CrowdItem[] = [];
    const nextItems = new Map<string, CrowdItem>();
    for (const id in run.inventory.objects) {
      const item = run.inventory.objects[id];
      const ownerKind = run.inventory.containers[item.owner]?.kind;
      if (ownerKind !== 'world' && ownerKind !== 'corpsePile') continue;
      const before = this.previousItems.get(item.id);
      const ecology = item.ecology as (typeof item.ecology & { action?: CrowdItem['action']; actionElapsed?: number }) | undefined;
      const visual: CrowdItem = { id: item.id, kind: item.kind, x: item.x, y: item.y,
        previousX: before?.x ?? item.x, previousY: before?.y ?? item.y,
        hp: item.hp, maxHp: item.maxHp, behavior: item.behavior,
        stage: item.ecology?.stage, heading: item.ecology?.heading,
        action: item.controlRemaining > 0 ? undefined : ecology?.action,
        actionElapsed: ecology?.actionElapsed,
        foodFraction: item.kind === 'trash' && item.ecology ? Math.max(0, Math.min(1, item.ecology.food / ECOLOGY_CYCLE.trashNutrition)) : undefined,
        carriedEgg: item.kind === 'egg' && !!item.ecology?.carrierId };
      items.push(visual); nextItems.set(item.id, visual);
      const nestId = `nest:${item.id}`;
      const alreadyNest = this.records.has(nestId);
      if (!this.nestCompleted.has(item.id) && (item.kind === 'nest' || alreadyNest || observed.nestDeaths.has(item.id))) {
        const record = this.touch(nestId, 'nest.demo', item.x, item.y, 52);
        const dead = item.hp <= 0 || item.kind === 'corpse' || run.ecology.nestDestroyed;
        const intent = dead ? 'destroy' : run.ecology.spawnRemaining <= nestManifest.stateRig.clips.pulse.durationSeconds ? 'pulse' : 'idle';
        record.visual.root.userData.domainId = item.id;
        record.visual.root.userData.nestState = intent;
        record.visual.bind(intent, dead ? item.id : '');
      }
    }
    for (const [id, record] of this.records) if (record.seen !== this.revision) { this.removeRecord(record); this.records.delete(id); }
    this.previousItems = nextItems; this.crowdItems = items; this.syncCrowd();
  }

  /** nowSeconds is presentation time only; no rAF or timers are owned here. */
  render(alpha: number, nowSeconds: number): void {
    if (this.disposed || this.lost || !Number.isFinite(nowSeconds)) return;
    const gap = this.lastSeconds === undefined ? 0 : nowSeconds - this.lastSeconds;
    // Discontinuous host time (sleep/hidden tab) is a fresh presentation frame,
    // never a fast-forward through one-shot effects or objective destruction.
    const delta = this.lastSeconds === undefined || this.paused || gap > 0.25 ? 0 : Math.max(0, Math.min(0.1, gap));
    this.lastSeconds = nowSeconds; this.visualSeconds += delta;
    const blend = this.paused ? 1 : interpolationAlpha(alpha);
    const effects = QUALITY_POLICIES[this.quality].effects && (this.options.detailedEffects?.() ?? true);
    let changedCrowd = false;
    const dock = this.toolDock();
    this.bagFillRemaining = Math.max(0, this.bagFillRemaining - delta);
    for (const [id, record] of this.records) {
      record.visual.root.position.set(interpolateCoordinate(record.previousX, record.x, blend) * (record.pointDip ? 1 : this.width),
        this.height - interpolateCoordinate(record.previousY, record.y, blend) * (record.pointDip ? 1 : this.height), id.startsWith('actor:') ? 64 : 0);
      if (id.startsWith('actor-pack:')) {
        record.visual.bind(this.bagIntent());
      } else if (id === 'tool:swatter' && !record.visual.root.userData.active) {
        record.visual.root.position.set(dock.x + 56, this.height - dock.y, 5);
      } else if (id.startsWith('repair:')) {
        const house = this.records.get(`house:${record.visual.root.userData.domainId}`);
        if (house?.visual.anchorPosition('repair', this.anchorPoint)) record.visual.root.position.copy(this.anchorPoint).add(new THREE.Vector3(24, 0, 5));
      }
      record.visual.update(delta);
      if (id.startsWith('nest:') && record.visual.root.userData.nestState === 'destroy' && record.visual.animationFinished) {
        this.nestCompleted.add(record.visual.root.userData.domainId as string);
        this.removeRecord(record); this.records.delete(id); changedCrowd = true; continue;
      }
      if (id.startsWith('repair:') && record.visual.animationFinished) {
        this.repairing.delete(record.visual.root.userData.domainId as string);
        this.removeRecord(record); this.records.delete(id); continue;
      }
      // Gentle steady marker remains at low quality; only its slow modulation is optional.
      record.status.material.opacity = effects && !this.paused ? 0.65 + Math.sin(this.visualSeconds * 2) * 0.08 : 0.65;
    }
    const mount = this.resources['tool.bag']?.mount;
    if (mount) for (const [id, record] of this.records) {
      if (!id.startsWith('actor-pack:')) continue;
      const actor = this.records.get(record.visual.root.userData.mountedTo as string);
      if (!actor || actor.visual.root.userData.insideHome || !actor.visual.root.visible) {
        record.visual.root.visible = false;
        continue;
      }
      record.visual.root.visible = actor.visual.anchorTransform(mount.anchor, this.anchorPoint, this.anchorQuaternion);
      if (!record.visual.root.visible) continue;
      record.visual.root.position.copy(this.anchorPoint);
      if (mount.offsetDip) {
        this.mountOffset.set(...mount.offsetDip).multiplyScalar(this.cleanerHeight / CAMPAIGN_VISUAL_HEIGHT_DIP.cleaner)
          .applyQuaternion(this.anchorQuaternion);
        record.visual.root.position.add(this.mountOffset);
      }
      record.visual.root.quaternion.copy(this.anchorQuaternion);
      if (mount.rotation) {
        this.mountEuler.set(...mount.rotation);
        this.mountQuaternion.setFromEuler(this.mountEuler);
        record.visual.root.quaternion.multiply(this.mountQuaternion);
      }
    }
    if (changedCrowd) this.syncCrowd();
    for (const [id, feedback] of this.feedback) {
      const anchor = feedback.anchorId && this.records.get(feedback.anchorId);
      if (anchor && feedback.anchor && anchor.visual.anchorPosition(feedback.anchor, this.anchorPoint)) {
        feedback.mark.root.position.copy(this.anchorPoint); feedback.mark.root.position.z += 6;
      } else if (anchor) feedback.mark.root.position.copy(anchor.visual.root.position).add(new THREE.Vector3(0, 10, 6));
      else feedback.mark.root.position.set(feedback.x * this.width, (1 - feedback.y) * this.height, 6);
      feedback.mark.update(delta, effects);
      if (feedback.mark.finished) this.removeFeedback(id);
    }
    this.crowd.render(blend, this.width, this.height, this.visualSeconds, this.quality);
    this.backend.render(this.scene, this.camera);
  }
  async ready(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
    await this.crowd.ready();
  }
  diagnostics(): { readonly contextLost: boolean; readonly disposed: boolean; readonly visualCount: number; readonly messages: readonly string[] } {
    return { contextLost: this.lost, disposed: this.disposed, visualCount: this.records.size, messages: [...this.messages] };
  }
  private bagIntent(): string { return this.bag.load <= 0 ? 'empty' : this.bagFillRemaining > 0 ? this.bag.fill : 'sealed'; }
  private toolDock(): { x: number; y: number } {
    const requested = this.options.toolDock?.();
    return requested && Number.isFinite(requested.x) && Number.isFinite(requested.y)
      ? { x: Math.max(24, Math.min(this.width - 72, requested.x)), y: Math.max(64, Math.min(this.height - 24, requested.y)) }
      : { x: 40, y: this.height - 40 };
  }
  private syncCrowd(): void {
    this.crowd.sync(this.crowdItems.filter(item => item.kind !== 'nest' && !this.records.has(`nest:${item.id}`)));
  }
  private addFeedback(id: string, kind: 'hit' | 'repair' | 'electric', duration: number, x: number, y: number, anchorId?: string, anchor?: string): void {
    if (this.feedback.has(id)) return;
    // A swept hit may contact many targets. Keep the feedback workload bounded;
    // this never changes the authoritative set of successful hit receipts.
    if (this.feedback.size >= 64) this.removeFeedback(this.feedback.keys().next().value!);
    const mark = new CampaignFeedbackMark(kind, duration); mark.root.name = kind === 'repair' ? `feedback:${id}` : id;
    this.feedback.set(id, { mark, x, y, anchorId, anchor }); this.scene.add(mark.root);
  }
  private removeFeedback(id: string): void { this.feedback.get(id)?.mark.dispose(); this.feedback.delete(id); }
  private clearFeedback(): void { for (const id of this.feedback.keys()) this.removeFeedback(id); }
  private touch(id: string, resourceId: string, x: number, y: number, height: number, archetype?: 'cleaner' | 'frog', house = false, baseId?: string): VisualRecord {
    let record = this.records.get(id);
    const asset = Object.prototype.hasOwnProperty.call(this.resources, resourceId) ? this.resources[resourceId]
      : baseId && Object.prototype.hasOwnProperty.call(this.resources, baseId) ? this.resources[baseId] : undefined;
    const sizeDip = !archetype && resourceId !== 'trap.ladder' && asset && Number.isFinite(asset.heightDip) && asset.heightDip > 0 ? asset.heightDip : height;
    const key = `${resourceId}:${sizeDip}`;
    if (record?.key !== key) {
      if (record) this.removeRecord(record);
      const visual = new CampaignModelVisual(resourceId, asset,
        this.cache, sizeDip, this.report, archetype, house ? 180 : undefined);
      visual.root.name = id; visual.setShadows(QUALITY_POLICIES[this.quality].shadows);
      const status = new THREE.Mesh(new THREE.RingGeometry(5, 8, 16), new THREE.MeshBasicMaterial({ color: 0xeeb657, transparent: true, opacity: 0.65, depthTest: false }));
      status.position.set(0, sizeDip + 20, 5); status.visible = false; visual.root.add(status);
      const health = house ? new THREE.Mesh(new THREE.PlaneGeometry(120, 5), new THREE.MeshBasicMaterial({ color: 0x72d1ac, depthTest: false })) : undefined;
      if (health) { health.position.set(0, sizeDip + 8, 5); visual.root.add(health); }
      record = { key, visual, status, health, x, y, previousX: x, previousY: y, seen: this.revision };
      this.records.set(id, record); this.scene.add(visual.root);
      const pending = visual.ready.finally(() => this.pending.delete(pending)); this.pending.add(pending);
    } else { record.previousX = record.x; record.previousY = record.y; record.x = x; record.y = y; record.seen = this.revision; }
    record.visual.root.userData.resourceId = resourceId;
    if (asset) record.visual.root.userData.resourceUrl = asset.url;
    else delete record.visual.root.userData.resourceUrl;
    return record;
  }
  private status(record: VisualRecord, visible: boolean): void {
    record.status.visible = visible;
    record.status.material.color.setHex(this.phase === 'victory' ? 0x6be7b5 : this.phase === 'defeat' ? 0xe7736d : 0xeeb657);
  }
  private removeRecord(record: VisualRecord): void {
    record.status.geometry.dispose(); record.status.material.dispose();
    record.health?.geometry.dispose(); record.health?.material.dispose(); record.visual.dispose();
  }
  private clearRecords(): void { for (const record of this.records.values()) this.removeRecord(record); this.records.clear(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.options.canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    this.clearRecords(); this.clearFeedback(); this.observer.clear(); this.repairing.clear(); this.nestCompleted.clear(); this.homeInteractions.clear();
    this.crowd.dispose(); this.previousItems.clear(); this.crowdItems = [];
    this.sun.shadow.map?.dispose(); this.sun.shadow.mapPass?.dispose();
    this.scene.clear(); if (this.ownsCache) this.cache.dispose(); this.backend.dispose();
  }
}
