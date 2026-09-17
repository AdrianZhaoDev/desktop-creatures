import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { ModelVisualRig } from "./visual-rig";
import bagManifest from "../../../assets/steam-v1/s07-s08/collection-bag/manifest.json";
import swatterManifest from "../../../assets/steam-v1/s07-s08/electric-swatter/manifest.json";
import repairManifest from "../../../assets/steam-v1/s07-s08/repair-kit/manifest.json";
import nestManifest from "../../../assets/steam-v1/s07-s09/demo-main-nest/manifest.json";
import cleanerHomeManifest from "../../../assets/steam-v1/s07-s08/cleaner-home/manifest.json";
import frogHomeManifest from "../../../assets/steam-v1/s07-s08/frog-home/manifest.json";
import female from "../../../assets/s06/cleaner-female/manifest.json";
import male from "../../../assets/s06/cleaner-male/manifest.json";
import frog from "../../../assets/s06/frog/manifest.json";
import germanica from "../../../assets/game/germanica/manifest.json";
import americana from "../../../assets/game/americana/manifest.json";
import brownbanded from "../../../assets/game/brownbanded/manifest.json";
import hissing from "../../../assets/game/hissing/manifest.json";
import orientalis from "../../../assets/game/orientalis/manifest.json";
import campaignAssets from "../../../assets/steam-v1/s07-s08/manifest.json";
import campaignExtensionAssets from "../../../assets/steam-v1/s07-s09/manifest.json";
import fourStateHomeAssets from "../../../assets/steam-v1/s07-four-states/manifest.json";
import cleanerHomeStats from "../../../assets/steam-v1/s07-s08/cleaner-home/runtime-stats.json";
import frogHomeStats from "../../../assets/steam-v1/s07-s08/frog-home/runtime-stats.json";
import collectionBagStats from "../../../assets/steam-v1/s07-s08/collection-bag/runtime-stats.json";
import electricSwatterStats from "../../../assets/steam-v1/s07-s08/electric-swatter/runtime-stats.json";
import baitStationStats from "../../../assets/steam-v1/s07-s08/bait-station/runtime-stats.json";
import gluePadStats from "../../../assets/steam-v1/s07-s08/glue-pad/runtime-stats.json";
import bugCatcherStats from "../../../assets/steam-v1/s07-s08/bug-catcher/runtime-stats.json";
import foldingLadderStats from "../../../assets/steam-v1/s07-s08/folding-ladder/runtime-stats.json";
import repairKitStats from "../../../assets/steam-v1/s07-s08/repair-kit/runtime-stats.json";
import cleanerHomeDamagedStats from "../../../assets/steam-v1/s07-s09/cleaner-home-damaged/runtime-stats.json";
import cleanerHomeDestroyedStats from "../../../assets/steam-v1/s07-s09/cleaner-home-destroyed/runtime-stats.json";
import frogHomeDamagedStats from "../../../assets/steam-v1/s07-s09/frog-home-damaged/runtime-stats.json";
import frogHomeDestroyedStats from "../../../assets/steam-v1/s07-s09/frog-home-destroyed/runtime-stats.json";
import demoMainNestStats from "../../../assets/steam-v1/s07-s09/demo-main-nest/runtime-stats.json";
import cleanerHomeLightDamagedStats from "../../../assets/steam-v1/s07-four-states/cleaner-home-light-damaged/runtime-stats.json";
import cleanerHomeHeavyDamagedStats from "../../../assets/steam-v1/s07-four-states/cleaner-home-heavy-damaged/runtime-stats.json";
import frogHomeLightDamagedStats from "../../../assets/steam-v1/s07-four-states/frog-home-light-damaged/runtime-stats.json";
import frogHomeHeavyDamagedStats from "../../../assets/steam-v1/s07-four-states/frog-home-heavy-damaged/runtime-stats.json";

export interface ModelAsset {
  url: string;
  heightDip: number;
  rotation?: readonly [number, number, number];
  readonly modelHeight?: number;
  readonly visualRig?: ModelVisualRig;
  /** Recenter X and move the measured lower bound to Y=0 after scaling. */
  readonly alignBase?: boolean;
  /**
   * Source-space bounds from the approved reference state. Variants sharing this
   * record keep one scale and anchor instead of recentring around damage debris.
   */
  readonly alignmentReference?: Readonly<{ centerX: number; minY: number; width: number }>;
  /** Per-instance semantic tint. The embedded texture remains the detail source. */
  readonly materialColors?: Readonly<Record<string, number>>;
  readonly attachments?: Readonly<Record<string, { url: string; socket: string }>>;
  /** Mount a standalone presentation model to an actor semantic anchor. */
  readonly mount?: Readonly<{
    anchor: string;
    offsetDip?: readonly [number, number, number];
    rotation?: readonly [number, number, number];
  }>;
}

export type CampaignResourceRegistry = Readonly<Record<string, ModelAsset>>;

interface ActorManifest {
  id: string;
  model: string;
  heightDIP: number;
  dimensions: { height: number };
  sockets?: Record<string, string>;
  attachments?: Record<string, { model: string; socket: string }>;
}

function actorAsset(folder: string, manifest: ActorManifest): ModelAsset {
  const attachments = manifest.attachments && Object.fromEntries(
    Object.entries(manifest.attachments).filter(([action]) => action !== "carry").map(([action, attachment]) => [action, Object.freeze({
      url: `/${folder}/${attachment.model}`, socket: attachment.socket,
    })]),
  );
  return Object.freeze({
    url: `/${folder}/${manifest.model}`,
    heightDip: manifest.heightDIP,
    modelHeight: manifest.dimensions.height,
    ...(manifest.sockets && { visualRig: Object.freeze({ anchors: Object.freeze({ ...manifest.sockets }) }) }),
    // S06 cleaner models use their authored materials. Keep any per-model
    // palette adapter explicit instead of changing shared simulation state.
    ...(manifest.id === "actor.cleaner.male" && { materialColors: Object.freeze({
      "Woven fabric": 0x4fa98d,
      "Skin": 0xffb99e,
      "Rubber and hardware": 0x465763,
      "Chestnut hair": 0x70402f,
    }) }),
    ...(attachments && { attachments: Object.freeze(attachments) }),
  });
}

const campaignRuntimeStats: Readonly<Record<string, { dimensionsGLTF: { size: number[] } }>> = Object.freeze({
  "home.cleaner": cleanerHomeStats,
  "home.frog": frogHomeStats,
  "tool.bag": collectionBagStats,
  "tool.swatter": electricSwatterStats,
  "trap.bait": baitStationStats,
  "trap.glue": gluePadStats,
  "trap.catcher": bugCatcherStats,
  "aid.ladder": foldingLadderStats,
  "aid.repair": repairKitStats,
});

interface RuntimeBounds { dimensionsGLTF: { min: number[]; max: number[]; size: number[] } }
const extensionRuntimeStats: Readonly<Record<string, RuntimeBounds>> = Object.freeze({
  "home.cleaner.damaged": cleanerHomeDamagedStats,
  "home.cleaner.destroyed": cleanerHomeDestroyedStats,
  "home.frog.damaged": frogHomeDamagedStats,
  "home.frog.destroyed": frogHomeDestroyedStats,
  "nest.demo": demoMainNestStats,
});
const fourStateRuntimeStats: Readonly<Record<string, RuntimeBounds>> = Object.freeze({
  "home.cleaner.light-damaged": cleanerHomeLightDamagedStats,
  "home.cleaner.heavy-damaged": cleanerHomeHeavyDamagedStats,
  "home.frog.light-damaged": frogHomeLightDamagedStats,
  "home.frog.heavy-damaged": frogHomeHeavyDamagedStats,
});

function finiteSpan(stats: RuntimeBounds): number {
  const size = stats.dimensionsGLTF.size;
  if (size.length !== 3 || !size.every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("Campaign GLB runtime statistics contain invalid dimensions");
  }
  return Math.max(...size);
}

function alignmentReference(stats: RuntimeBounds): NonNullable<ModelAsset["alignmentReference"]> {
  const { min, max, size } = stats.dimensionsGLTF;
  if (min.length !== 3 || max.length !== 3 || ![...min, ...max].every(Number.isFinite)) {
    throw new Error("Campaign GLB runtime statistics contain invalid bounds");
  }
  finiteSpan(stats);
  return Object.freeze({ centerX: (min[0] + max[0]) * 0.5, minY: min[1], width: size[0] });
}

function defaultRegistry(): CampaignResourceRegistry {
  const result: Record<string, ModelAsset> = {};
  for (const [folder, manifest, alias] of [
    ["s06/cleaner-female", female, "female"], ["s06/cleaner-male", male, "male"], ["s06/frog", frog, "frog"],
  ] as const) {
    const asset = actorAsset(folder, manifest);
    result[manifest.id] = asset;
    result[alias] = asset;
  }
  // S06 actor attachments remain actor-owned. The standalone S07/S08 collection
  // bag replaces only the campaign tool resource.
  result["tool.broom"] = Object.freeze({ url: `/s06/cleaner-female/${female.attachments.clean.model}`, heightDip: 60 });
  const authoredHeightDip: Readonly<Record<string, number>> = Object.freeze({
    "home.cleaner": 160,
    "home.frog": 160,
    "tool.bag": 32,
    "tool.swatter": 48,
    "trap.bait": 32,
    "trap.glue": 32,
    "trap.catcher": 32,
    // CampaignRenderer preserves the domain-computed display-relative ladder
    // height; this positive value is metadata for other registry consumers.
    "aid.ladder": 96,
    "aid.repair": 32,
  });
  for (const asset of campaignAssets.assets) {
    const heightDip = authoredHeightDip[asset.id];
    const stats = campaignRuntimeStats[asset.id];
    if (!heightDip || !stats) continue;
    // Asset previews define their DIP scale by the longest projected dimension.
    // Supplying that normalization span is essential for flat props such as the
    // glue pad; scaling its thin Y extent to 32 DIP would make it hundreds wide.
    const modelHeight = Math.max(...stats.dimensionsGLTF.size);
    result[asset.id] = Object.freeze({ url: `/steam-v1/s07-s08/${asset.model}`, heightDip, modelHeight, alignBase: true });
  }
  const houseReferences = Object.freeze({
    "home.cleaner": Object.freeze({ modelHeight: finiteSpan(cleanerHomeStats), alignment: alignmentReference(cleanerHomeStats) }),
    "home.frog": Object.freeze({ modelHeight: finiteSpan(frogHomeStats), alignment: alignmentReference(frogHomeStats) }),
  });
  // Preserve the exact complete-house normalization and visual alignBase offset
  // across every authored damage state. Debris may extend the damaged bounds,
  // but it must not move or shrink the house when HP crosses a threshold.
  for (const [id, reference] of Object.entries(houseReferences)) {
    result[id] = Object.freeze({ ...result[id], modelHeight: reference.modelHeight, alignmentReference: reference.alignment });
  }
  for (const asset of campaignExtensionAssets.assets) {
    const stats = extensionRuntimeStats[asset.id];
    if (!stats) continue;
    const measuredSpan = finiteSpan(stats);
    if (asset.id === "nest.demo") {
      result[asset.id] = Object.freeze({ url: `/steam-v1/s07-s09/${asset.model}`, heightDip: 52,
        modelHeight: measuredSpan, alignBase: true });
      continue;
    }
    const normalId = asset.id.startsWith("home.cleaner.") ? "home.cleaner"
      : asset.id.startsWith("home.frog.") ? "home.frog" : undefined;
    if (!normalId) continue;
    const reference = houseReferences[normalId];
    result[asset.id] = Object.freeze({ url: `/steam-v1/s07-s09/${asset.model}`, heightDip: 160,
      modelHeight: reference.modelHeight, alignBase: true, alignmentReference: reference.alignment });
  }
  for (const asset of fourStateHomeAssets.assets) {
    const stats = fourStateRuntimeStats[asset.id];
    if (!stats) continue;
    finiteSpan(stats); // Reject malformed generated statistics at the import boundary.
    const normalId = asset.id.startsWith("home.cleaner.") ? "home.cleaner"
      : asset.id.startsWith("home.frog.") ? "home.frog" : undefined;
    if (!normalId) continue;
    const reference = houseReferences[normalId];
    result[asset.id] = Object.freeze({ url: `/steam-v1/s07-four-states/${asset.model}`, heightDip: 160,
      modelHeight: reference.modelHeight, alignBase: true, alignmentReference: reference.alignment });
  }
  // Exported clip times and anchor names stay at the asset boundary. These rigs
  // provide presentation only; they do not define inventory, hits or spawn timers.
  result["tool.bag"] = Object.freeze({ ...result["tool.bag"], visualRig: {
    poses: Object.fromEntries(Object.entries(bagManifest.stateRig.stateTimesSeconds)
      .map(([state, timeSeconds]) => [state, { clip: bagManifest.stateRig.clip, timeSeconds }])),
    anchors: bagManifest.anchors,
  }, mount: Object.freeze({ anchor: "backpack", offsetDip: Object.freeze([0, -11, -4] as const),
    rotation: Object.freeze([0, Math.PI, 0] as const) }) });
  const swatterPose = (timeSeconds: number) => ({ clip: swatterManifest.stateRig.clip, timeSeconds });
  result["tool.swatter"] = Object.freeze({ ...result["tool.swatter"], visualRig: {
    poses: { idle: swatterPose(0), active: swatterPose((swatterManifest.stateRig.openFrame - 1) / swatterManifest.stateRig.frameRate), overheated: swatterPose(0) },
    anchors: swatterManifest.anchors,
    signalMaterials: electricSwatterStats.materials.filter(material => material.name === "pbr_glow" || material.name === "pbr_metal").map(material => material.name),
  } });
  result["aid.repair"] = Object.freeze({ ...result["aid.repair"], visualRig: {
    actions: { use: { clip: repairManifest.stateRig.clip, loop: false } }, anchors: repairManifest.anchors,
  } });
  result["nest.demo"] = Object.freeze({ ...result["nest.demo"], visualRig: {
    actions: nestManifest.actions, anchors: nestManifest.anchors,
  } });
  const homeInteractions = (cleaner: boolean, variant: boolean): NonNullable<ModelVisualRig["interactions"]> => Object.freeze({
    door: Object.freeze({ mode: "toggle", durationSeconds: 0.32, transforms: Object.freeze([
      Object.freeze({ node: "door_hinge", property: "quaternion", closed: Object.freeze([0, 0, 0, 1]),
        open: Object.freeze(cleaner ? [0, -0.7933533787727356, 0, 0.6087614297866821]
          : [0, -0.8191520571708679, 0, 0.5735764503479004]) }),
    ]) }),
    props: Object.freeze({ mode: "pulse", durationSeconds: 0.8, transforms: Object.freeze(variant ? [
      Object.freeze({ node: "inspection_detail", property: "quaternion", closed: Object.freeze([0, 0, 0, 1]),
        open: Object.freeze([0, 0, 0.022498110309243202, 0.9997468590736389]) }),
    ] : [
      Object.freeze({ node: "roof_root", property: "position", closed: Object.freeze([0, 0, 0]),
        open: Object.freeze([0, 0.1, 0]) }),
      ...(cleaner ? [Object.freeze({ node: "window_hinge", property: "quaternion", closed: Object.freeze([0, 0, -0.48817723989486694, 0.8727445006370544]),
        open: Object.freeze([0, 0, 0.12467478215694427, 0.9921976327896118]) })] : []),
    ]) }),
  });
  for (const [id, asset] of Object.entries(result)) {
    const manifest = id.startsWith("home.cleaner") ? cleanerHomeManifest : id.startsWith("home.frog") ? frogHomeManifest : undefined;
    if (manifest) result[id] = Object.freeze({ ...asset, visualRig: Object.freeze({ anchors: manifest.anchors,
      interactions: homeInteractions(id.startsWith("home.cleaner"), id !== "home.cleaner" && id !== "home.frog") }) });
  }
  // The authored package calls this aid.ladder while the campaign domain calls
  // the placed instance trap.ladder. Both IDs share one immutable model record.
  result["trap.ladder"] = result["aid.ladder"];
  for (const manifest of [germanica, americana, brownbanded, hissing, orientalis]) {
    for (const [formId, form] of Object.entries(manifest.forms)) {
      // The old roach rig is +Y up/-Z forward. Turning it onto the screen makes
      // its body length the vertical normalization dimension (including eggs).
      const asset: ModelAsset = Object.freeze({
        url: `/game/${manifest.speciesId}/${form.model}`,
        heightDip: formId === "ootheca" ? manifest.appearance.eggSizeDip : manifest.display.bodyLengthDip,
        rotation: Object.freeze([Math.PI / 2, 0, 0] as const),
      });
      result[`${manifest.id}.${formId}`] = asset;
      if (formId === "adult") result[manifest.id] = asset;
    }
  }
  return Object.freeze(result);
}

export const DEFAULT_CAMPAIGN_RESOURCES = defaultRegistry();

/**
 * Cache-owned template. Instantiate with SkeletonUtils.clone(scene), then clone
 * any materials that the instance will modify. Instances own their mixer and
 * cloned materials (and cloned skeleton), but share template geometry/textures.
 * Removing an instance must never dispose shared geometry or textures. Dispose
 * instances before disposing their cache, which owns the source GPU resources.
 * Cache ownership also includes closeable source images (e.g. ImageBitmap), so
 * injected loaders must not share those images with independently owned caches.
 */
export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

async function loadGltf(url: string): Promise<LoadedModel> {
  const model = await new GLTFLoader().loadAsync(url);
  return { scene: model.scene, animations: model.animations };
}

/** One request per URL, including failures; create a new cache to retry failures. */
export class CampaignModelCache {
  private readonly requests = new Map<string, Promise<LoadedModel>>();
  private readonly models = new Set<LoadedModel>();
  private readonly released = new WeakSet<object>();
  private readonly closedImages = new WeakSet<object>();
  private disposed = false;

  constructor(private readonly loader: (url: string) => Promise<LoadedModel> = loadGltf) {}

  load(url: string): Promise<LoadedModel> {
    if (this.disposed) return Promise.reject(new Error("CampaignModelCache is disposed"));
    const existing = this.requests.get(url);
    if (existing) return existing;
    // Defer invocation so synchronous loader errors are cached just like rejected
    // requests, and reentrant calls cannot start a duplicate request.
    const request = Promise.resolve().then(() => this.loader(url)).then((model) => {
      if (this.disposed) {
        this.releaseModel(model);
        throw new Error("CampaignModelCache is disposed");
      }
      this.models.add(model);
      return model;
    });
    this.requests.set(url, request);
    return request;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const model of this.models) this.releaseModel(model);
    this.models.clear();
    this.requests.clear();
  }

  private releaseOnce(resource: { dispose(): void }): void {
    if (this.released.has(resource)) return;
    this.released.add(resource);
    resource.dispose();
  }

  private releaseTexture(texture: THREE.Texture): void {
    this.releaseOnce(texture);
    const closeImage = (image: unknown): void => {
      if (!image || typeof image !== "object" || this.closedImages.has(image)) return;
      this.closedImages.add(image);
      if (Array.isArray(image)) {
        for (const face of image) closeImage(face);
      } else if ("close" in image && typeof image.close === "function") {
        // Texture.dispose only releases the GPU allocation. GLTFLoader may use
        // ImageBitmapLoader, whose decoded CPU bitmap must be closed separately.
        image.close();
      }
    };
    closeImage(texture.source?.data);
    closeImage(texture.image);
  }

  private releaseModel(model: LoadedModel): void {
    const visited = new WeakSet<object>();
    const releaseTextures = (value: unknown): void => {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (value instanceof THREE.Texture) {
        this.releaseTexture(value);
      } else if (Array.isArray(value)) {
        for (const item of value) releaseTextures(item);
      } else if (Object.getPrototypeOf(value) === Object.prototype) {
        for (const child of Object.values(value)) releaseTextures(child);
      }
    };
    model.scene.traverse((object) => {
      const renderable = object as THREE.Mesh;
      if (renderable.geometry) this.releaseOnce(renderable.geometry);
      if (renderable.material) {
        for (const material of Array.isArray(renderable.material) ? renderable.material : [renderable.material]) {
          // Includes ordinary map slots and nested ShaderMaterial uniforms.
          for (const value of Object.values(material)) releaseTextures(value);
          this.releaseOnce(material);
        }
      }
      if (object instanceof THREE.SkinnedMesh && object.skeleton.boneTexture) {
        this.releaseTexture(object.skeleton.boneTexture);
        object.skeleton.boneTexture = null;
      }
    });
  }
}

