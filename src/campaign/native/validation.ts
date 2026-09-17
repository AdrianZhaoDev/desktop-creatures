import type { SurfaceSnapshotV2 } from '../surface';
import type { BinGeometry, NativeGrab, Point, CampaignDisplayState } from './types';
export function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function object(value: unknown): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'expected plain native object');
}
export function uint(value: unknown, positive = false): asserts value is number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0), 'invalid native integer');
}
export function real(value: unknown): asserts value is number {
  check(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER, 'invalid native coordinate');
}
export function textId(value: unknown): asserts value is string { check(typeof value === 'string' && value.trim().length > 0, 'invalid ID'); }
export function point(value: unknown): asserts value is Point { object(value); real(value.x); real(value.y); }
export function parseDisplayState(value: unknown): CampaignDisplayState {
  object(value); check(value.ownerLabel === 'overlay-primary', 'invalid campaign owner');
  if (value.displayId !== null) textId(value.displayId);
  uint(value.topologyRevision); uint(value.bindingGeneration, true);
  check(['ready', 'moving', 'awaiting-surface', 'disconnected', 'topology-changed', 'failed'].includes(String(value.phase)), 'invalid display phase');
  check(value.error === null || typeof value.error === 'string', 'invalid display error');
  check(Array.isArray(value.displays), 'invalid displays');
  const ids = new Set<string>();
  for (const display of value.displays) {
    object(display); textId(display.id); check(!ids.has(display.id), 'duplicate display'); ids.add(display.id);
    check(display.name === null || typeof display.name === 'string', 'invalid display name');
    check(typeof display.primary === 'boolean', 'invalid display primary'); point(display.position);
    real(display.scaleFactor); check(display.scaleFactor > 0, 'invalid display scale');
    object(display.size); uint(display.size.width, true); uint(display.size.height, true);
  }
  check(value.phase !== 'ready' || ids.has(value.displayId as string), 'ready display unavailable');
  return structuredClone(value) as unknown as CampaignDisplayState;
}
export function parseGrab(value: unknown): NativeGrab {
  object(value); uint(value.sessionId, true); uint(value.entityId, true); uint(value.timestampMs);
  if (value.bindingGeneration !== undefined) uint(value.bindingGeneration, true);
  textId(value.displayId); textId(value.kind); point(value.localDip); point(value.screenPhysical);
  check(typeof value.phase === 'string' && ['start', 'move', 'end', 'cancel'].includes(value.phase), 'invalid grab phase');
  check(typeof value.overTrashBin === 'boolean', 'invalid bin flag');
  return structuredClone(value) as unknown as NativeGrab;
}
export function parseBin(value: unknown): BinGeometry {
  object(value); for (const key of ['x', 'y', 'width', 'height', 'scale', 'mouthX', 'mouthY']) real(value[key]);
  check((value.width as number) > 0 && (value.height as number) > 0 && (value.scale as number) > 0, 'invalid bin dimensions');
  return structuredClone(value) as unknown as BinGeometry;
}
export function parseSurface(value: unknown): SurfaceSnapshotV2 {
  object(value); check(value.schemaVersion === 2, 'invalid surface schema'); textId(value.displayId);
  for (const key of ['revision', 'capturedAtMs', 'verifiedAtMs']) uint(value[key]);
  check((value.verifiedAtMs as number) >= (value.capturedAtMs as number), 'surface clock order');
  check(typeof value.valid === 'boolean', 'invalid surface validity');
  for (const key of ['width', 'height', 'floorY']) real(value[key]);
  check((value.width as number) > 0 && (value.height as number) > 0 && (value.floorY as number) >= 0 && (value.floorY as number) <= (value.height as number), 'invalid surface dimensions');
  check(value.error === undefined || typeof value.error === 'string', 'invalid surface error');
  for (const key of ['platforms', 'grips'] as const) {
    const segments = value[key]; check(Array.isArray(segments), 'invalid segments');
    const ids = new Set<string>();
    for (const segment of segments) {
      object(segment); textId(segment.id); check(!ids.has(segment.id), 'duplicate segment ID'); ids.add(segment.id);
      uint(segment.version); real(segment.confidence); check(segment.confidence >= 0 && segment.confidence <= 1, 'invalid confidence');
      if (segment.expiresAtMs !== undefined) uint(segment.expiresAtMs);
      check(typeof segment.source === 'string' && (key === 'platforms' ? ['pixelEdge', 'textRow', 'screenBoundary'] : ['pixelEdge', 'screenBoundary']).includes(segment.source), 'invalid segment source');
      for (const coord of key === 'platforms' ? ['x1', 'x2', 'y'] : ['x', 'y1', 'y2']) real(segment[coord]);
      check(key === 'platforms' ? (segment.x2 as number) > (segment.x1 as number) : (segment.y2 as number) > (segment.y1 as number), 'invalid segment order');
    }
  }
  return structuredClone(value) as unknown as SurfaceSnapshotV2;
}
