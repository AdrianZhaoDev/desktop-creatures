import type { GameEntity } from "../game/types";
export interface Point { x: number; y: number }
export type WorkPolicy = "balanced" | "garbage" | "roach" | "rest";
export const ACTIONS = ["idle", "run", "climb", "clean", "catch", "carry", "deposit", "lie", "sleep", "wake", "shake", "fall", "land"] as const;
export type CoreCompanionAction = typeof ACTIONS[number];
export type CompanionAction = CoreCompanionAction | "special";
export interface SpecialAction { id: string; label: string; clip: string }
export interface CompanionState extends Point {
  displayId: string; bedX: number; floorY: number; stamina: number;
  policy: WorkPolicy; avatarId: string; bedId: string;
  action: CompanionAction; facing: number; actionTime: number;
  motionDistance?: number;
  inventory: GameEntity[];
  specialId?: string;
  homePulse?: number;
  homeExitX?: number;
}
export interface CompanionTask { kind: "collect" | "deposit" | "rest"; targetId?: number; goal: Point; path: Point[]; revision: number; progress: number }
export interface DesktopSurfaceSnapshot {
  displayId: string; revision: number; capturedAtMs: number; valid: boolean;
  width: number; height: number; floorY: number; cellDip: number;
  columns: number; rows: number; cells: number[]; error?: string;
}
export interface CompanionAssetManifest {
  schemaVersion: 1; assetKind: "companion"; id: string; name: string;
  model: string; heightDip: number; modelHeight: number;
  actions: Record<CoreCompanionAction, string>; sockets: { hand: string; bag: string };
  homeId?: string;
  revision?: string;
  groundCycleDistance?: number;
  specialActions?: SpecialAction[];
  actionProps?: {node:string;actions:string[]}[];
  contacts?: {joint:string;tip:[number,number,number]}[];
  license: string;
}
export interface BedAssetManifest {
  schemaVersion: 1; assetKind: "bed"; id: string; name: string; model: string;
  widthDip: number; modelWidth: number; sleepAnchor: [number, number, number]; license: string;
  heightDip?: number;
  reactiveNodes?: {node:string;axis:"x"|"y"|"z";strength:number}[];
  portal?: {kind:"television";sleepScale:number;entrance:[number,number,number]};
  effects?: {staticNode?:string};
}
export type AssetManifest = CompanionAssetManifest | BedAssetManifest;
export function initialCompanion(width: number, height: number): CompanionState {
  return { displayId: "primary", bedX: Math.min(140,width/2), floorY: height-48, x: Math.max(28,Math.min(width-28,Math.min(140,width/2)+159.3)), y: height-48,
    stamina: 100, policy: "balanced", avatarId: "companion.mimi", bedId: "home.mimi", action: "idle", facing: 1, actionTime: 0, motionDistance: 0, inventory: [] };
}
