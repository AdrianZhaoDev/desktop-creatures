import * as THREE from 'three';
import type { VatAnimation } from '../../game/vat';

interface Clip { name: string; startFrame: number; frameCount: number; duration: number; loop?: boolean }
interface Entry { id: string; vat: string; mesh: string; meshHash: string; sourceModel: string; sourceModelHash: string; vertexCount: number }
interface Binary { file: string; byteLength: number; sha256: string }
interface Metadata {
  schemaVersion: number; id: string; textureEncoding: string; coordinateSpace: string; rootMotion: boolean;
  mesh: string; meshHash: string; sourceModel: string; sourceModelHash: string; vertexCount: number;
  textureWidth: number; textureHeight: number; rowsPerFrame: number; totalFrames: number;
  clips: Clip[]; position: Binary; normal: Binary;
}
interface Attribute { byteOffset: number; byteLength: number; componentType: string; itemSize: number; count: number }
interface MeshMetadata {
  schemaVersion: number; id: string; coordinateSpace: string; meshHash: string; sourceModel: string; sourceModelHash: string;
  data: string; byteLength: number; vertexCount: number; attributes: Record<string, Attribute>; index: Attribute;
}
export interface CampaignVatOptions { fetch?: typeof fetch }
export interface CampaignVatSource {
  readonly vertexCount: number;
  /** The caller must own this mesh's geometry and materials; frames are per instance/chunk. */
  attach(mesh: THREE.InstancedMesh): VatAnimation;
  dispose(): void;
}
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Campaign VAT: ${message}`);
};
function absolute(path: string, base?: string): string {
  return new URL(path, base ?? (typeof location === 'undefined' ? 'http://localhost/' : location.origin)).href;
}
async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function values(bytes: ArrayBuffer, attribute: Attribute, count: number, itemSize: number, type = 'float32'): Float32Array | Uint32Array {
  assert(attribute && attribute.componentType === type && attribute.itemSize === itemSize && attribute.count === count, 'mesh attribute contract mismatch');
  assert(Number.isSafeInteger(attribute.byteOffset) && attribute.byteOffset >= 0 && attribute.byteOffset % 4 === 0
    && attribute.byteLength === count * itemSize * 4 && attribute.byteOffset + attribute.byteLength <= bytes.byteLength, 'mesh attribute bounds mismatch');
  return type === 'float32' ? new Float32Array(bytes, attribute.byteOffset, count * itemSize) : new Uint32Array(bytes, attribute.byteOffset, count * itemSize);
}

/** Compare the actual parsed GLB against the hashed bake mesh, including vertex order.
 * Mirrors the offline bake's scene-space bind-pose convention; rejects multiple meshes.
 */
function verifyModel(model: THREE.Group, meta: MeshMetadata, bytes: ArrayBuffer): void {
  const meshes: THREE.Mesh[] = [];
  model.updateMatrixWorld(true);
  model.traverse(node => { if (node instanceof THREE.Mesh) meshes.push(node); });
  assert(meshes.length === 1, 'VAT requires exactly one mesh; multiple parts are unsupported');
  const mesh = meshes[0], geometry = mesh.geometry, count = meta.vertexCount;
  assert(geometry.getAttribute('position')?.count === count, 'actual GLB vertex count mismatch');
  assert(!Array.isArray(mesh.material) || mesh.material.length === 1, 'VAT requires one source material');
  const indexCount = geometry.index?.count ?? count;
  const index = values(bytes, meta.index, indexCount, 1, 'uint32');
  for (let i = 0; i < indexCount; i++) assert(index[i] < count && index[i] === (geometry.index?.getX(i) ?? i), 'actual GLB index order mismatch');
  for (const name of ['color', 'uv']) {
    const attribute = geometry.getAttribute(name), description = meta.attributes[name];
    assert(Boolean(attribute) === Boolean(description), `actual GLB ${name} presence mismatch`);
    if (!attribute) continue;
    const size = name === 'uv' ? 2 : 3, expected = values(bytes, description, count, size);
    for (let i = 0; i < count; i++) for (let j = 0; j < size; j++) {
      assert(Number.isFinite(expected[i * size + j]) && Math.abs(attribute.getComponent(i, j) - expected[i * size + j]) < 1e-5, `actual GLB ${name} vertex order mismatch`);
    }
  }
  const positions = values(bytes, meta.attributes.position, count, 3), normals = values(bytes, meta.attributes.normal, count, 3);
  const normal = geometry.getAttribute('normal');
  assert(normal?.count === count, 'actual GLB normals missing');
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  const indices = new THREE.Vector4(), weights = new THREE.Vector4();
  const bone = new THREE.Matrix4(), skin = new THREE.Matrix4(), worldNormal = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  if (mesh instanceof THREE.SkinnedMesh) mesh.skeleton.update();
  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(geometry.getAttribute('position'), i);
    n.fromBufferAttribute(normal, i);
    if (mesh instanceof THREE.SkinnedMesh) {
      mesh.applyBoneTransform(i, p);
      const skinIndex = geometry.getAttribute('skinIndex'), skinWeight = geometry.getAttribute('skinWeight');
      indices.set(skinIndex.getX(i), skinIndex.getY(i), skinIndex.getZ(i), skinIndex.getW(i));
      weights.set(skinWeight.getX(i), skinWeight.getY(i), skinWeight.getZ(i), skinWeight.getW(i));
      skin.elements.fill(0);
      for (let j = 0; j < 4; j++) {
        const weight = weights.getComponent(j);
        if (!weight) continue;
        assert(mesh.skeleton.boneMatrices, 'missing source bone matrices');
        bone.fromArray(mesh.skeleton.boneMatrices, indices.getComponent(j) * 16);
        for (let k = 0; k < 16; k++) skin.elements[k] += bone.elements[k] * weight;
      }
      skin.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
      n.transformDirection(skin);
    }
    p.applyMatrix4(mesh.matrixWorld); n.applyMatrix3(worldNormal).normalize();
    for (let j = 0; j < 3; j++) {
      assert(Number.isFinite(positions[i * 3 + j]) && Math.abs(p.getComponent(j) - positions[i * 3 + j]) < 1e-5, 'actual GLB position/vertex order mismatch');
      assert(Number.isFinite(normals[i * 3 + j]) && Math.abs(n.getComponent(j) - normals[i * 3 + j]) < 1e-5, 'actual GLB normal/vertex order mismatch');
    }
  }
}

/** Owns shared, verified VAT textures. Batches own the geometry/material/attribute bindings.
 * Both binaries are validated before creating GPU resources. Failed or late loads cannot
 * publish a partially usable source; disposing the cache also disposes completed sources.
 */
export class CampaignVatCache {
  private readonly requests = new Map<string, Promise<CampaignVatSource>>();
  private readonly sources = new Set<CampaignVatSource>();
  private readonly fetcher: typeof fetch;
  private disposed = false;
  constructor(options: CampaignVatOptions = {}) { this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis); }

  load(indexPath: string, lod: 'lod1' | 'lod2', model: THREE.Group, modelUrl: string): Promise<CampaignVatSource> {
    if (this.disposed) return Promise.reject(new Error('Campaign VAT cache is disposed'));
    const key = `${absolute(indexPath)}#${lod}`;
    const existing = this.requests.get(key);
    if (existing) return existing;
    const request = this.read(indexPath, lod, model, modelUrl);
    this.requests.set(key, request);
    return request;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const source of this.sources) source.dispose();
    this.sources.clear(); this.requests.clear();
  }

  private async json<T>(url: string): Promise<T> {
    const response = await this.fetcher(url);
    assert(response.ok, `metadata HTTP ${response.status}: ${url}`);
    return await response.json() as T;
  }
  private async bytes(url: string): Promise<ArrayBuffer> {
    const response = await this.fetcher(url);
    assert(response.ok, `binary HTTP ${response.status}: ${url}`);
    return response.arrayBuffer();
  }

  private async read(indexPath: string, lod: 'lod1' | 'lod2', model: THREE.Group, modelUrl: string): Promise<CampaignVatSource> {
    const indexUrl = absolute(indexPath);
    const index = await this.json<{ schemaVersion: number; lods: Entry[] }>(indexUrl);
    const entry = index.lods.find(value => value.id === lod);
    assert(index.schemaVersion === 1 && entry, 'LOD not present in supported index');
    const metaUrl = absolute(entry.vat, indexUrl), meta = await this.json<Metadata>(metaUrl);
    const meshUrl = absolute(meta.mesh, metaUrl), mesh = await this.json<MeshMetadata>(meshUrl);
    assert(meta.schemaVersion === 1 && mesh.schemaVersion === 1 && meta.id === lod && mesh.id === lod
      && meta.textureEncoding === 'float32-rgba-le' && meta.coordinateSpace === 'gltf-scene' && mesh.coordinateSpace === 'gltf-scene' && meta.rootMotion === false, 'unsupported bake coordinate/encoding contract');
    assert(entry.meshHash === meta.meshHash && meta.meshHash === mesh.meshHash
      && entry.sourceModelHash === meta.sourceModelHash && meta.sourceModelHash === mesh.sourceModelHash, 'metadata hash mismatch');
    const actualUrl = absolute(modelUrl);
    assert(absolute(entry.sourceModel, indexUrl) === actualUrl && absolute(meta.sourceModel, metaUrl) === actualUrl
      && absolute(mesh.sourceModel, meshUrl) === actualUrl && absolute(entry.mesh, indexUrl) === meshUrl, 'source model reference mismatch');
    assert(positive(meta.vertexCount) && meta.vertexCount <= 1_000_000 && entry.vertexCount === meta.vertexCount && mesh.vertexCount === meta.vertexCount, 'vertex count mismatch');
    assert(positive(meta.textureWidth) && positive(meta.textureHeight) && meta.textureWidth <= 8192 && meta.textureHeight <= 8192
      && positive(meta.totalFrames) && meta.rowsPerFrame === Math.ceil(meta.vertexCount / meta.textureWidth)
      && meta.textureHeight === meta.rowsPerFrame * meta.totalFrames, 'texture layout mismatch');
    let next = 0;
    assert(meta.clips.length > 0, 'clips missing');
    for (const clip of meta.clips) {
      assert(typeof clip.name === 'string' && clip.startFrame === next && positive(clip.frameCount) && Number.isFinite(clip.duration) && clip.duration > 0, 'invalid clip range');
      assert(clip.loop === undefined || typeof clip.loop === 'boolean', 'invalid clip loop mode');
      next += clip.frameCount;
    }
    assert(next === meta.totalFrames, 'clip total mismatch');
    const [meshBytes, glbBytes, positions, normals] = await Promise.all([
      this.bytes(absolute(mesh.data, meshUrl)), this.bytes(actualUrl),
      this.bytes(absolute(meta.position.file, metaUrl)), this.bytes(absolute(meta.normal.file, metaUrl)),
    ]);
    assert(meshBytes.byteLength === mesh.byteLength && await sha256(meshBytes) === meta.meshHash, 'mesh binary hash mismatch');
    assert(await sha256(glbBytes) === meta.sourceModelHash, 'source GLB hash mismatch');
    verifyModel(model, mesh, meshBytes);
    const expectedBytes = meta.textureWidth * meta.textureHeight * 16;
    const arrays: Float32Array[] = [];
    for (const [binary, descriptor] of [[positions, meta.position], [normals, meta.normal]] as const) {
      assert(binary.byteLength === expectedBytes && descriptor.byteLength === expectedBytes && await sha256(binary) === descriptor.sha256, 'VAT texture size/hash mismatch');
      const values = new Float32Array(binary);
      assert(values.every(Number.isFinite), 'nonfinite VAT texture');
      arrays.push(values);
    }
    assert(!this.disposed, 'cache disposed during load');
    const textures: THREE.DataTexture[] = [];
    try {
      for (const array of arrays) {
        const texture = new THREE.DataTexture(array, meta.textureWidth, meta.textureHeight, THREE.RGBAFormat, THREE.FloatType);
        textures.push(texture);
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false; texture.needsUpdate = true;
      }
      let released = false;
      const source: CampaignVatSource = {
        vertexCount: meta.vertexCount,
        attach(batch) {
          assert(!released && batch.geometry.getAttribute('position').count === meta.vertexCount, 'binding disposed or mismatched mesh');
          const vertices = new Float32Array(meta.vertexCount);
          for (let i = 0; i < vertices.length; i++) vertices[i] = i;
          batch.geometry.setAttribute('vertexIndex', new THREE.BufferAttribute(vertices, 1));
          const attribute = new THREE.InstancedBufferAttribute(new Float32Array(batch.instanceMatrix.count * 4), 4).setUsage(THREE.DynamicDrawUsage);
          batch.geometry.setAttribute('vatFrame', attribute);
          for (const material of Array.isArray(batch.material) ? batch.material : [batch.material]) {
            material.onBeforeCompile = shader => {
              shader.uniforms.vatPositions = { value: textures[0] }; shader.uniforms.vatNormals = { value: textures[1] };
              shader.vertexShader = `attribute float vertexIndex; attribute vec4 vatFrame; uniform sampler2D vatPositions; uniform sampler2D vatNormals;
vec3 vatRead(sampler2D t,float frame){float px=mod(vertexIndex,${meta.textureWidth}.0);float py=floor(vertexIndex/${meta.textureWidth}.0)+frame*${meta.rowsPerFrame}.0;vec3 v=texture2D(t,vec2((px+.5)/${meta.textureWidth}.0,(py+.5)/${meta.textureHeight}.0)).xyz;return vec3(v.x,-v.z,v.y);}
vec3 vatSample(sampler2D t){return mix(vatRead(t,vatFrame.x),vatRead(t,vatFrame.y),vatFrame.z);}
` + shader.vertexShader;
              shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = normalize(vatSample(vatNormals));')
                .replace('#include <begin_vertex>', 'vec3 transformed = vatSample(vatPositions);');
            };
            material.customProgramCacheKey = () => `campaign-vat-${meta.meshHash}`;
            material.needsUpdate = true;
          }
          return { clips: meta.clips, attribute, dispose() { /* cache owns shared textures */ } };
        },
        dispose() { if (released) return; released = true; for (const texture of textures) texture.dispose(); },
      };
      this.sources.add(source);
      return source;
    } catch (error) {
      for (const texture of textures) texture.dispose();
      throw error;
    }
  }
}
