import "./trash.css";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { CatBinAudio } from "./cat-bin-audio";
import { BinMotion } from "./bin-motion";
import type { GameEntity, GrabEvent } from "../game/types";

const native="__TAURI_INTERNALS__" in window,button=document.querySelector<HTMLButtonElement>("#trash-bin")!;
const BIN_WIDTH_DIP=76,BIN_HEIGHT_DIP=88;
// Inspection scales the same renderer; native geometry remains owned by Rust.
const params=new URLSearchParams(location.search),preview=!native&&params.get("preview")==="1";
const renderScale=preview?5:1,forcedPose=preview?params.get("pose"):null;
if(preview)document.documentElement.classList.add("bin-preview");
const audio=new CatBinAudio(),channel=new BroadcastChannel("desktop-creatures-bin-v2"),motion=new BinMotion();
if(native)audio.enabled=false;
const reducedMotion=matchMedia("(prefers-reduced-motion: reduce)");
let hover=false,focused=false,dragOver=false,dragged=false,busy=false,openness=0,previous=performance.now(),happyUntil=0;
let binModel:THREE.Group|undefined;
const eyes:THREE.Object3D[]=[],happyEyes:THREE.Object3D[]=[],eyeMaterials=new Set<THREE.MeshStandardMaterial>();
let lidMixer:THREE.AnimationMixer|undefined,lidAction:THREE.AnimationAction|undefined;
let fall: {group:THREE.Group;age:number;sessionId:number;kind:GameEntity["kind"];start:THREE.Vector3}|undefined;
const renderer=new THREE.WebGLRenderer({canvas:document.querySelector<HTMLCanvasElement>("#bin-canvas")!,alpha:true,antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(BIN_WIDTH_DIP*renderScale,BIN_HEIGHT_DIP*renderScale,false);renderer.setClearColor(0,0);renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.87;
const scene=new THREE.Scene();scene.add(new THREE.HemisphereLight(0xffebce,0x5e626e,1.15));
const light=new THREE.DirectionalLight(0xffe2b5,2.8);light.position.set(-3,5,6);scene.add(light);
const fill=new THREE.DirectionalLight(0xd9e6ff,.95);fill.position.set(4,2,-2);scene.add(fill);
const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();
const environment=pmrem.fromScene(room,.04);scene.environment=environment.texture;scene.environmentIntensity=.45;room.dispose();pmrem.dispose();
const camera=new THREE.OrthographicCamera(-1.123,1.123,1.30,-1.30,.01,20);camera.position.set(-2.3,2.1,5.8);camera.lookAt(0,1.04,0);camera.updateMatrixWorld();
const loader=new GLTFLoader(),models=new Map<string,Promise<THREE.Group>>();
const model=(url:string):Promise<THREE.Group>=>{let p=models.get(url);if(!p){p=loader.loadAsync(url).then(g=>g.scene);models.set(url,p);}return p;};
const announce=(name:string,payload:unknown):void=>{if(native)void emit(name,payload);else channel.postMessage({name,payload});};
const cancelled=new Set<number>();
const packs:Record<string,string>={german:"germanica","brown-banded":"brownbanded",oriental:"orientalis",american:"americana",hisser:"hissing"};

async function receive(payload:{sessionId:number;entity:GameEntity;sizeDip:number;screenPhysical?:{x:number;y:number}}):Promise<void> {
  if(busy){announce("bin://received",{sessionId:payload.sessionId,ok:false});return;}busy=true;dragOver=true;cancelled.delete(payload.sessionId);
  try {
    const e=payload.entity;
    const path=e.kind==="garbage" ? `/game/props/${(e.garbageTypeId??`food.${String(Number(e.qualityId.slice(1))).padStart(2,"0")}`).replace("food.","food-")}-${e.consumedFraction>=.95?"residue":e.consumedFraction>=.45?"half":"full"}.glb` : `/game/${packs[e.speciesId]}/${e.kind==="egg"?"egg":e.stageId==="newborn"||e.stageId==="small"?"early":e.stageId==="medium"?"late":"adult"}/lod1.glb`;
    const group=new THREE.Group(),asset=clone(await model(path));const box=new THREE.Box3().setFromObject(asset),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    asset.position.sub(center);group.add(asset);group.scale.setScalar(Math.min(payload.sizeDip,28)/BIN_HEIGHT_DIP*2.5/Math.max(size.x,size.z,.01));
    const start=new THREE.Vector3(0,1.5,.1);
    if(native && payload.screenPhysical){
      const geo=await invoke<{x:number;y:number;width:number;height:number}>("bin_geometry");
      const ndc=new THREE.Vector2((payload.screenPhysical.x-geo.x)/geo.width*2-1,1-(payload.screenPhysical.y-geo.y)/geo.height*2);
      const ray=new THREE.Raycaster();ray.setFromCamera(ndc,camera);ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-1.5),start);start.clamp(new THREE.Vector3(-.6,1.5,-.4),new THREE.Vector3(.6,1.5,.6));
    }
    if(cancelled.delete(payload.sessionId)){busy=false;dragOver=false;return;}
    group.position.copy(start);scene.add(group);fall={group,age:0,sessionId:payload.sessionId,kind:e.kind,start};
  }catch(error){busy=false;dragOver=false;announce("bin://received",{sessionId:payload.sessionId,ok:false});console.warn(error);}
}
button.addEventListener("pointerenter",()=>{hover=true;});button.addEventListener("pointerleave",()=>{hover=false;});
button.addEventListener("focus",()=>{focused=button.matches(":focus-visible");});button.addEventListener("blur",()=>{focused=false;});
button.addEventListener("pointerdown",()=>{dragged=false;focused=false;audio.unlock();});
button.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" ")audio.unlock();});
button.addEventListener("pointermove",event=>{if((event.buttons&1)!==0&&!dragged&&!dragOver&&!busy){dragged=true;if(native)void invoke("start_bin_drag");}});
button.addEventListener("dblclick",event=>{event.preventDefault();if(native)void invoke("open_recycle_bin");});
button.addEventListener("contextmenu",event=>{event.preventDefault();if(native)void invoke("show_game_menu");});
if(native){
  void listen<GrabEvent>("game://grab",({payload:e})=>{dragOver=(e.phase==="start"||e.phase==="move")&&e.overTrashBin;});
  void listen<Parameters<typeof receive>[0]>("bin://receive",({payload})=>{void receive(payload);});
  void listen("bin://celebrate",()=>{happyUntil=performance.now()+1300;audio.play("receive");});
  void listen<{sessionId:number}>("bin://cancel",({payload})=>{cancelled.add(payload.sessionId);if(fall?.sessionId===payload.sessionId){scene.remove(fall.group);fall=undefined;busy=false;dragOver=false;cancelled.delete(payload.sessionId);}});
  void listen<boolean>("game://audio",({payload})=>{audio.enabled=payload;});
  void listen<{master:number;effects:number}>("bin://audio-settings",({payload})=>{
    const volume=payload.master*payload.effects;
    audio.volume=volume;audio.enabled=Number.isFinite(volume)&&volume>0;
  }).then(()=>emit("bin://audio-request")).catch(error=>console.warn("Bin audio settings unavailable",error));
  void listen("tauri://drag-enter",()=>{dragOver=true;});
  void listen("tauri://drag-leave",()=>{dragOver=false;});
  void listen("tauri://drag-drop",()=>{dragOver=false;});
  void listen<{Ok?:boolean}>("trash://external-result",({payload})=>{if(payload.Ok){happyUntil=performance.now()+1300;audio.play("receive");}});
  setInterval(()=>{void invoke<{x:number;y:number}>("cursor_position_local").then(p=>{hover=p.x>=0&&p.x<BIN_WIDTH_DIP&&p.y>=0&&p.y<BIN_HEIGHT_DIP;}).catch(()=>undefined);},80);
}
channel.onmessage=e=>{if(e.data.name==="bin://receive")void receive(e.data.payload);};
if(preview)window.addEventListener("message",event=>{
  if(event.origin===location.origin&&event.source===parent&&event.data?.type==="cat-bin:enable-audio")audio.unlock();
});
async function boot():Promise<void>{
  const gltf=await loader.loadAsync("/game/props/bin-cat.glb");binModel=gltf.scene;scene.add(gltf.scene);
  gltf.scene.traverse(object=>{
    if(/^Eye_[LR]$/.test(object.name))eyes.push(object);
    if(/^HappyEye_[LR]$/.test(object.name)){happyEyes.push(object);object.visible=false;}
    if(object instanceof THREE.Mesh){
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials)if(material instanceof THREE.MeshStandardMaterial&&material.name==="EyeWarm_Emissive")eyeMaterials.add(material);
    }
  });
  lidMixer=new THREE.AnimationMixer(gltf.scene);const clip=gltf.animations.find(c=>c.name==="BinOpen");if(clip){lidAction=lidMixer.clipAction(clip);lidAction.setLoop(THREE.LoopOnce,1);lidAction.clampWhenFinished=true;lidAction.play();lidAction.paused=true;}
  if(native){const intake=new THREE.Vector3(0,1.12,0).project(camera);await invoke("set_bin_intake",{xDip:(intake.x+1)*BIN_WIDTH_DIP/2,yDip:(1-intake.y)*BIN_HEIGHT_DIP/2});}
  button.classList.add("model-ready");
}
void boot().catch(error=>{button.title=`垃圾桶模型加载失败：${String(error)}`;console.error(error);});
function frame(now:number):void{
  const dt=Math.min((now-previous)/1000,.05);previous=now;
  const active=forcedPose?forcedPose==="open":hover||focused||dragOver||busy||now<happyUntil;
  const sound=motion.step(dt,active,reducedMotion.matches);openness=motion.openness;
  if(sound&&binModel&&!forcedPose)audio.play(sound);
  if(lidAction&&lidMixer){lidAction.time=motion.pose*lidAction.getClip().duration;lidMixer.update(0);}
  button.dataset.openness=openness.toFixed(3);
  button.dataset.expression=now<happyUntil?"happy":openness>.1?"awake":"idle";
  const happy=now<happyUntil,blink=!reducedMotion.matches&&!happy&&now%6100>5910;
  for(const eye of eyes){eye.visible=!happy;eye.scale.y=blink?.14:1;}
  for(const eye of happyEyes)eye.visible=happy;
  for(const material of eyeMaterials){material.color.set(happy||openness>.1?0xffcd85:0x71695f);material.emissive.set(0xffb84e);material.emissiveIntensity=happy?2.3:openness*2;}
  button.setAttribute("aria-label",openness>.5?"猫耳垃圾桶，盖子已打开":"猫耳垃圾桶，悬浮打开");
  if(fall&&openness>=.99){
    fall.age+=dt;const t=Math.min(fall.age/.65,1),curve=t*t*(3-2*t);
    fall.group.position.lerpVectors(fall.start,new THREE.Vector3(0,.12,0),curve);fall.group.rotation.z=Math.sin(t*Math.PI)*.35;
    if(t>=1){const done=fall;scene.remove(done.group);fall=undefined;busy=false;dragOver=false;happyUntil=now+1300;audio.play("receive");announce("bin://received",{sessionId:done.sessionId,ok:true});}
  }
  renderer.render(scene,camera);requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.addEventListener("pagehide",()=>{audio.dispose();channel.close();environment.dispose();},{once:true});
