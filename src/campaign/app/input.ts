import type { DevicePlacementContextPort } from '../application/campaign-application';
import type { CampaignReceiptAction } from '../audio/event-mapping';
import { collectItem, disposeBag, isPaused, isTerminal, type RunState } from '../campaign-controller';
import type { CampaignSessionV4 } from '../campaign-session-v4';
import { isLive } from '../combat-ecology';
import { moveHome } from '../homes';
import type { InteractionHandleScope } from '../integration/hit-handles';
import type { CampaignHitRegion, NativeCampaignRuntimeEvent, Point } from '../native/types';
import { isSurfaceSegmentLive, type SurfaceSnapshotV2 } from '../surface';
import { beginSwatter, cancelSwatter, canonicalObjects, hasKey, inventoryItems, moveSwatter, type Receipt } from '../tool-system';
import type { TutorialEvent } from '../tutorial';

export type CampaignGrabEvent = Extract<NativeCampaignRuntimeEvent, { type: 'grab' }>;
export interface CampaignPointer { displayId: string; localDip: Point }
export interface CampaignInputOptions {
  session: Pick<CampaignSessionV4, 'snapshot' | 'command'>;
  scope(): InteractionHandleScope | null;
  surface(): SurfaceSnapshotV2 | null;
  equippedTool(): string | null;
  uiRoot(): HTMLElement | null;
  /** Native callers read cursor_position_local on the authoritative overlay. */
  pointer(): CampaignPointer | null | Promise<CampaignPointer | null>;
  /** Bind to NativeCampaignBridge.hitBin, never NativeGrab.overTrashBin. */
  hitBin(screenPhysical: Point): boolean;
  now(): number;
  diagnostic(code: string, message: string): void;
  enabled?(): boolean;
  onChanged?(): void;
  onHouseClick?(houseId: string): void;
  onReceipt?(action: CampaignReceiptAction, receipt: Receipt, repeated: boolean): void;
  onTutorialEvent?(event: TutorialEvent): void;
}
const sameScope = (a: InteractionHandleScope | null, b: InteractionHandleScope | null): boolean =>
  !!a && !!b && a.runId === b.runId && a.displayId === b.displayId && a.generation === b.generation;
const playable = (run: RunState): boolean => !isPaused(run) && !isTerminal(run) && run.phase !== 'preparation';
const CAPTURE_PAUSE_REASONS = new Set(['surface', 'desktop-detection', 'terrain-invalid']);
/** Capture failure pauses simulation, but must not disable viewport-anchored house placement. */
const housePlacementPlayable = (run: RunState): boolean => run.phase === 'running'
  && run.pauseReasons.every(reason => CAPTURE_PAUSE_REASONS.has(reason));
const HOUSE_HALF_WIDTH_DIP = 80;
const HOUSE_HALF_HEIGHT_DIP = 80;
const HOUSE_CLICK_MAX_DISTANCE_DIP = 5;
const inside = (point: Point, region: CampaignHitRegion): boolean =>
  Math.abs(point.x - region.centerDip.x) <= region.halfExtentDip.x && Math.abs(point.y - region.centerDip.y) <= region.halfExtentDip.y;

/** Maps current presentation and native input into the existing live session command boundary.
 * All retained state is transient gesture/DOM identity; no RunState is retained or simulated here. */
export class CampaignInputAdapter {
  private readonly domIds = new WeakMap<HTMLElement, string>();
  private domSequence = 0;
  private controls = new Map<string, HTMLElement>();
  private activeUiRegion: CampaignHitRegion | null = null;
  private active: CampaignGrabEvent | null = null;
  private activeHouse: { id: string; originalXDip: number; pointerOffsetDip: number; moved: boolean;
    startDip: Point; maxDistanceDip: number; draggable: boolean; clickable: boolean; fingerprint: string } | null = null;
  private activeCommandId = '';
  private commandSequence = 0;
  private sessionScope: InteractionHandleScope | null = null;
  private maxSession = 0;
  readonly placementContext: DevicePlacementContextPort = { resolve: command => this.resolvePlacement(command) };

  constructor(private readonly options: CampaignInputOptions) {}
  private enabled(): boolean { return this.options.enabled?.() !== false; }
  get acceptingWorldInput(): boolean { return this.enabled() && !this.modal(); }
  private reject(code: string, message: string): false { this.options.diagnostic(code, message); return false; }
  private currentRun(scope: InteractionHandleScope): RunState | null {
    const run = this.options.session.snapshot().campaign.activeRun;
    return run?.runId === scope.runId ? run : null;
  }
  private healthySurface(scope: InteractionHandleScope): SurfaceSnapshotV2 | null {
    const surface = this.options.surface(), now = this.options.now();
    return surface?.valid && surface.displayId === scope.displayId && surface.width > 0 && surface.height > 0
      && surface.verifiedAtMs <= now + 1000 && now - surface.verifiedAtMs <= 1000 ? surface : null;
  }
  /** House placement only needs the authoritative overlay dimensions. A failed or
   * stale desktop-terrain capture must not make a visible bottom-edge house inert. */
  private geometrySurface(scope: InteractionHandleScope): SurfaceSnapshotV2 | null {
    const surface = this.options.surface();
    return surface?.displayId === scope.displayId && Number.isFinite(surface.width) && Number.isFinite(surface.height)
      && surface.width > 0 && surface.height > 0 ? surface : null;
  }
  private houseDraggable(run: RunState, id: string): boolean {
    const house = run.houses.find(value => value.id === id);
    const resident = run.actors.find(value => value.houseId === id);
    const progress = this.options.session.snapshot().s07Homes;
    const routine = progress?.runId === run.runId ? progress.homes.find(value => value.id === id)?.routine : null;
    return housePlacementPlayable(run) && !!house && house.hp > 0 && !house.locked && !!resident && !resident.atHome
      && !['entering-home', 'exiting-home'].includes(resident.pose.activity) && !routine;
  }
  private houseClickable(run: RunState, id: string): boolean {
    const house = run.houses.find(value => value.id === id);
    const resident = run.actors.find(value => value.houseId === id);
    return !!this.options.onHouseClick && run.phase === 'running' && playable(run)
      && !!house && house.hp > 0 && !!resident;
  }
  private houseFingerprint(run: RunState, id: string): string | null {
    const house = run.houses.find(value => value.id === id);
    const resident = run.actors.find(value => value.houseId === id);
    return house && resident ? JSON.stringify([house.id, house.x, house.y, house.hp, house.maxHp,
      house.repaired, house.locked, resident.id]) : null;
  }
  private nextGestureId(scope: InteractionHandleScope, sessionId: number): string {
    // Native sessions and runtime generations restart on process launch. Recover the
    // command high-water mark from committed receipts so a reload cannot replay an old pickup/hit.
    const run = this.currentRun(scope);
    if (run) for (const key of Object.keys(run.inventory.commands)) {
      const match = /^(?:swat:)?input:(\d+):/.exec(key);
      if (match && Number.isSafeInteger(Number(match[1]))) this.commandSequence = Math.max(this.commandSequence, Number(match[1]));
    }
    if (!Number.isSafeInteger(this.commandSequence + 1)) throw new Error('Input command identities exhausted');
    return `input:${++this.commandSequence}:${scope.generation}:${sessionId}`;
  }
  private domId(node: HTMLElement): string {
    let id = this.domIds.get(node);
    if (!id) { id = `dom:${++this.domSequence}`; this.domIds.set(node, id); }
    return id;
  }
  /** Explicit foreground modals own native input, including their non-actionable
   * background. DOM order selects the top modal; no Rust hit protocol is needed. */
  private modal(): { node: HTMLElement; region: CampaignHitRegion } | null {
    const nodes = this.options.uiRoot()?.querySelectorAll<HTMLElement>('[data-native-input-modal]') ?? [];
    for (const node of Array.from(nodes).reverse()) {
      const region = this.controlRegion(node, this.domId(node));
      if (region) return { node, region: { ...region, priority: 200 } };
    }
    return null;
  }
  private controlRegion(node: HTMLElement, id: string): CampaignHitRegion | null {
    const root = this.options.uiRoot();
    if (!root?.contains(node) || !node.isConnected || node.matches(':disabled, [aria-disabled="true"]')
      || node.closest('[hidden], [inert], [aria-hidden="true"]')) return null;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return null;
    const rect = node.getBoundingClientRect();
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
    // Scrollable management bars must not claim transparent desktop space for
    // buttons outside the visible scroll port. The same clip is checked on release.
    let left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = node.ownerDocument.defaultView?.getComputedStyle(parent);
      if (!parentStyle) continue;
      if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') return null;
      const clipX = /^(auto|scroll|hidden|clip)$/.test(parentStyle.overflowX);
      const clipY = /^(auto|scroll|hidden|clip)$/.test(parentStyle.overflowY);
      if (!clipX && !clipY) continue;
      const bounds = parent.getBoundingClientRect();
      if (clipX) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (clipY) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    }
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
    return { target: { kind: 'ui', id }, centerDip: { x: (left + right) / 2, y: (top + bottom) / 2 },
      halfExtentDip: { x: (right - left) / 2, y: (bottom - top) / 2 }, rotationRad: 0, priority: 100 };
  }
  regions(): CampaignHitRegion[] {
    this.controls.clear();
    if (!this.enabled()) return [];
    const modal = this.modal();
    if (modal && ['object', 'house'].includes(this.active?.target.kind ?? '')) this.cancelGesture();
    const regions: CampaignHitRegion[] = modal ? [modal.region] : [], root = this.options.uiRoot();
    if (root) for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-ui-action]'))) {
      if (modal && !modal.node.contains(node)) continue;
      const id = this.domId(node);
      const region = this.controlRegion(node, id);
      if (region && modal) region.priority = 201;
      if (region) { this.controls.set(id, node); regions.push(region); }
    }
    // Suspend underlying UI and world handles, including the priority-110 bag.
    if (modal) return regions;
    const scope = this.options.scope(), tool = this.options.equippedTool();
    if (!scope) return regions;
    const run = this.currentRun(scope), geometry = this.geometrySurface(scope);
    if (!run || !geometry) return regions;
    for (const house of run.houses) {
      if (house.id === 'home.frog' && !run.frogUnlocked) continue;
      if (!this.houseDraggable(run, house.id) && !this.houseClickable(run, house.id)) continue;
      regions.push({ target: { kind: 'house', id: house.id }, centerDip: {
        x: house.x * geometry.width, y: geometry.height - Math.min(HOUSE_HALF_HEIGHT_DIP, geometry.height / 2),
      }, halfExtentDip: { x: Math.min(HOUSE_HALF_WIDTH_DIP, geometry.width / 2), y: Math.min(HOUSE_HALF_HEIGHT_DIP, geometry.height / 2) },
      rotationRad: 0, priority: 30 });
    }
    if (!playable(run)) return regions;
    const surface = this.healthySurface(scope);
    if (!surface) return regions;
    if (tool === null) {
      for (const item of canonicalObjects(run.inventory)) {
        if (item.owner !== 'world' || !['trash', 'corpse', 'egg'].includes(item.kind) && !(isLive(item) && item.kind !== 'nest')) continue;
        regions.push({ target: { kind: 'object', id: item.id }, centerDip: { x: item.x * surface.width, y: item.y * surface.height },
          halfExtentDip: { x: 20, y: 20 }, rotationRad: 0, priority: 10, toolId: null });
      }
      return regions;
    }
    if (!['bag', 'swatter'].includes(tool ?? '')) return regions;
    for (const item of canonicalObjects(run.inventory)) {
      if (item.owner !== 'world' || (tool === 'bag' ? isLive(item) : !isLive(item))) continue;
      regions.push({ target: { kind: 'object', id: item.id }, centerDip: { x: item.x * surface.width, y: item.y * surface.height },
        halfExtentDip: { x: 20, y: 20 }, rotationRad: 0, priority: 10, toolId: tool! });
    }
    // The visible bag tool control is also the whole-bag drag handle when carrying items.
    if (tool === 'bag' && inventoryItems(run.inventory, 'playerBag').length) {
      const bag = [...this.controls.entries()].find(([, node]) => node.dataset.uiAction === 'tool.equip' && node.dataset.id === 'bag');
      const region = bag && this.controlRegion(bag[1], bag[0]);
      if (region) regions.push({ ...region, target: { kind: 'object', id: 'playerBag' }, priority: 110, toolId: 'bag' });
    }
    return regions;
  }

  /** Runtime calls before changing scope or disabling input. Domain cancellation still uses
   * the current live session transaction; the finally block always releases local ownership. */
  cancelGesture(): void {
    const active = this.active;
    try {
      if (active?.target.kind === 'object' && active.toolId === null) this.cancelDirectObject(active.scope, this.activeCommandId, active.target.id);
      else if (active) this.handleGrab({ ...active, grab: { ...active.grab, phase: 'cancel' } });
    }
    finally { this.active = null; this.activeHouse = null; this.activeUiRegion = null; this.activeCommandId = ''; }
  }
  private restoreHouse(scope: InteractionHandleScope): void {
    const drag = this.activeHouse;
    if (!drag?.moved) return;
    this.options.session.command(({ save, adapter }) => {
      if (save.activeRun?.runId !== scope.runId || adapter?.run !== save.activeRun) throw new Error('Input scope changed');
      const home = adapter.homes.find(value => value.id === drag.id);
      if (!home) throw new Error('Missing campaign home');
      home.x = drag.originalXDip;
    });
    this.options.onChanged?.();
  }
  private handleHouse(event: CampaignGrabEvent, scope: InteractionHandleScope, surface: SurfaceSnapshotV2, run: RunState): boolean {
    const phase = event.grab.phase;
    if (phase === 'start') {
      const house = run.houses.find(value => value.id === event.target.id)!;
      const fingerprint = this.houseFingerprint(run, house.id);
      const draggable = this.houseDraggable(run, house.id), clickable = this.houseClickable(run, house.id);
      if (!fingerprint || !draggable && !clickable) return false;
      this.activeHouse = { id: house.id, originalXDip: house.x * surface.width,
        pointerOffsetDip: event.grab.localDip.x - house.x * surface.width, moved: false,
        startDip: { ...event.grab.localDip }, maxDistanceDip: 0, draggable, clickable, fingerprint };
      return true;
    }
    const drag = this.activeHouse;
    if (!drag || drag.id !== event.target.id) return false;
    if (phase === 'cancel') {
      try { this.restoreHouse(scope); }
      catch (error) { return this.reject('input-command-failed', String(error)); }
      finally { this.activeHouse = null; }
      return true;
    }
    drag.maxDistanceDip = Math.max(drag.maxDistanceDip,
      Math.hypot(event.grab.localDip.x - drag.startDip.x, event.grab.localDip.y - drag.startDip.y));
    if (phase === 'end' && drag.clickable && drag.maxDistanceDip <= HOUSE_CLICK_MAX_DISTANCE_DIP) {
      this.activeHouse = null;
      if (!this.houseClickable(run, drag.id) || this.houseFingerprint(run, drag.id) !== drag.fingerprint)
        return this.reject('input-house-replaced', 'Current house changed during the click gesture.');
      try { this.options.onHouseClick?.(drag.id); return true; }
      catch (error) { return this.reject('input-house-click-failed', String(error)); }
    }
    if (!drag.draggable) {
      if (phase === 'end') this.activeHouse = null;
      return phase === 'move';
    }
    if (drag.clickable && drag.maxDistanceDip <= HOUSE_CLICK_MAX_DISTANCE_DIP) return true;
    if (!this.houseDraggable(run, drag.id)) {
      try { this.restoreHouse(scope); } catch { /* The locked state still owns the refusal. */ }
      this.activeHouse = null;
      return this.reject('input-house-locked', 'Current campaign state locks this home placement.');
    }
    const halfWidth = Math.min(HOUSE_HALF_WIDTH_DIP, surface.width / 2);
    const targetX = Math.max(halfWidth, Math.min(surface.width - halfWidth, event.grab.localDip.x - drag.pointerOffsetDip));
    try {
      const changed = this.options.session.command(({ save, adapter }) => {
        const live = save.activeRun;
        if (!this.enabled() || !sameScope(scope, this.options.scope()) || live?.runId !== scope.runId || adapter?.run !== live) throw new Error('Input scope changed');
        const house = live.houses.find(value => value.id === drag.id);
        const resident = live.actors.find(value => value.houseId === drag.id);
        const home = adapter.homes.find(value => value.id === drag.id);
        if (!housePlacementPlayable(live) || !house || house.hp <= 0 || house.locked || !resident || resident.atHome
          || ['entering-home', 'exiting-home'].includes(resident.pose.activity) || !home || !moveHome(home, targetX)) return false;
        return true;
      });
      if (!changed) {
        this.restoreHouse(scope); this.activeHouse = null;
        return this.reject('input-house-locked', 'Current campaign state locks this home placement.');
      }
      drag.moved ||= Math.abs(targetX - drag.originalXDip) > 1e-9;
      this.options.onChanged?.();
      if (phase === 'end') this.activeHouse = null;
      return true;
    } catch (error) { this.activeHouse = null; return this.reject('input-command-failed', String(error)); }
  }
  private dispatchUiChange(node: HTMLElement, type: 'input' | 'change'): void {
    const event = node.ownerDocument.createEvent('Event');
    event.initEvent(type, true, false); node.dispatchEvent(event);
  }
  private activateUi(node: HTMLElement, region: CampaignHitRegion, event: CampaignGrabEvent): boolean {
    const inputType = node.tagName === 'INPUT' ? node.getAttribute('type')?.toLowerCase() : null;
    if (node.tagName === 'BUTTON' || inputType === 'checkbox' || inputType === 'radio') { node.click(); return true; }
    if (node.tagName === 'SELECT') {
      const select = node as HTMLSelectElement;
      if (select.multiple) return this.reject('input-unsupported-ui', 'Native cycling does not support multi-select controls.');
      const options = Array.from(select.options);
      const next = options.map((_, offset) => (select.selectedIndex + 1 + offset) % options.length)
        .find(index => !options[index].disabled && !options[index].hidden && !options[index].closest('optgroup[disabled], [hidden], [inert]'));
      if (next === undefined || next === select.selectedIndex) return this.reject('input-unavailable-ui', 'No other enabled option is available in the current control.');
      select.selectedIndex = next; this.dispatchUiChange(select, 'change'); return true;
    }
    if (inputType === 'range') {
      const input = node as HTMLInputElement;
      const min = input.min === '' ? 0 : Number(input.min), max = input.max === '' ? 100 : Number(input.max);
      const step = input.step === 'any' ? null : input.step === '' ? 1 : Number(input.step);
      if (![min, max, max - min].every(Number.isFinite) || max < min || step !== null && (!Number.isFinite(step) || step <= 0))
        return this.reject('input-unavailable-ui', 'Current range bounds or step are invalid.');
      const left = region.centerDip.x - region.halfExtentDip.x, width = region.halfExtentDip.x * 2;
      const ratio = Math.max(0, Math.min(1, (event.grab.localDip.x - left) / width));
      const raw = min + (max - min) * ratio;
      const steps = step === null ? 0 : Math.min(Math.floor((max - min) / step + 1e-10), Math.max(0, Math.round((raw - min) / step)));
      if (!Number.isFinite(steps)) return this.reject('input-unavailable-ui', 'Current range step exceeds the supported numeric scale.');
      const value = step === null ? raw : min + steps * step;
      input.value = String(Number(Math.max(min, Math.min(max, value)).toPrecision(15)));
      this.dispatchUiChange(input, 'input');
      if (this.enabled() && sameScope(this.options.scope(), event.scope) && this.controlRegion(input, event.target.id)) this.dispatchUiChange(input, 'change');
      return true;
    }
    return this.reject('input-unsupported-ui', 'No native mapping exists for this current DOM control.');
  }

  private normalizedPointer(surface: SurfaceSnapshotV2, point: Point): Point | null {
    if (![point.x, point.y].every(Number.isFinite) || point.x < 0 || point.x > surface.width || point.y < 0 || point.y > surface.height) return null;
    return { x: point.x / surface.width, y: point.y / surface.height };
  }
  private worldDrop(surface: SurfaceSnapshotV2, point: Point): { kind: 'world'; point: Point; supported: boolean } | null {
    const normalized = this.normalizedPointer(surface, point);
    if (!normalized) return null;
    const supports = [{ id: 'floor', y: surface.floorY }, ...surface.platforms
      .filter(platform => isSurfaceSegmentLive(platform, this.options.now()) && point.x >= platform.x1 && point.x <= platform.x2)
      .map(platform => ({ id: platform.id, y: platform.y }))]
      .filter(support => Number.isFinite(support.y) && support.y >= 0 && support.y <= surface.height)
      .sort((a, b) => Math.abs(a.y - point.y) - Math.abs(b.y - point.y) || a.y - b.y || a.id.localeCompare(b.id));
    const support = supports[0];
    return { kind: 'world', point: support && Math.abs(support.y - point.y) <= 24
      ? { x: normalized.x, y: support.y / surface.height } : normalized,
    // A verified viewport point is a valid drop. Desktop items retain their chosen
    // position under the fixed-object rule; insects resume crawling.
    supported: true };
  }
  private cancelDirectObject(scope: InteractionHandleScope, claimId: string, objectId: string): boolean {
    const cancelled = this.options.session.command(({ save, adapter }) => {
      if (save.activeRun?.runId !== scope.runId || adapter?.run !== save.activeRun) return false;
      return adapter.cancelPlayerObjectDrag(claimId, objectId);
    });
    if (cancelled) this.options.onChanged?.();
    return cancelled;
  }
  private handleDirectObject(event: CampaignGrabEvent, scope: InteractionHandleScope,
    surface: SurfaceSnapshotV2, commandId: string): boolean {
    const objectId = event.target.id;
    try {
      if (event.grab.phase === 'cancel') {
        const cancelled = this.cancelDirectObject(scope, commandId, objectId);
        this.activeCommandId = '';
        return cancelled;
      }
      const point = this.normalizedPointer(surface, event.grab.localDip);
      if (event.grab.phase === 'start') {
        if (!point) return false;
        const receipt = this.options.session.command(({ save, adapter }) => {
          if (!this.enabled() || !sameScope(scope, this.options.scope()) || save.activeRun?.runId !== scope.runId || adapter?.run !== save.activeRun)
            throw new Error('Input scope changed');
          return adapter.beginPlayerObjectDrag(commandId, objectId);
        });
        if (!receipt.ok) { this.active = null; this.activeCommandId = ''; return this.reject('input-domain-rejected', receipt.reason); }
        this.options.onChanged?.(); return true;
      }
      if (!point) {
        if (event.grab.phase === 'end') { this.cancelDirectObject(scope, commandId, objectId); this.activeCommandId = ''; }
        return false;
      }
      if (event.grab.phase === 'move') {
        const moved = this.options.session.command(({ save, adapter }) => {
          if (!this.enabled() || !sameScope(scope, this.options.scope()) || save.activeRun?.runId !== scope.runId || adapter?.run !== save.activeRun)
            throw new Error('Input scope changed');
          return adapter.movePlayerObjectDrag(commandId, objectId, point);
        });
        if (!moved) return this.reject('input-domain-rejected', 'player-drag-missing');
        this.options.onChanged?.(); return true;
      }
      const destination = this.options.hitBin(event.grab.screenPhysical) ? { kind: 'bin' as const } : this.worldDrop(surface, event.grab.localDip);
      if (!destination) { this.cancelDirectObject(scope, commandId, objectId); return false; }
      const repeated = hasKey(this.options.session.snapshot().campaign.activeRun!.inventory.commands, `${commandId}:drop`);
      const receipt = this.options.session.command(({ save, adapter }) => {
        if (!this.enabled() || !sameScope(scope, this.options.scope()) || save.activeRun?.runId !== scope.runId || adapter?.run !== save.activeRun)
          throw new Error('Input scope changed');
        if (!adapter.movePlayerObjectDrag(commandId, objectId, point)) throw new Error('Player drag disappeared before release');
        return adapter.dropPlayerObject(`${commandId}:drop`, commandId, objectId, destination);
      });
      this.activeCommandId = '';
      if (!receipt.ok) {
        this.cancelDirectObject(scope, commandId, objectId);
        return this.reject('input-domain-rejected', receipt.reason);
      }
      if (destination.kind === 'bin') this.options.onReceipt?.('bag-dispose', receipt, repeated);
      this.options.onChanged?.(); return true;
    } catch (error) {
      try { this.cancelDirectObject(scope, commandId, objectId); } catch { /* Preserve the original command failure. */ }
      this.active = null; this.activeCommandId = '';
      return this.reject('input-command-failed', String(error));
    }
  }

  handleGrab(event: CampaignGrabEvent): boolean {
    if (!this.enabled()) {
      if (this.active?.target.kind === 'object' && this.active.toolId === null) this.cancelGesture();
      return false;
    }
    const scope = this.options.scope();
    if (!sameScope(scope, event.scope) || event.target.runId !== scope!.runId || event.grab.displayId !== scope!.displayId)
      return this.reject('input-stale-scope', 'Grab does not belong to the current run/display/generation.');
    if (!sameScope(this.sessionScope, scope)) { this.sessionScope = { ...scope! }; this.maxSession = 0; this.active = null; this.activeHouse = null; this.activeUiRegion = null; }
    const phase = event.grab.phase;
    if (phase === 'start') {
      if (this.active || event.grab.sessionId <= this.maxSession) return false;
      const region = this.regions().find(value => value.target.kind === event.target.kind && value.target.id === event.target.id);
      if (!region || !inside(event.grab.localDip, region)) return this.reject('input-missing-target', 'Current presentation no longer exposes this target.');
      if (event.target.kind !== 'ui' && event.target.kind !== 'house'
        && (event.toolId !== this.options.equippedTool() || event.toolId !== (region.toolId ?? null))) return false;
      if (event.target.kind === 'house' && (event.toolId !== null || region.toolId !== undefined)) return false;
      try { this.activeCommandId = this.nextGestureId(scope!, event.grab.sessionId); }
      catch (error) { return this.reject('input-command-failed', String(error)); }
      this.maxSession = event.grab.sessionId; this.active = structuredClone(event);
      this.activeUiRegion = event.target.kind === 'ui' ? structuredClone(region) : null;
    } else {
      const active = this.active;
      if (!active || active.grab.sessionId !== event.grab.sessionId || active.target.id !== event.target.id
        || active.target.kind !== event.target.kind || active.grab.entityId !== event.grab.entityId || active.toolId !== event.toolId) return false;
      if (phase === 'end' || phase === 'cancel') this.active = null;
    }
    if (event.target.kind === 'ui') {
      if (phase !== 'end') { if (phase === 'cancel') this.activeUiRegion = null; return true; }
      const published = this.activeUiRegion; this.activeUiRegion = null;
      const modal = this.modal();
      if (modal?.region.target.id === event.target.id) return true; // Consume blank/disabled areas without a DOM action.
      const node = this.controls.get(event.target.id), region = node && this.controlRegion(node, event.target.id);
      if (modal && (!node || !modal.node.contains(node))) return this.reject('input-stale-ui', 'UI control is behind the current modal.');
      if (!node || !region || !inside(event.grab.localDip, region)) return this.reject('input-stale-ui', 'UI control was replaced or release is outside it.');
      if (!published || published.centerDip.x !== region.centerDip.x || published.centerDip.y !== region.centerDip.y
        || published.halfExtentDip.x !== region.halfExtentDip.x || published.halfExtentDip.y !== region.halfExtentDip.y)
        return this.reject('input-stale-ui', 'UI geometry changed since the current region was published.');
      try { return this.activateUi(node, published, event); }
      catch (error) { return this.reject('input-ui-failed', String(error)); }
    }
    const run = this.currentRun(scope!);
    const surface = event.target.kind === 'house' ? this.geometrySurface(scope!) : this.healthySurface(scope!);
    if (event.target.kind === 'house') {
      if (phase !== 'cancel' && (this.modal() || !run || !surface)) {
        try { this.restoreHouse(scope!); } catch { /* Refusal is reported below. */ }
        this.activeHouse = null;
        return this.reject('input-house-locked', 'Current campaign state locks this home placement.');
      }
      if (!surface && phase !== 'cancel') return false;
      return this.handleHouse(event, scope!, surface ?? { width: 1, height: 1 } as SurfaceSnapshotV2, run!);
    }
    if (event.target.kind !== 'object' || event.toolId !== null && !['bag', 'swatter'].includes(event.toolId))
      return this.reject('input-unsupported-action', 'No domain action exists for this target/tool mapping.');
    if (phase !== 'cancel' && this.modal()) {
      // An already captured world gesture must not continue through a newly opened modal.
      if (event.toolId === 'swatter') this.options.session.command(({ save }) => {
        if (save.activeRun?.runId === scope!.runId) cancelSwatter(save.activeRun.swatter);
      });
      else if (event.toolId === null) this.cancelDirectObject(scope!, this.activeCommandId, event.target.id);
      this.active = null; this.activeCommandId = '';
      return false;
    }
    if (phase !== 'cancel' && (event.toolId !== this.options.equippedTool() || !run || !playable(run) || !this.healthySurface(scope!))) {
      if (event.toolId === null) this.cancelDirectObject(scope!, this.activeCommandId, event.target.id);
      this.active = null; this.activeCommandId = ''; return false;
    }
    if (!run) return false;
    const commandId = this.activeCommandId;
    try {
      if (event.toolId === null) return this.handleDirectObject(event, scope!, surface!, commandId);
      if (event.toolId === 'swatter') {
        this.options.session.command(({ save }) => {
          const live = save.activeRun;
          if (!this.enabled() || !sameScope(scope, this.options.scope()) || live?.runId !== scope!.runId) throw new Error('Input scope changed');
          if (phase === 'start') { if (!beginSwatter(live.swatter, commandId, event.grab.localDip, true)) throw new Error('Swatter rejected start'); }
          else if (phase === 'move') moveSwatter(live.swatter, event.grab.localDip, true);
          else cancelSwatter(live.swatter);
        });
      } else {
        if (phase === 'cancel' || phase === 'move' || (phase === 'start' && event.target.id === 'playerBag')) return true;
        if (phase === 'end' && !this.options.hitBin(event.grab.screenPhysical)) return true;
        const action = phase === 'start' ? 'pickup' : 'bag-dispose';
        const id = `${commandId}:${action}`, wasCorpse = run.inventory.objects[event.target.id]?.kind === 'corpse';
        const repeated = hasKey(run.inventory.commands, id);
        const receipt = this.options.session.command(({ save }) => {
          const live = save.activeRun;
          if (!this.enabled() || !sameScope(scope, this.options.scope()) || live?.runId !== scope!.runId) throw new Error('Input scope changed');
          return action === 'pickup' ? collectItem(live, id, event.target.id) : disposeBag(live, id, true);
        });
        this.options.onReceipt?.(action, receipt, repeated);
        if (!receipt.ok) return this.reject('input-domain-rejected', receipt.reason);
        if (!repeated) {
          this.options.onTutorialEvent?.(action === 'pickup' ? { type: 'bag-item-collected', itemId: event.target.id } : { type: 'bag-recycled' });
          if (action === 'pickup' && wasCorpse) this.options.onTutorialEvent?.({ type: 'corpse-collected' });
        }
      }
      this.options.onChanged?.(); return true;
    } catch (error) { return this.reject('input-command-failed', String(error)); }
  }

  private async resolvePlacement(command: Parameters<DevicePlacementContextPort['resolve']>[0]) {
    const currentScope = this.options.scope();
    if (!this.acceptingWorldInput || !currentScope) return null;
    const scope = { ...currentScope };
    if (command.runId !== scope.runId || !this.currentRun(scope)) return null;
    const pointer = await this.options.pointer();
    if (!this.acceptingWorldInput || !sameScope(scope, this.options.scope()) || !this.currentRun(scope)) return null;
    const surface = this.healthySurface(scope);
    if (!surface || !pointer || pointer.displayId !== scope.displayId) return null;
    const p = pointer.localDip;
    if (![p.x, p.y].every(Number.isFinite) || p.x < 0 || p.x > surface.width || p.y < 0 || p.y > surface.height) return null;
    // Existing placeTrap supports the permanent floor only (domain y=1). Other live
    // platforms must wait for a domain placement action; do not fake validGround there.
    if (!Number.isFinite(surface.floorY) || surface.floorY < 0 || surface.floorY > surface.height || Math.abs(surface.floorY - p.y) > 24) {
      this.reject('input-placement-ground', 'Current host pointer is not within 24 DIP of the verified permanent floor.'); return null;
    }
    return { placementId: `placement:${command.commandId}`, position: { x: p.x / surface.width, y: 1 }, validGround: true };
  }
}
