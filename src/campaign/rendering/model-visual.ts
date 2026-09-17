import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CampaignModelCache, type ModelAsset } from './resources';
import { isLoopingClip, resolveClipName } from './mapping';
import type { ModelVisualRig } from './visual-rig';

interface ToggleInteractionState { progress: number; target: 0 | 1 }
interface PulseInteractionState { token: string; elapsed: number }

/** Owns clones, mixers and placeholders; cache retains shared GLB geometry/material/textures. */
export class CampaignModelVisual {
  readonly root = new THREE.Group();
  readonly facing = new THREE.Group();
  private model?: THREE.Object3D;
  private mixer?: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly clipNames = new Set<string>();
  private activeAction?: THREE.AnimationAction;
  private boundIntent = '';
  private boundToken = '';
  private desiredToken = '';
  private readonly visualRig?: ModelVisualRig;
  private readonly attachments = new Map<string, THREE.Object3D>();
  private readonly signalMaterials = new Set<THREE.MeshStandardMaterial>();
  private readonly coloredMaterials = new Set<THREE.MeshStandardMaterial>();
  private desiredSignal?: { color: number; intensity: number };
  private readonly placeholder: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  private disposed = false;
  private loadSettled = false;
  private animationDone = false;
  private shadows = false;
  private desiredIntent = 'idle';
  private readonly reported = new Set<string>();
  private readonly toggles = new Map<string, ToggleInteractionState>();
  private readonly pulses = new Map<string, PulseInteractionState>();
  private readonly interactionPosition = new THREE.Vector3();
  private readonly interactionOpenPosition = new THREE.Vector3();
  private readonly interactionQuaternion = new THREE.Quaternion();
  private readonly interactionClosedQuaternion = new THREE.Quaternion();
  private readonly interactionOpenQuaternion = new THREE.Quaternion();
  readonly ready: Promise<void>;
  private readonly finished = (event: { action: THREE.AnimationAction }): void => {
    if (this.disposed || event.action !== this.activeAction) return;
    if (!this.archetype) {
      const action = this.visualRig?.actions?.[this.desiredIntent];
      if (action && !action.loop) this.setAnimationFinished(true);
      return;
    }
    if (this.desiredIntent !== 'tongue_fire') {
      if (!isLoopingClip(event.action.getClip().name)) this.setAnimationFinished(true);
      return;
    }
    const completed = event.action.getClip().name;
    // One visual fire/retract sequence per authority task/activity transition.
    // Never leave an infinitely extended tongue, and never generate a hit/reward event.
    const nextName = completed === 'tongue_fire' ? (this.actions.has('tongue_retract') ? 'tongue_retract' : 'idle')
      : completed === 'tongue_retract' ? 'idle' : undefined;
    if (!nextName) return;
    const next = this.actions.get(nextName);
    if (!next) return;
    next.reset().play().crossFadeFrom(event.action, 0.05, false);
    this.activeAction = next; this.root.userData.clip = nextName;
    this.setAnimationFinished(completed === 'tongue_retract');
  };

  constructor(readonly resourceId: string, asset: ModelAsset | undefined, cache: CampaignModelCache,
    readonly heightDip: number, private readonly report: (message: string) => void,
    private readonly archetype?: 'cleaner' | 'frog', maxWidthDip?: number) {
    this.visualRig = asset?.visualRig;
    this.root.name = resourceId;
    this.root.userData.animationFinished = false;
    this.root.add(this.facing);
    this.placeholder = new THREE.Mesh(new THREE.BoxGeometry(maxWidthDip ?? heightDip * 0.46, heightDip, heightDip * 0.25),
      new THREE.MeshBasicMaterial({ color: 0xffa338, wireframe: true }));
    this.placeholder.position.y = heightDip / 2;
    this.placeholder.name = `DEVELOPMENT PLACEHOLDER: ${resourceId}`;
    this.root.userData.developmentPlaceholder = true;
    this.root.add(this.placeholder);
    this.ready = asset ? this.load(asset, cache, maxWidthDip) : Promise.resolve();
    if (!asset) {
      this.loadSettled = true;
      this.setAnimationFinished(true);
      this.warn(`Missing resource ${resourceId}; DEVELOPMENT wireframe placeholder`);
    }
  }
  get animationFinished(): boolean { return this.loadSettled && this.animationDone; }
  private async load(asset: ModelAsset, cache: CampaignModelCache, maxWidthDip?: number): Promise<void> {
    try {
      const source = await cache.load(asset.url);
      if (this.disposed) { this.loadSettled = true; this.setAnimationFinished(true); return; }
      const model = cloneSkeleton(source.scene);
      this.model = model;
      // Measure while detached: the async parent may already have moved in DIP.
      if (asset.rotation) model.rotation.set(...asset.rotation);
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      const modelHeight = asset.modelHeight ?? size.y;
      if (!(modelHeight > 0) || !Number.isFinite(modelHeight)) throw new Error('GLB has no finite nonzero bounds');
      let scale = this.heightDip / modelHeight;
      const alignmentWidth = asset.alignmentReference?.width ?? size.x;
      if (maxWidthDip && alignmentWidth > 0) scale = Math.min(scale, maxWidthDip / alignmentWidth);
      model.scale.multiplyScalar(scale);
      // S06 uses its declared foot origin. Generic registered props and explicit
      // longest-dimension assets use their measured centre/base after scaling.
      if (!asset.modelHeight || asset.alignBase) {
        const centerX = asset.alignmentReference?.centerX ?? (bounds.min.x + bounds.max.x) * 0.5;
        const minY = asset.alignmentReference?.minY ?? bounds.min.y;
        model.position.x -= centerX * scale;
        model.position.y -= minY * scale;
      }
      this.facing.add(model);
      this.mixer = new THREE.AnimationMixer(model);
      this.mixer.addEventListener('finished', this.finished);
      for (const clip of source.animations) {
        const action = this.mixer.clipAction(clip);
        action.setLoop(isLoopingClip(clip.name) ? THREE.LoopRepeat : THREE.LoopOnce, isLoopingClip(clip.name) ? Infinity : 1);
        action.clampWhenFinished = true;
        this.actions.set(clip.name, action); this.clipNames.add(clip.name);
      }
      const validColors = this.cloneMaterialColors(model, asset.materialColors);
      const validSignals = this.cloneSignalMaterials(model);
      this.placeholder.visible = !validColors || !validSignals;
      this.root.userData.developmentPlaceholder = !validColors || !validSignals;
      this.setShadows(this.shadows);
      this.loadSettled = true;
      this.applyInteractions(0);
      if (this.desiredSignal) this.setMaterialSignal(this.desiredSignal.color, this.desiredSignal.intensity);
      this.bind(this.desiredIntent, this.desiredToken);
      if (asset.attachments) await Promise.all(Object.entries(asset.attachments).map(async ([semantic, attachment]) => {
        try {
          const attachmentSource = await cache.load(attachment.url);
          if (this.disposed) return;
          const socket = model.getObjectByName(attachment.socket);
          if (!socket) { this.root.userData.developmentPlaceholder = true; this.warn(`Missing socket ${resourceIdLabel(this.resourceId, attachment.socket)}`); return; }
          const clone = cloneSkeleton(attachmentSource.scene);
          if (!this.cloneMaterialColors(clone, asset.materialColors, false)) {
            this.placeholder.visible = true; this.root.userData.developmentPlaceholder = true;
          }
          clone.visible = semantic === this.desiredIntent;
          socket.add(clone); this.attachments.set(semantic, clone);
          this.setShadows(this.shadows);
        } catch (error) { if (!this.disposed) { this.root.userData.developmentPlaceholder = true; this.warn(`Attachment load failed ${attachment.url}: ${String(error)}`); } }
      }));
    } catch (error) {
      if (!this.disposed) {
        this.releaseModel(); this.loadSettled = true; this.setAnimationFinished(true);
        this.placeholder.visible = true; this.root.userData.developmentPlaceholder = true;
        this.warn(`Resource load failed ${asset.url}: ${String(error)}; DEVELOPMENT wireframe placeholder`);
      }
    }
  }
  bind(intent: string, actionToken = ''): void {
    this.desiredIntent = intent;
    this.desiredToken = actionToken;
    this.root.userData.actionIntent = intent;
    if (!this.mixer) {
      this.setAnimationFinished(this.loadSettled);
      return;
    }
    for (const [semantic, attachment] of this.attachments) attachment.visible = semantic === intent;
    if (!this.archetype) {
      this.bindVisualRig(intent, actionToken);
      return;
    }
    const name = resolveClipName(intent, this.archetype, this.clipNames);
    if (name !== intent) {
      this.root.userData.developmentPlaceholder = true;
      this.warn(`Action fallback ${this.resourceId}: ${intent} -> ${name ?? 'static pose'}`);
    }
    if (this.boundIntent === intent && this.boundToken === actionToken) return;
    this.boundIntent = intent; this.boundToken = actionToken;
    this.root.userData.clip = name;
    const next = name ? this.actions.get(name) : undefined;
    if (next !== this.activeAction) {
      const previous = this.activeAction;
      next?.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
      if (previous && next) next.crossFadeFrom(previous, 0.12, false);
      else previous?.stop();
      this.activeAction = next;
    } else if (next && !isLoopingClip(name!)) next.reset().play();
    this.setAnimationFinished(!next);
  }
  update(deltaSeconds: number): void {
    if (this.disposed || !Number.isFinite(deltaSeconds) || deltaSeconds < 0) return;
    this.mixer?.update(deltaSeconds);
    if (this.visualRig?.poses?.[this.desiredIntent]) this.zeroTinyMorphWeights();
    this.applyInteractions(deltaSeconds);
  }
  setControl(name: string, open: boolean): boolean {
    const interaction = this.visualRig?.interactions?.[name];
    if (!interaction || interaction.mode !== 'toggle') return false;
    const state = this.toggles.get(name) ?? { progress: 0, target: 0 as const };
    state.target = open ? 1 : 0;
    this.toggles.set(name, state);
    this.root.userData[`interaction:${name}`] = open ? 'open' : 'closed';
    if (this.loadSettled) this.applyInteractions(0);
    return true;
  }
  triggerInteraction(name: string, token: string): boolean {
    const interaction = this.visualRig?.interactions?.[name];
    if (!interaction || interaction.mode !== 'pulse') return false;
    const previous = this.pulses.get(name);
    if (previous?.token === token) return true;
    this.pulses.set(name, { token, elapsed: 0 });
    this.root.userData[`interaction:${name}`] = token;
    if (this.loadSettled) this.applyInteractions(0);
    return true;
  }
  setMaterialSignal(color: number, intensity: number): void {
    this.desiredSignal = { color, intensity };
    if (!Number.isFinite(color) || !Number.isFinite(intensity) || intensity < 0) {
      this.markPlaceholder(`Invalid visual rig material signal ${this.resourceId}`);
      return;
    }
    if (!this.loadSettled) return;
    if (!this.signalMaterials.size) {
      this.markPlaceholder(`Missing visual rig signal materials ${this.resourceId}`);
      return;
    }
    for (const material of this.signalMaterials) {
      material.emissive.setHex(color);
      material.emissiveIntensity = intensity;
    }
  }
  anchorPosition(semantic: string, target: THREE.Vector3): boolean {
    if (!this.loadSettled) return false;
    const nodeName = this.visualRig?.anchors?.[semantic];
    if (!this.model || !nodeName) {
      this.markPlaceholder(`Missing visual rig anchor ${this.resourceId}/${semantic}`);
      return false;
    }
    const node = this.model.getObjectByName(nodeName);
    if (!node) {
      this.markPlaceholder(`Missing visual rig anchor node ${this.resourceId}/${nodeName}`);
      return false;
    }
    this.root.updateWorldMatrix(true, true);
    node.getWorldPosition(target);
    return true;
  }
  anchorTransform(semantic: string, position: THREE.Vector3, quaternion: THREE.Quaternion): boolean {
    if (!this.loadSettled) return false;
    const nodeName = this.visualRig?.anchors?.[semantic];
    if (!this.model || !nodeName) {
      this.markPlaceholder(`Missing visual rig anchor ${this.resourceId}/${semantic}`);
      return false;
    }
    const node = this.model.getObjectByName(nodeName);
    if (!node) {
      this.markPlaceholder(`Missing visual rig anchor node ${this.resourceId}/${nodeName}`);
      return false;
    }
    this.root.updateWorldMatrix(true, true);
    node.getWorldPosition(position);
    node.getWorldQuaternion(quaternion);
    return true;
  }
  setShadows(enabled: boolean): void {
    this.shadows = enabled;
    this.model?.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = enabled; object.receiveShadow = enabled; } });
  }
  private warn(message: string): void { if (!this.reported.has(message)) { this.reported.add(message); this.report(message); } }
  private setAnimationFinished(finished: boolean): void {
    this.animationDone = finished;
    this.root.userData.animationFinished = this.loadSettled && finished;
  }
  private bindVisualRig(intent: string, actionToken: string): void {
    if (this.boundIntent === intent && this.boundToken === actionToken) return;
    this.boundIntent = intent; this.boundToken = actionToken;
    const actionState = this.visualRig?.actions?.[intent];
    const poseState = this.visualRig?.poses?.[intent];
    if (!actionState && !poseState) {
      if (intent !== 'idle') {
        this.failAnimation(`Missing visual rig state ${this.resourceId}/${intent}`);
        return;
      }
      this.stopVisualRigActions();
      this.root.userData.clip = undefined;
      this.setAnimationFinished(true);
      return;
    }
    const clipName = (actionState ?? poseState)!.clip;
    this.root.userData.clip = clipName;
    const next = this.actions.get(clipName);
    if (!next) {
      this.failAnimation(`Missing visual rig clip ${this.resourceId}/${clipName} for ${intent}`);
      return;
    }
    if (!Number.isFinite(next.getClip().duration) || next.getClip().duration <= 0) {
      this.failAnimation(`Invalid visual rig clip duration ${this.resourceId}/${clipName}`);
      return;
    }
    this.stopVisualRigActions();
    next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1);
    if (actionState) {
      next.paused = false;
      next.setLoop(actionState.loop ? THREE.LoopRepeat : THREE.LoopOnce, actionState.loop ? Infinity : 1);
      next.clampWhenFinished = !actionState.loop;
      next.play();
      this.activeAction = next;
      this.mixer!.update(0);
      this.setAnimationFinished(false);
      return;
    }
    if (!Number.isFinite(poseState!.timeSeconds) || poseState!.timeSeconds < 0 || poseState!.timeSeconds > next.getClip().duration) {
      this.failAnimation(`Invalid visual rig pose time ${this.resourceId}/${intent}`);
      return;
    }
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
    next.play();
    next.time = Math.min(next.getClip().duration, poseState!.timeSeconds);
    this.activeAction = next;
    this.mixer!.update(0);
    next.paused = true;
    this.zeroTinyMorphWeights();
    this.setAnimationFinished(true);
  }
  private stopVisualRigActions(): void {
    this.mixer?.stopAllAction();
    for (const action of this.actions.values()) {
      action.stop(); action.paused = false; action.enabled = true; action.setEffectiveWeight(1);
    }
    this.activeAction = undefined;
    this.model?.traverse(object => {
      if (object instanceof THREE.Mesh && object.morphTargetInfluences) object.morphTargetInfluences.fill(0);
    });
  }
  private zeroTinyMorphWeights(): void {
    this.model?.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.morphTargetInfluences) return;
      for (let i = 0; i < object.morphTargetInfluences.length; i++) {
        if (Math.abs(object.morphTargetInfluences[i]) < 1e-6) object.morphTargetInfluences[i] = 0;
      }
    });
  }
  private applyInteractions(deltaSeconds: number): void {
    if (!this.model) return;
    for (const [name, interaction] of Object.entries(this.visualRig?.interactions ?? {})) {
      if (!Number.isFinite(interaction.durationSeconds) || interaction.durationSeconds <= 0 || !interaction.transforms.length) {
        this.markPlaceholder(`Invalid visual rig interaction ${this.resourceId}/${name}`);
        continue;
      }
      let amount = 0;
      if (interaction.mode === 'toggle') {
        const state = this.toggles.get(name) ?? { progress: 0, target: 0 as const };
        this.toggles.set(name, state);
        const step = deltaSeconds / interaction.durationSeconds;
        state.progress = state.target > state.progress ? Math.min(state.target, state.progress + step)
          : Math.max(state.target, state.progress - step);
        amount = state.progress;
      } else {
        const state = this.pulses.get(name);
        if (state) {
          state.elapsed = Math.min(interaction.durationSeconds, state.elapsed + deltaSeconds);
          amount = Math.sin(Math.PI * state.elapsed / interaction.durationSeconds);
          if (state.elapsed >= interaction.durationSeconds) this.pulses.delete(name);
        }
      }
      for (const transform of interaction.transforms) {
        const node = this.model.getObjectByName(transform.node);
        const expected = transform.property === 'position' ? 3 : 4;
        if (!node || transform.closed.length !== expected || transform.open.length !== expected
          || ![...transform.closed, ...transform.open].every(Number.isFinite)) {
          this.markPlaceholder(`Invalid visual rig interaction node ${this.resourceId}/${name}/${transform.node}`);
          continue;
        }
        if (transform.property === 'position') {
          this.interactionPosition.set(transform.closed[0], transform.closed[1], transform.closed[2]).lerp(
            this.interactionOpenPosition.set(transform.open[0], transform.open[1], transform.open[2]), amount,
          );
          node.position.copy(this.interactionPosition);
        } else {
          this.interactionClosedQuaternion.fromArray(transform.closed as [number, number, number, number]).normalize();
          this.interactionOpenQuaternion.fromArray(transform.open as [number, number, number, number]).normalize();
          this.interactionQuaternion.copy(this.interactionClosedQuaternion).slerp(this.interactionOpenQuaternion, amount);
          node.quaternion.copy(this.interactionQuaternion);
        }
      }
    }
  }
  private failAnimation(message: string): void {
    this.stopVisualRigActions();
    this.setAnimationFinished(true);
    this.markPlaceholder(message);
  }
  private markPlaceholder(message: string): void {
    this.placeholder.visible = true;
    this.root.userData.developmentPlaceholder = true;
    this.warn(`${message}; DEVELOPMENT wireframe placeholder`);
  }
  private cloneSignalMaterials(model: THREE.Object3D): boolean {
    const configured = this.visualRig?.signalMaterials;
    if (!configured?.length) return true;
    const wanted = new Set(configured);
    const found = new Set<string>();
    const unsupported = new Set<string>();
    const clones = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    const clone = (material: THREE.Material): THREE.Material => {
      if (!wanted.has(material.name)) return material;
      found.add(material.name);
      if (!(material instanceof THREE.MeshStandardMaterial)) { unsupported.add(material.name); return material; }
      let instance = clones.get(material);
      if (!instance) {
        instance = material.clone();
        clones.set(material, instance);
        this.signalMaterials.add(instance);
      }
      return instance;
    };
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.material = Array.isArray(object.material) ? object.material.map(clone) : clone(object.material);
    });
    const missing = [...wanted].filter(name => !found.has(name));
    if (!missing.length && !unsupported.size) return true;
    this.warn(`Missing visual rig signal materials ${this.resourceId}: ${[...missing, ...unsupported].join(', ')}; DEVELOPMENT wireframe placeholder`);
    return false;
  }
  private cloneMaterialColors(model: THREE.Object3D, configured?: Readonly<Record<string, number>>, requireAll = true): boolean {
    if (!configured || !Object.keys(configured).length) return true;
    const found = new Set<string>();
    const unsupported = new Set<string>();
    const clones = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    const tint = (material: THREE.Material): THREE.Material => {
      const color = configured[material.name];
      if (color === undefined) return material;
      found.add(material.name);
      if (!(material instanceof THREE.MeshStandardMaterial)) { unsupported.add(material.name); return material; }
      let instance = clones.get(material);
      if (!instance) {
        instance = material.clone();
        instance.color.setHex(color);
        instance.needsUpdate = true;
        clones.set(material, instance);
        this.coloredMaterials.add(instance);
      }
      return instance;
    };
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.material = Array.isArray(object.material) ? object.material.map(tint) : tint(object.material);
    });
    const missing = requireAll ? Object.keys(configured).filter(name => !found.has(name)) : [];
    if (!missing.length && !unsupported.size) return true;
    this.warn(`Missing actor palette materials ${this.resourceId}: ${[...missing, ...unsupported].join(', ')}; DEVELOPMENT wireframe placeholder`);
    return false;
  }
  private releaseModel(): void {
    this.mixer?.stopAllAction();
    this.mixer?.removeEventListener('finished', this.finished);
    if (this.model) {
      this.mixer?.uncacheRoot(this.model);
      const skeletons = new Set<THREE.Skeleton>();
      this.model.traverse(object => { if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton); });
      for (const skeleton of skeletons) skeleton.dispose();
      this.model.removeFromParent();
    }
    for (const material of this.signalMaterials) material.dispose();
    for (const material of this.coloredMaterials) material.dispose();
    this.signalMaterials.clear();
    this.coloredMaterials.clear();
    this.model = undefined; this.mixer = undefined; this.activeAction = undefined;
    this.actions.clear(); this.clipNames.clear(); this.attachments.clear();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.releaseModel();
    this.placeholder.geometry.dispose(); this.placeholder.material.dispose(); this.root.removeFromParent();
  }
}
function resourceIdLabel(id: string, socket: string): string { return `${id}/${socket}`; }
