import type { HitIdentity, HitTarget, InteractionHandleScope } from '../integration/hit-handles';
import type { SurfaceSnapshotV2 } from '../surface';
export interface Point { x: number; y: number }
export interface CampaignDisplayInfo {
  id: string; name: string | null; primary: boolean; scaleFactor: number;
  position: Point; size: { width: number; height: number };
}
export interface CampaignDisplayState {
  ownerLabel: 'overlay-primary'; displayId: string | null; displays: CampaignDisplayInfo[];
  topologyRevision: number; bindingGeneration: number;
  phase: 'ready' | 'moving' | 'awaiting-surface' | 'disconnected' | 'topology-changed' | 'failed';
  error: string | null;
}
export interface CampaignHitRegion {
  target: HitTarget;
  centerDip: Point;
  halfExtentDip: Point;
  rotationRad: number;
  priority: number;
  /** Tool-gated regions name their tool; houses may use null (or omit it) for direct dragging. */
  toolId?: string | null;
}
export interface NativeRegion {
  entityId: number; kind: string; centerDip: Point; halfExtentDip: Point; rotationRad: number; priority: number;
}
export interface NativeGrab {
  bindingGeneration?: number;
  sessionId: number; phase: 'start' | 'move' | 'end' | 'cancel'; entityId: number; kind: string;
  displayId: string; screenPhysical: Point; localDip: Point; overTrashBin: boolean; timestampMs: number;
}
export interface BinGeometry { x: number; y: number; width: number; height: number; scale: number; mouthX: number; mouthY: number }
export type CancelReason = 'escape' | 'blur' | 'hidden' | 'display-change' | 'scope-change' | 'tool-change' | 'paused' | 'surface-invalid' | 'dispose' | 'native-cancel' | 'quit';
export type NativeCampaignRuntimeEvent =
  | { type: 'grab'; scope: InteractionHandleScope; target: HitIdentity; grab: NativeGrab; toolId: string | null; cancelReason?: CancelReason }
  | { type: 'surface'; scope: InteractionHandleScope; surface: SurfaceSnapshotV2 }
  | { type: 'bin-geometry'; geometry: BinGeometry | null }
  | { type: 'pause'; source: 'native' | 'surface' | 'visibility'; paused: boolean }
  | { type: 'diagnostic'; code: string; message: string }
  | { type: 'save-requested'; scope: InteractionHandleScope }
  | { type: 'quit-requested'; scope: InteractionHandleScope; /** Call ONLY after awaiting a successful checkpoint. */ finishExit: () => Promise<void> };
export type Unlisten = () => void;
/** Host callbacks expose payloads, not Tauri's event envelope. All operations can be faked in tests. */
export interface NativeCampaignHost {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, callback: (payload: unknown) => void): Promise<Unlisten>;
  every(milliseconds: number, callback: () => void): Unlisten;
  now(): number;
  onLifecycle(callback: (event: 'escape' | 'blur' | 'hidden' | 'visible') => void): Unlisten;
}
