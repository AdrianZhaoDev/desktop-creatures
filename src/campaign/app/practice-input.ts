import type { CampaignInputAdapter, CampaignGrabEvent } from './input';
import type { CampaignProductionRuntime } from './runtime';
import type { Point } from '../native/types';

/** Browser practice transport. These are DOM pointer gestures, not native validation evidence. */
export function bindPracticeInput(root: HTMLElement, input: CampaignInputAdapter, runtime: CampaignProductionRuntime,
  remember: (point: Point) => void): () => void {
  let sequence = 0, active: CampaignGrabEvent | null = null;
  let suppressClick = false;
  const gesture = (event: PointerEvent) => {
    const point = { x: event.clientX, y: event.clientY }; remember(point);
    if (!event.isTrusted || !runtime.acceptingInput) return;
    if (event.type === 'pointerdown') {
      const region = input.regions().filter(r => Math.abs(point.x - r.centerDip.x) <= r.halfExtentDip.x && Math.abs(point.y - r.centerDip.y) <= r.halfExtentDip.y)
        .sort((a, b) => b.priority - a.priority)[0];
      // Native UI controls continue to receive ordinary browser events.
      if (!region || region.target.kind === 'ui') return;
      const scope = runtime.scope();
      active = { type: 'grab', scope, target: { ...region.target, runId: scope.runId }, toolId: region.toolId ?? null,
        grab: { sessionId: ++sequence, entityId: sequence, kind: `campaign-${region.target.kind}`, phase: 'start',
          displayId: scope.displayId, screenPhysical: point, localDip: point, overTrashBin: false, timestampMs: Date.now() } };
    } else if (active) active = { ...active, grab: { ...active.grab, phase: event.type === 'pointerup' ? 'end' : event.type === 'pointercancel' ? 'cancel' : 'move',
      screenPhysical: point, localDip: point, timestampMs: Date.now() } };
    else return;
    event.preventDefault(); event.stopPropagation();
    suppressClick = true; input.handleGrab(active);
    if (active.grab.phase === 'end' || active.grab.phase === 'cancel') active = null;
  };
  const click = (event: MouseEvent) => { if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopPropagation(); } };
  const cancel = () => {
    if (active) input.handleGrab({ ...active, grab: { ...active.grab, phase: 'cancel' } }); active = null;
  };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) root.ownerDocument.addEventListener(type, gesture as EventListener, true);
  root.ownerDocument.addEventListener('click', click, true); root.ownerDocument.addEventListener('keydown', escape, true);
  root.ownerDocument.defaultView?.addEventListener('blur', cancel);
  return () => {
    cancel();
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) root.ownerDocument.removeEventListener(type, gesture as EventListener, true);
    root.ownerDocument.removeEventListener('click', click, true); root.ownerDocument.removeEventListener('keydown', escape, true);
    root.ownerDocument.defaultView?.removeEventListener('blur', cancel);
  };
}
