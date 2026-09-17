import * as THREE from "three";

interface Clip { name: string; startFrame: number; frameCount: number; duration: number; loop?: boolean }
interface Vat { meshHash: string; textureWidth: number; textureHeight: number; rowsPerFrame: number; clips: Clip[]; position: {file:string}; normal:{file:string} }
export interface VatAnimation { clips: Clip[]; attribute: THREE.InstancedBufferAttribute; dispose():void }

/** Baked glTF-space skinning, lit by the same PBR material as the skeletal path. */
export async function attachVat(mesh: THREE.InstancedMesh, indexPath: string): Promise<VatAnimation> {
  const json=async <T>(url:string):Promise<T>=>{const r=await fetch(url);if(!r.ok)throw new Error(`VAT ${r.status}: ${url}`);return await r.json() as T;};
  const indexUrl=new URL(indexPath,location.origin);
  const index=await json<{lods:Array<{id:string;vat:string;meshHash:string}>}>(indexUrl.href);
  const lod=index.lods.find(l=>l.id==="lod1")!;
  const url=new URL(lod.vat,indexUrl),meta=await json<Vat>(url.href);
  if(meta.meshHash!==lod.meshHash)throw new Error("VAT 网格不匹配");
  const texture=async(file:string):Promise<THREE.DataTexture>=>{
    const r=await fetch(new URL(file,url));if(!r.ok)throw new Error("VAT 纹理读取失败");
    const a=new Float32Array(await r.arrayBuffer());if(a.length!==meta.textureWidth*meta.textureHeight*4)throw new Error("VAT 纹理大小错误");
    const t=new THREE.DataTexture(a,meta.textureWidth,meta.textureHeight,THREE.RGBAFormat,THREE.FloatType);t.minFilter=t.magFilter=THREE.NearestFilter;t.needsUpdate=true;return t;
  };
  const [positions,normals]=await Promise.all([texture(meta.position.file),texture(meta.normal.file)]);
  const count=mesh.geometry.getAttribute("position").count;
  mesh.geometry.setAttribute("vertexIndex",new THREE.BufferAttribute(Float32Array.from({length:count},(_,i)=>i),1));
  const attribute=new THREE.InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count*4),4).setUsage(THREE.DynamicDrawUsage);
  mesh.geometry.setAttribute("vatFrame",attribute);
  for(const material of (Array.isArray(mesh.material)?mesh.material:[mesh.material])) {
    material.onBeforeCompile=shader=>{
      shader.uniforms.vatPositions={value:positions};shader.uniforms.vatNormals={value:normals};
      shader.vertexShader=`attribute float vertexIndex; attribute vec4 vatFrame; uniform sampler2D vatPositions; uniform sampler2D vatNormals;
      vec3 vatRead(sampler2D t,float frame){float px=mod(vertexIndex,${meta.textureWidth}.0);float py=floor(vertexIndex/${meta.textureWidth}.0)+frame*${meta.rowsPerFrame}.0;vec3 v=texture2D(t,vec2((px+.5)/${meta.textureWidth}.0,(py+.5)/${meta.textureHeight}.0)).xyz;return vec3(v.x,-v.z,v.y);}
      vec3 vatSample(sampler2D t){return mix(vatRead(t,vatFrame.x),vatRead(t,vatFrame.y),vatFrame.z);}
      `+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>','vec3 objectNormal = normalize(vatSample(vatNormals));').replace('#include <begin_vertex>','vec3 transformed = vatSample(vatPositions);');
    };
    material.customProgramCacheKey=()=>`game-vat-${meta.textureWidth}-${meta.textureHeight}-${meta.rowsPerFrame}`;
    material.needsUpdate=true;
  }
  return {clips:meta.clips,attribute,dispose(){positions.dispose();normals.dispose();}};
}

export function setVatFrame(vat:VatAnimation,index:number,name:string,seconds:number,phase:number):void {
  const clip=vat.clips.find(c=>c.name===name)??vat.clips[0];
  if (clip.loop === false) {
    const frame = Math.max(0, Math.min(1, seconds / clip.duration)) * (clip.frameCount - 1), base = Math.floor(frame);
    vat.attribute.setXYZW(index, clip.startFrame + base, clip.startFrame + Math.min(base + 1, clip.frameCount - 1), frame - base, 0);
    return;
  }
  const frame=((seconds/clip.duration+phase)%1+1)%1*clip.frameCount,base=Math.floor(frame);
  vat.attribute.setXYZW(index,clip.startFrame+base,clip.startFrame+(base+1)%clip.frameCount,frame-base,0);
}
