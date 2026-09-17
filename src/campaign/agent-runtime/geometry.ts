import type { ActorState } from '../actor-state';
import type { AgentTarget } from '../agent-coordinator';
import type { RunAttributes } from '../economy';
import type { MovementProfile } from '../movement';
import { buildNavigationGraph, findRoute, type NavigationTarget } from '../navigation';
import { livePlatforms, supportsFeet } from '../physics';
import { createRoleAttributes } from '../role-abilities';
import type { SurfaceSnapshotV2 } from '../surface';

/** Explicit opaque / non-capturable regions in display-local DIP, supplied by the host.
 * Pixel platform lines are one-way supports, not opaque walls. Undefined means unknown. */
export interface TongueOccluder { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

export function tongueVisible(from: Point, to: Point, blockers: readonly TongueOccluder[] | undefined): boolean {
  if (!blockers) return false;
  return !blockers.some(rect => {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0) return true;
    let low = 0, high = 1;
    for (const [origin, delta, min, max] of [
      [from.x, to.x - from.x, rect.x, rect.x + rect.width],
      [from.y, to.y - from.y, rect.y, rect.y + rect.height],
    ]) {
      if (Math.abs(delta) < 1e-9) { if (origin < min || origin > max) return false; }
      else {
        const a = (min - origin) / delta, b = (max - origin) / delta;
        low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b));
        if (low > high) return false;
      }
    }
    return true;
  });
}

export function standing(actor: Readonly<ActorState>, surface: SurfaceSnapshotV2, profile: MovementProfile, nowMs: number): boolean {
  const body = actor.body;
  return !body.grip && !!body.support && body.vx === 0 && body.vy === 0
    && livePlatforms(surface, nowMs).some(p => p.id === body.support!.id && p.version === body.support!.version
      && Math.abs(body.y - p.y) < 1e-7 && supportsFeet(body.x, profile.radius, p));
}

function inAbilityRange(role: ActorState['archetype'], feet: Point, target: Point, profile: MovementProfile,
  attributes: RunAttributes, blockers: readonly TongueOccluder[] | undefined): boolean {
  const roleAttributes = createRoleAttributes(role);
  if (role === 'cleaner') return Math.abs(feet.x - target.x) <= roleAttributes.cleanReach + 1e-7
    && Math.abs(feet.y - target.y) <= roleAttributes.cleanVerticalTolerance + 1e-7;
  const mouth = { x: feet.x, y: feet.y - profile.height * roleAttributes.tongueMouthHeightRatio };
  return Math.hypot(mouth.x - target.x, mouth.y - target.y) <= attributes.tongueReach + 1e-7
    && tongueVisible(mouth, target, blockers);
}

export function canWork(actor: Readonly<ActorState>, target: AgentTarget, surface: SurfaceSnapshotV2,
  profile: MovementProfile, attributes: RunAttributes, nowMs: number, blockers: readonly TongueOccluder[] | undefined): boolean {
  return standing(actor, surface, profile, nowMs)
    && inAbilityRange(actor.archetype, actor.body, target, profile, attributes, blockers);
}

/** Goals are valid feet positions inside the ability range, rather than the floating item.
 * Every accepted goal has a complete physically verified graph route. A search-budget miss
 * is retriable and never labelled proof that arbitrary desktop geometry is impossible. */
export function approach(actor: Readonly<ActorState>, target: AgentTarget, surface: SurfaceSnapshotV2,
  profile: MovementProfile, attributes: RunAttributes, nowMs: number, blockers: readonly TongueOccluder[] | undefined,
  diagnostic: (code: string) => void): NavigationTarget | undefined {
  const role = createRoleAttributes(actor.archetype);
  const candidates: NavigationTarget[] = [];
  for (const p of livePlatforms(surface, nowMs)) {
    const vertical = actor.archetype === 'frog' ? p.y - profile.height * role.tongueMouthHeightRatio - target.y : p.y - target.y;
    if (Math.abs(vertical) > (actor.archetype === 'frog' ? attributes.tongueReach : role.cleanVerticalTolerance)) continue;
    const reach = actor.archetype === 'frog' ? Math.sqrt(Math.max(0, attributes.tongueReach ** 2 - vertical ** 2)) : role.cleanReach;
    const overlap = Math.min(12, profile.radius * 2);
    const left = Math.max(profile.radius, p.x1 + overlap - profile.radius, target.x - reach);
    const right = Math.min(surface.width - profile.radius, p.x2 - overlap + profile.radius, target.x + reach);
    if (left > right || p.y < profile.height) continue;
    for (const x of new Set([Math.max(left, Math.min(right, actor.body.x)), Math.max(left, Math.min(right, target.x)), left, right])) {
      const goal: NavigationTarget = { x, y: p.y, kind: 'platform', supportId: p.id };
      if (inAbilityRange(actor.archetype, goal, target, profile, attributes, blockers)) candidates.push(goal);
    }
  }
  candidates.sort((a, b) => Math.hypot(actor.body.x - a.x, actor.body.y - a.y) - Math.hypot(actor.body.x - b.x, actor.body.y - b.y)
    || a.y - b.y || a.x - b.x || (a.supportId! < b.supportId! ? -1 : a.supportId === b.supportId ? 0 : 1));
  // Bound whole-target work as well as each graph's internal physics rollout.
  for (const goal of candidates.slice(0, 16)) {
    const graph = buildNavigationGraph(surface, profile, nowMs, actor.body, goal);
    if (findRoute(graph)) return goal;
    if (graph.budgetExhausted) diagnostic('navigation-budget-exhausted');
  }
  if (candidates.length > 16) diagnostic('approach-budget-exhausted');
  return undefined;
}
