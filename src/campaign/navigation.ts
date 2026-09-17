import { createActorBody, movementScale, type ActorBody, type MovementInput, type MovementProfile } from "./movement";
import { FIXED_DT, FLOOR_ID, GRAVITY, MAX_FALL_SPEED, livePlatforms, stepActor, supportsFeet, verticalDisplacement } from "./physics";
import { isSurfaceSegmentLive, type SurfaceSnapshotV2 } from "./surface";

export interface NavigationTarget { x: number; y: number; kind?: "platform" | "grip"; supportId?: string }
export type NavigationEdgeKind = "walk" | "climb" | "jump" | "drop";
export interface NavigationNode extends NavigationTarget {
  id: number;
  kind: "platform" | "grip";
  supportId: string;
  version: number;
}
export interface NavigationEdge {
  from: number;
  to: number;
  kind: NavigationEdgeKind;
  cost: number;
  /** Constant normalized horizontal input verified by the physical rollout. */
  moveX: number;
  duration: number;
  /** Request the destination grip at this verified flight tick, then stop steering. */
  gripAtTick?: number;
}
export interface NavigationBudget { maxNodes: number; maxCandidates: number; maxSimulations: number; maxRolloutSteps: number }
export const NAVIGATION_BUDGET: Readonly<NavigationBudget> = Object.freeze({
  maxNodes: 160, maxCandidates: 8000, maxSimulations: 240, maxRolloutSteps: 150,
});
export interface NavigationGraph {
  nodes: NavigationNode[];
  edges: NavigationEdge[];
  startId?: number;
  goalId?: number;
  displayId: string;
  floorY: number;
  width: number;
  loadFraction: number;
  budgetExhausted: boolean;
  simulations: number;
  candidates: number;
  reason?: string;
}
export interface NavigationRoute {
  /** Ends at the closest verified support point; does not claim target arrival. */
  partial?: boolean;
  nodes: NavigationNode[];
  edges: NavigationEdge[];
  displayId: string;
  floorY: number;
  width: number;
  loadFraction: number;
  dependencies: { id: string; version: number; kind: NavigationNode["kind"] }[];
}
function distance(a: NavigationTarget, b: NavigationTarget): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function sameSurface(a: NavigationNode, b: NavigationNode): boolean { return a.kind === b.kind && a.supportId === b.supportId; }

/**
 * Bounded support-frontier search. Walk/climb intervals stay implicit until a
 * physically verified bridge reaches them. Rollout attempts share a global queue;
 * exhaustion reports an incomplete search, never physical impossibility.
 */
export function buildNavigationGraph(
  surface: SurfaceSnapshotV2, profile: MovementProfile, nowMs: number,
  start: ActorBody, target: NavigationTarget, loadFraction = start.loadFraction,
  budget: NavigationBudget = NAVIGATION_BUDGET,
): NavigationGraph {
  const graph: NavigationGraph = {
    nodes: [], edges: [], displayId: surface.displayId, floorY: surface.floorY, width: surface.width, loadFraction,
    budgetExhausted: false, simulations: 0, candidates: 0,
  };
  const platforms = livePlatforms(surface, nowMs);
  const grips = surface.valid && profile.canClimb ? surface.grips.filter(g => isSurfaceSegmentLive(g, nowMs)) : [];
  const goalPlatform = platforms.filter(p => (!target.supportId || p.id === target.supportId) && Math.abs(p.y - target.y) <= 12 && supportsFeet(target.x, profile.radius, p))
    .sort((a, b) => Math.abs(a.y - target.y) - Math.abs(b.y - target.y))[0];
  const goalGrip = target.kind === "grip" ? grips.find(g => (!target.supportId || g.id === target.supportId) && Math.abs(g.x - target.x) <= 6
    && target.y >= g.y1 && target.y <= Math.min(surface.floorY, g.y2 + profile.height)) : undefined;
  const goalSurface = target.kind === "grip" ? goalGrip : goalPlatform;
  if (!goalSurface) graph.reason = "目标附近没有有效落脚点或抓握线";
  const startKind = start.grip ? "grip" : "platform";
  const startSupport = start.grip ?? start.support;
  if (!startSupport) { graph.reason = "等待角色落地后规划"; return graph; }
  const heldGrip = start.grip && grips.find(g => g.id === start.grip!.id && g.version === start.grip!.version
    && Math.abs(start.x - g.x) <= 6 && start.y >= g.y1 && start.y - profile.height <= g.y2);
  if (start.grip && !heldGrip) { graph.reason = "当前抓握已失效，等待重新接触"; return graph; }
  if (!start.grip && !platforms.some(p => p.id === startSupport.id && p.version === startSupport.version
    && supportsFeet(start.x, profile.radius, p) && Math.abs(start.y - p.y) < 1e-7)) {
    graph.reason = "当前落脚点已失效，等待角色落地"; return graph;
  }
  const addNode = (kind: NavigationNode["kind"], supportId: string, version: number, x: number, y: number): NavigationNode | undefined => {
    // Grip capture permits a six-DIP lateral offset and never snaps the actor.
    // Climbing preserves that real x, including the later jump's takeoff point.
    const existing = graph.nodes.find(n => n.kind === kind && n.supportId === supportId
      && Math.abs(n.x - x) < (kind === "grip" ? 1e-5 : 0.25) && Math.abs(n.y - y) < 0.25);
    if (existing) return existing;
    if (graph.nodes.length >= budget.maxNodes) { graph.budgetExhausted = true; return; }
    const node: NavigationNode = { id: graph.nodes.length, kind, supportId, version, x, y };
    graph.nodes.push(node);
    return node;
  };
  graph.startId = addNode(startKind, startSupport.id, startSupport.version, start.x, start.y)?.id;
  graph.goalId = goalGrip ? addNode("grip", goalGrip.id, goalGrip.version, heldGrip?.id === goalGrip.id ? start.x : goalGrip.x, target.y)?.id
    : goalSurface && goalPlatform ? addNode("platform", goalPlatform.id, goalPlatform.version, target.x, goalPlatform.y)?.id : undefined;
  const scale = movementScale(profile, loadFraction);
  const speed = profile.speed * scale;
  const airSpeed = (profile.airSpeed ?? profile.speed) * scale;
  const jumpVelocity = profile.jumpVelocity * scale;
  const maxHeight = jumpVelocity * jumpVelocity / (2 * GRAVITY);
  const cost = new Map<number, number>();
  const parent = new Map<number, NavigationEdge>();
  if (graph.startId === undefined) { graph.reason = "路线节点预算耗尽"; return graph; }
  cost.set(graph.startId, 0);

  const simulateFlight = (from: NavigationNode, to: NavigationNode, kind: "jump" | "drop", attemptIndex: number, attemptCount: { value: number }): NavigationEdge | undefined => {
    const destinationGrip = to.kind === "grip" ? grips.find(g => g.id === to.supportId) : undefined;
    const initialVy = kind === "jump" ? jumpVelocity : 0;
    const attempts: { predictedTime: number; x: number; gripAtTick?: number }[] = [];
    if (destinationGrip) {
      // A short line can contact any part of the capsule, on ascent or descent.
      // Enumerate actual contact ticks across that entire feet-height interval.
      for (let tick = 1; tick < budget.maxRolloutSteps; tick++) {
        const time = tick * FIXED_DT;
        const y = from.y + verticalDisplacement(initialVy, time);
        if (y < destinationGrip.y1 - 1e-7 || y > Math.min(surface.floorY, destinationGrip.y2 + profile.height) + 1e-7) continue;
        const x = Math.max(profile.radius, Math.min(surface.width - profile.radius,
          Math.max(from.x - airSpeed * time, Math.min(from.x + airSpeed * time, to.x))));
        if (Math.abs(x - destinationGrip.x) <= 6 + 1e-7) attempts.push({ predictedTime: time, x, gripAtTick: tick });
      }
    } else {
      const dy = to.y - from.y;
      if (kind === "jump" && dy < -maxHeight - 0.01 || kind === "drop" && dy <= 0.01) return;
      const discriminant = initialVy * initialVy + 2 * GRAVITY * dy;
      if (discriminant < 0) return;
      let time = (-initialVy + Math.sqrt(discriminant)) / GRAVITY;
      const terminalAt = (MAX_FALL_SPEED - initialVy) / GRAVITY;
      if (time > terminalAt) time = terminalAt + (dy - verticalDisplacement(initialVy, terminalAt)) / MAX_FALL_SPEED;
      if (time <= 0 || time > budget.maxRolloutSteps * FIXED_DT || Math.abs(to.x - from.x) > airSpeed * time + 0.01) return;
      attempts.push({ predictedTime: time, x: to.x });
    }
    attemptCount.value = attempts.length;
    for (const { predictedTime, x: captureX, gripAtTick } of attempts.slice(attemptIndex, attemptIndex + 1)) {
      if (graph.simulations >= budget.maxSimulations) { graph.budgetExhausted = true; return; }
      graph.simulations++;
      const body = createActorBody("navigation-probe", from.x, from.y);
      body.loadFraction = loadFraction;
      const ref = { id: from.supportId, version: from.version, revision: surface.revision };
      if (from.kind === "grip") body.grip = ref; else body.support = ref;
      const moveX = (captureX - from.x) / (predictedTime * airSpeed);
      // Sweeps can only meet geometry inside this flight's horizontal and vertical bounds.
      // Keep every possible interceptor there, including platforms omitted from graph nodes.
      const simulationSurface: SurfaceSnapshotV2 = { ...surface,
        platforms: surface.platforms.filter(p => p.x2 >= Math.min(from.x, captureX) - profile.radius - airSpeed * FIXED_DT
          && p.x1 <= Math.max(from.x, captureX) + profile.radius + airSpeed * FIXED_DT
          && p.y >= from.y - (kind === "jump" ? maxHeight : 0) - 1
          && p.y <= Math.max(from.y, from.y + verticalDisplacement(initialVy, predictedTime + FIXED_DT)) + 1),
        grips: surface.grips.filter(g => g.id === destinationGrip?.id || from.kind === "grip" && g.id === from.supportId),
      };
      for (let tick = 0; tick < budget.maxRolloutSteps; tick++) {
        const canAttach = gripAtTick !== undefined && tick >= gripAtTick;
        stepActor(body, { moveX: canAttach ? 0 : moveX, gripId: canAttach ? to.supportId : undefined,
          jump: tick === 0 && kind === "jump", drop: tick === 0 && kind === "drop", releaseGrip: tick === 0 && kind === "drop" },
          simulationSurface, profile, nowMs + tick * FIXED_DT * 1000, FIXED_DT);
        if (destinationGrip && body.grip?.id === to.supportId) {
          const launch = addNode(from.kind, from.supportId, from.version, from.x, from.y);
          const landing = addNode("grip", to.supportId, to.version, body.x, body.y);
          if (!landing || !launch) return;
          const duration = (tick + 1) * FIXED_DT;
          return { from: launch.id, to: landing.id, kind, moveX, gripAtTick, duration, cost: duration + 0.15 };
        }
        if (body.support) {
          if (!destinationGrip && body.support.id === to.supportId && Math.abs(body.x - to.x) <= Math.max(3, airSpeed * FIXED_DT * 1.5)) {
            const launch = addNode(from.kind, from.supportId, from.version, from.x, from.y);
            const landing = addNode(to.kind, to.supportId, to.version, to.x, to.y);
            if (!launch || !landing) return;
            const duration = (tick + 1) * FIXED_DT;
            return { from: launch.id, to: landing.id, kind, moveX, duration, cost: duration + (kind === "jump" ? 0.15 : 0.1) };
          }
          break;
        }
        if (body.y > (destinationGrip ? destinationGrip.y2 + profile.height : to.y) + 2 && body.vy >= 0) break;
      }
    }
    return;
  };
  const startNode = graph.nodes[graph.startId];
  const goalNode = graph.goalId === undefined ? undefined : graph.nodes[graph.goalId];
  const localEdge = (from: NavigationNode, to: NavigationNode): NavigationEdge => {
    const kind = from.kind === "platform" ? "walk" : "climb";
    const duration = Math.abs(kind === "walk" ? to.x - from.x : to.y - from.y)
      / (kind === "walk" ? speed : profile.climbSpeed * scale);
    return { from: from.id, to: to.id, kind, duration, cost: duration, moveX: Math.sign(to.x - from.x) };
  };
  const accept = (edge: NavigationEdge) => {
    graph.edges.push(edge);
    const next = cost.get(edge.from)! + edge.cost;
    if (next < (cost.get(edge.to) ?? Infinity)) { cost.set(edge.to, next); parent.set(edge.to, edge); }
  };
  const finish = (node: NavigationNode): boolean => {
    if (!goalNode || !sameSurface(node, goalNode)) return false;
    const goal = node.kind === "grip"
      ? addNode("grip", node.supportId, node.version, node.x, goalNode.y) : goalNode;
    if (!goal) return false;
    if (node.id !== goal.id) accept(localEdge(node, goal));
    graph.goalId = goal.id;
    solvedRoutes.set(graph, parent);
    return true;
  };
  if (finish(startNode)) return graph;

  // A support is a continuous, constructively traversable interval. Do not spend
  // the node budget on unreachable text anchors: admit a launch/contact only after
  // its flight succeeds. In particular, all floor takeoffs remain available even
  // when the useful ladder is far outside the start-to-goal corridor.
  interface Support {
    kind: NavigationNode["kind"]; id: string; version: number;
    left: number; right: number; top: number; bottom: number;
  }
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const overlap = Math.min(12, profile.radius * 2);
  const supports: Support[] = [
    ...platforms.filter(p => p.x2 - p.x1 >= overlap).map(p => ({ kind: "platform" as const, id: p.id, version: p.version,
      left: Math.max(profile.radius, p.x1 + overlap - profile.radius),
      right: Math.min(surface.width - profile.radius, p.x2 - overlap + profile.radius), top: p.y, bottom: p.y })),
    ...grips.map(g => ({ kind: "grip" as const, id: g.id, version: g.version,
      left: g.x, right: g.x, top: g.y1, bottom: Math.min(surface.floorY, g.y2 + profile.height) })),
  ].filter(s => s.left <= s.right && s.top <= s.bottom);
  const supportByKey = new Map(supports.map(s => [s.kind + ":" + s.id, s]));
  const goalInterval = goalNode ? supportByKey.get(goalNode.kind + ":" + goalNode.supportId)!
    : { left: target.x, right: target.x, top: target.y, bottom: target.y };
  const potential = (s: Support) => Math.hypot(
    Math.max(0, goalInterval.left - s.right, s.left - goalInterval.right),
    Math.max(0, goalInterval.top - s.bottom, s.top - goalInterval.bottom));
  const virtual = (s: Support, x: number, y: number): NavigationNode => ({
    id: -1, kind: s.kind, supportId: s.id, version: s.version, x, y,
  });
  interface Variant { from: NavigationNode; to: NavigationNode; kind: "jump" | "drop" | "contact" }
  interface Bridge {
    source: NavigationNode; destination: Support; priority: number;
    variants?: Variant[]; variant: number; attempt: number;
  }
  const pending: Bridge[] = [];
  const reached = new Set<string>();
  const stateKey = (n: NavigationNode) => n.kind + ":" + n.supportId + (n.kind === "grip" ? ":" + n.x.toFixed(5) : "");
  const expand = (node: NavigationNode) => {
    const key = stateKey(node);
    if (reached.has(key)) return;
    reached.add(key);
    const source = supportByKey.get(node.kind + ":" + node.supportId);
    if (!source) return;
    for (const destination of supports) {
      if (destination.kind === node.kind && destination.id === node.supportId) continue;
      if (destination.kind === "platform" && reached.has("platform:" + destination.id)) continue;
      const left = node.kind === "grip" ? node.x : source.left;
      const right = node.kind === "grip" ? node.x : source.right;
      const gap = Math.max(0, left - destination.right, destination.left - right);
      // Broad ballistic envelope is only a filter. Every accepted transition is
      // still checked by stepActor, with every possible platform interceptor.
      if (destination.bottom < source.top - maxHeight - 0.01
        || gap > airSpeed * budget.maxRolloutSteps * FIXED_DT + (destination.kind === "grip" ? 6 : 0)) continue;
      const contact = node.kind !== destination.kind && gap <= (destination.kind === "grip" ? 6 : 0)
        && Math.max(source.top, destination.top) <= Math.min(source.bottom, destination.bottom);
      const approach = node.kind === "platform"
        ? Math.max(0, destination.left - node.x, node.x - destination.right) / speed
        : Math.max(0, destination.top - node.y, node.y - destination.bottom) / (profile.climbSpeed * scale);
      pending.push({ source: node, destination, priority: cost.get(node.id)! + approach
        + 2 * potential(destination) / Math.max(speed, profile.climbSpeed * scale) + (contact ? 0 : 0.15),
        variant: 0, attempt: 0 });
    }
    // The pending frontier is bounded too. It is ranked afresh from each reached
    // support, so a distant bridge can enter after a useful climb or detour.
    if (pending.length > budget.maxCandidates) {
      pending.sort((a, b) => a.priority - b.priority);
      pending.length = budget.maxCandidates;
      graph.budgetExhausted = true;
    }
  };
  const variantsFor = (bridge: Bridge): Variant[] => {
    const { source: node, destination: to } = bridge;
    const from = supportByKey.get(node.kind + ":" + node.supportId)!;
    const result: Variant[] = [];
    const add = (a: NavigationNode, b: NavigationNode, kind: Variant["kind"]) => {
      if (result.some(v => v.kind === kind && distance(v.from, a) < 0.01 && distance(v.to, b) < 0.01)) return;
      if (kind === "jump" && b.y < a.y - maxHeight - 0.01 && to.kind === "platform") return;
      if (kind === "jump" && to.bottom < a.y - maxHeight - 0.01) return;
      if (kind === "drop" && to.bottom <= a.y) return;
      result.push({ from: a, to: b, kind });
    };
    if (node.kind === "platform" && to.kind === "grip" && node.y >= to.top && node.y <= to.bottom) {
      const x = clamp(to.left, from.left, from.right);
      if (Math.abs(x - to.left) <= 6) add(virtual(from, x, node.y), virtual(to, x, node.y), "contact");
    } else if (node.kind === "grip" && to.kind === "platform" && node.x >= to.left && node.x <= to.right
      && to.top >= from.top && to.top <= from.bottom) {
      add(virtual(from, node.x, to.top), virtual(to, node.x, to.top), "contact");
    }
    const destinationXs = to.kind === "grip" ? [to.left]
      : [clamp(node.x, to.left, to.right), clamp(target.x, to.left, to.right), to.left, to.right, (to.left + to.right) / 2];
    for (const x of destinationXs) {
      const launches = from.kind === "platform"
        ? [clamp(x, from.left, from.right), node.x, from.left, from.right].map(x => virtual(from, x, node.y))
        : [from.top, clamp(to.bottom, from.top, from.bottom), clamp(to.top, from.top, from.bottom), node.y, from.bottom]
          .map(y => virtual(from, node.x, y));
      for (const launch of launches) {
        const landing = virtual(to, x, to.kind === "grip" ? clamp(launch.y, to.top, to.bottom) : to.top);
        add(launch, landing, "jump");
        if (from.id !== FLOOR_ID) add(launch, landing, "drop");
      }
    }
    return result.sort((a, b) => {
      const rank = (v: Variant) => v.kind === "contact" ? -1e9
        : distance(v.from, v.to) + localEdge(node, v.from).duration * 0.01 + (v.kind === "drop" ? 0.1 : 0);
      return rank(a) - rank(b);
    });
  };
  expand(startNode);
  while (pending.length) {
    // Give each newly reached support one direct goal attempt before returning
    // to the shared frontier. A long, useful climb must not wait behind hundreds
    // of cheaper incidental contacts. Failed attempts immediately lose this bonus.
    const rank = (b: Bridge) => goalNode && b.destination.kind === goalNode.kind && b.destination.id === goalNode.supportId
      && b.variant === 0 && b.attempt === 0 ? -Infinity : b.priority;
    let best = 0;
    for (let i = 1; i < pending.length; i++) if (rank(pending[i]) < rank(pending[best])) best = i;
    const bridge = pending.splice(best, 1)[0];
    if (bridge.destination.kind === "platform" && reached.has("platform:" + bridge.destination.id)) continue;
    bridge.variants ??= variantsFor(bridge);
    const variant = bridge.variants[bridge.variant];
    if (!variant) continue;
    if (bridge.attempt === 0 && ++graph.candidates > budget.maxCandidates) { graph.budgetExhausted = true; break; }
    let edge: NavigationEdge | undefined;
    const attemptCount = { value: 0 };
    if (variant.kind === "contact") {
      // Verify attachment/release: coincident lines do not guarantee that the
      // physics solver selects the requested platform id.
      const probe = createActorBody("navigation-contact", variant.from.x, variant.from.y);
      const ref = { id: variant.from.supportId, version: variant.from.version, revision: surface.revision };
      if (variant.from.kind === "grip") probe.grip = ref; else probe.support = ref;
      stepActor(probe, { gripId: variant.to.kind === "grip" ? variant.to.supportId : undefined,
        releaseGrip: variant.to.kind === "platform" }, surface, profile, nowMs, FIXED_DT);
      if ((variant.to.kind === "grip" ? probe.grip?.id : probe.support?.id) === variant.to.supportId) {
        const launch = addNode(variant.from.kind, variant.from.supportId, variant.from.version, variant.from.x, variant.from.y);
        const landing = addNode(variant.to.kind, variant.to.supportId, variant.to.version, probe.x, probe.y);
        if (launch && landing) edge = { from: launch.id, to: landing.id, kind: landing.kind === "grip" ? "climb" : "walk",
          cost: FIXED_DT, duration: FIXED_DT, moveX: 0 };
      }
    } else {
      if (graph.simulations >= budget.maxSimulations) { graph.budgetExhausted = true; break; }
      edge = simulateFlight(variant.from, variant.to, variant.kind, bridge.attempt, attemptCount);
    }
    if (edge) {
      const launch = graph.nodes[edge.from];
      if (launch.id !== bridge.source.id) accept(localEdge(bridge.source, launch));
      accept(edge);
      const landing = graph.nodes[edge.to];
      if (finish(landing)) return graph;
      expand(landing);
      continue;
    }
    if (graph.nodes.length >= budget.maxNodes) { graph.budgetExhausted = true; break; }
    // Interleave unsuccessful contact ticks and alternative launches with other
    // bridges. A single obstructed short line cannot spend all 240 rollouts.
    bridge.attempt++;
    if (bridge.attempt >= attemptCount.value) { bridge.variant++; bridge.attempt = 0; }
    bridge.priority += 0.2;
    if (bridge.variant < bridge.variants.length) pending.push(bridge);
  }
  graph.reason = graph.budgetExhausted ? "本次搜索预算已用完，尚未确认目标是否可达" : graph.reason ?? "需要落脚点或跳跃距离不足";
  // Project the requested point onto every *reached* continuous interval. The
  // prefix contains only accepted physics rollouts; the last walk/climb stays
  // on that same support, including the real lateral offset of a held grip.
  // Keep the endpoint outside the graph so even an exhausted node budget can
  // describe its verified last interval without exceeding the search budget.
  let bestSource = startNode;
  let bestPoint = startNode;
  let bestDistance = distance(startNode, target);
  let bestCost = 0;
  for (const [id, prefixCost] of cost) {
    const source = graph.nodes[id];
    const interval = supportByKey.get(source.kind + ":" + source.supportId);
    if (!interval) continue;
    const point: NavigationNode = { ...source, id: -1,
      x: source.kind === "grip" ? source.x : clamp(target.x, interval.left, interval.right),
      y: source.kind === "grip" ? clamp(target.y, interval.top, interval.bottom) : source.y };
    const candidateDistance = distance(point, target);
    const candidateCost = prefixCost + localEdge(source, point).cost;
    if (candidateDistance < bestDistance - 1e-7
      || Math.abs(candidateDistance - bestDistance) <= 1e-7 && candidateCost < bestCost) {
      bestSource = source; bestPoint = point; bestDistance = candidateDistance; bestCost = candidateCost;
    }
  }
  // Sub-DIP improvements do not justify a detour or repeated corrective motion.
  if (distance(startNode, target) - bestDistance < 1) { bestSource = startNode; bestPoint = startNode; }
  const approach = reconstructRoute(graph, parent, bestSource.id);
  if (approach) {
    if (distance(bestSource, bestPoint) > 0.01) {
      approach.nodes.push(bestPoint); approach.edges.push(localEdge(bestSource, bestPoint));
    }
    approach.partial = true;
    approachRoutes.set(graph, approach);
  }
  return graph;
}
const solvedRoutes = new WeakMap<NavigationGraph, Map<number, NavigationEdge>>();
const approachRoutes = new WeakMap<NavigationGraph, NavigationRoute>();

export function findRoute(graph: NavigationGraph): NavigationRoute | undefined {
  const parents = solvedRoutes.get(graph);
  if (!parents || graph.goalId === undefined) return;
  return reconstructRoute(graph, parents, graph.goalId);
}

/** Full route if found, otherwise the best approach proven within this budget. */
export function findApproachRoute(graph: NavigationGraph): NavigationRoute | undefined {
  return findRoute(graph) ?? approachRoutes.get(graph);
}

function reconstructRoute(graph: NavigationGraph, parents: Map<number, NavigationEdge>, endpointId: number): NavigationRoute | undefined {
  if (graph.startId === undefined) return;
  const edges: NavigationEdge[] = [];
  let cursor = endpointId;
  while (cursor !== graph.startId) {
    const edge = parents.get(cursor);
    if (!edge) return;
    edges.push(edge); cursor = edge.from;
  }
  edges.reverse();
  const nodes = [graph.nodes[graph.startId], ...edges.map(e => graph.nodes[e.to])];
  const dependencies = nodes.filter((n, i) => nodes.findIndex(other => other.supportId === n.supportId && other.kind === n.kind) === i)
    .map(n => ({ id: n.supportId, version: n.version, kind: n.kind }));
  return { nodes, edges, dependencies, displayId: graph.displayId, floorY: graph.floorY, width: graph.width, loadFraction: graph.loadFraction };
}

export function routeIsValid(route: NavigationRoute, surface: SurfaceSnapshotV2, nowMs: number, loadFraction = route.loadFraction): boolean {
  if (surface.displayId !== route.displayId || surface.floorY !== route.floorY || surface.width !== route.width || Math.abs(loadFraction - route.loadFraction) > 0.001) return false;
  return route.dependencies.every(dep => dep.id === FLOOR_ID || surface.valid && (dep.kind === "platform" ? surface.platforms : surface.grips)
    .some(segment => segment.id === dep.id && segment.version === dep.version && isSurfaceSegmentLive(segment, nowMs)));
}

export class NavigationController {
  status: "idle" | "moving" | "arrived" | "blocked" | "unreachable" = "idle";
  /** Event sequence for a single reaction at each newly reached partial endpoint. */
  blockedCount = 0;
  route?: NavigationRoute;
  reason?: string;
  target?: NavigationTarget;
  private edgeIndex = 0;
  private edgeStartedAtMs?: number;
  private edgeFlightTick = 0;
  private nextPlanAtMs = 0;
  private plannedGeometry?: string;
  private blockedEndpoint?: NavigationTarget;
  private partialReason?: string;
  planningCount = 0;
  planningStats?: { nodes: number; candidates: number; simulations: number; budgetExhausted: boolean; elapsedMs: number };
  constructor(readonly profile: MovementProfile, readonly budget: NavigationBudget = NAVIGATION_BUDGET) {}
  setTarget(target?: NavigationTarget, force = false): void {
    if (!force && this.target && target && this.target.kind === target.kind && this.target.supportId === target.supportId && distance(this.target, target) < 0.25) return;
    this.target = target && { ...target };
    this.route = undefined;
    this.edgeIndex = 0;
    this.edgeStartedAtMs = undefined;
    this.nextPlanAtMs = 0;
    this.status = target ? "moving" : "idle";
    this.reason = undefined;
    this.blockedEndpoint = undefined;
    this.plannedGeometry = undefined;
    this.partialReason = undefined;
  }
  update(body: ActorBody, surface: SurfaceSnapshotV2, nowMs: number): MovementInput {
    if (!this.target) { this.status = "idle"; return {}; }
    if (this.status === "blocked" && this.plannedGeometry !== geometryFingerprint(surface, this.profile, nowMs)) {
      this.route = undefined; this.nextPlanAtMs = nowMs;
    }
    if (this.route && !routeIsValid(this.route, surface, nowMs, body.loadFraction)) {
      this.route = undefined;
      this.edgeStartedAtMs = undefined;
      this.nextPlanAtMs = nowMs;
    }
    if (!this.route) {
      const contactIsLive = body.grip
        ? surface.valid && this.profile.canClimb && surface.grips.some(g => g.id === body.grip!.id
          && g.version === body.grip!.version && isSurfaceSegmentLive(g, nowMs) && Math.abs(body.x - g.x) <= 6
          && body.y >= g.y1 && body.y <= Math.min(surface.floorY, g.y2 + this.profile.height))
        : body.support && livePlatforms(surface, nowMs).some(p => p.id === body.support!.id && p.version === body.support!.version
          && supportsFeet(body.x, this.profile.radius, p) && Math.abs(body.y - p.y) < 1e-7);
      if (!contactIsLive) { this.status = "moving"; this.reason = "等待角色落地后规划"; return {}; }
      if (nowMs < this.nextPlanAtMs) return {};
      const started = performance.now();
      const graph = buildNavigationGraph(surface, this.profile, nowMs, body, this.target, body.loadFraction, this.budget);
      this.planningCount++;
      this.planningStats = { nodes: graph.nodes.length, candidates: graph.candidates, simulations: graph.simulations,
        budgetExhausted: graph.budgetExhausted, elapsedMs: performance.now() - started };
      this.route = findApproachRoute(graph);
      this.plannedGeometry = geometryFingerprint(surface, this.profile, nowMs);
      this.edgeIndex = 0;
      this.edgeStartedAtMs = undefined;
      if (!this.route) {
        this.status = "unreachable";
        this.reason = graph.reason;
        this.nextPlanAtMs = nowMs + 1000;
        return {};
      }
      this.status = "moving";
      this.partialReason = this.route.partial ? graph.reason : undefined;
      this.reason = this.route.partial ? "正在前往已确认的最近可达位置；" + graph.reason : undefined;
    }
    const node = this.route.nodes[this.edgeIndex + 1];
    const edge = this.route.edges[this.edgeIndex];
    if (!edge || !node) {
      const goal = this.route.nodes[this.route.nodes.length - 1];
      if ((goal.kind === "grip" ? body.grip?.id : body.support?.id) === goal.supportId && distance(body, goal) <= 3) {
        if (this.route.partial) {
          if (!this.blockedEndpoint || distance(this.blockedEndpoint, goal) >= 1
            || this.blockedEndpoint.supportId !== goal.supportId || this.blockedEndpoint.kind !== goal.kind) this.blockedCount++;
          this.blockedEndpoint = { ...goal };
          this.status = "blocked";
          this.reason = "已到达本次搜索确认的最近可达位置；" + this.partialReason;
        } else this.status = "arrived";
        return {};
      }
      this.route = undefined; this.nextPlanAtMs = nowMs + 100;
      return {};
    }
    const attached = node.kind === "platform" ? body.support?.id === node.supportId : body.grip?.id === node.supportId;
    const tolerance = edge.kind === "walk" || edge.kind === "climb" ? 0.05 : 3;
    if (attached && Math.abs(body.x - node.x) <= tolerance && Math.abs(body.y - node.y) <= (edge.kind === "climb" ? 0.05 : 2)) {
      this.edgeIndex++;
      this.edgeStartedAtMs = undefined;
      return this.update(body, surface, nowMs);
    }
    const first = this.edgeStartedAtMs === undefined;
    if (first && (edge.kind === "jump" || edge.kind === "drop")) {
      const source = this.route.nodes[this.edgeIndex];
      if (source.kind === "platform" && body.support?.id === source.supportId && Math.abs(body.x - source.x) > 0.05) {
        return { moveX: Math.max(-1, Math.min(1, (source.x - body.x) / (this.profile.speed * movementScale(this.profile, body.loadFraction) * FIXED_DT))) };
      }
      if (source.kind === "grip" && body.grip?.id === source.supportId && Math.abs(body.y - source.y) > 0.05) {
        return { gripId: source.supportId, climb: Math.max(-1, Math.min(1, (source.y - body.y) / (this.profile.climbSpeed * movementScale(this.profile, body.loadFraction) * FIXED_DT))) };
      }
    }
    if (first) this.edgeFlightTick = 0;
    this.edgeStartedAtMs ??= nowMs;
    const elapsed = (nowMs - this.edgeStartedAtMs) / 1000;
    if (elapsed > edge.duration + 0.8 || (!first && (edge.kind === "jump" || edge.kind === "drop") && body.support && body.support.id !== node.supportId)) {
      this.route = undefined;
      this.edgeStartedAtMs = undefined;
      this.nextPlanAtMs = nowMs + 100;
      this.reason = "落点改变，重新规划";
      return {};
    }
    this.status = "moving";
    if (node.kind === "grip" && body.grip?.id === node.supportId) {
      return { gripId: node.supportId, climb: Math.max(-1, Math.min(1, (node.y - body.y) / (this.profile.climbSpeed * movementScale(this.profile, body.loadFraction) * FIXED_DT))) };
    }
    if (edge.kind === "climb") {
      return { gripId: node.supportId, climb: Math.max(-1, Math.min(1, (node.y - body.y) / (this.profile.climbSpeed * movementScale(this.profile, body.loadFraction) * FIXED_DT))) };
    }
    if (edge.kind === "walk") {
      return { releaseGrip: true, moveX: Math.max(-1, Math.min(1, (node.x - body.x) / (this.profile.speed * movementScale(this.profile, body.loadFraction) * FIXED_DT))) };
    }
    // Flight steering follows the verified constant input until actual contact.
    if (body.support?.id === node.supportId && !first) {
      return { moveX: Math.max(-1, Math.min(1, (node.x - body.x) / (this.profile.speed * movementScale(this.profile, body.loadFraction) * FIXED_DT))) };
    }
    const atGrip = node.kind === "grip" && edge.gripAtTick !== undefined
      && this.edgeFlightTick >= edge.gripAtTick;
    this.edgeFlightTick++;
    return { moveX: atGrip ? 0 : edge.moveX, gripId: atGrip ? node.supportId : undefined,
      jump: first && edge.kind === "jump", drop: first && edge.kind === "drop", releaseGrip: first && edge.kind === "drop" };
  }
}

/** Ignore capture revisions and refreshed expiry deadlines, but notice live
 * geometry changes (including an added bridge) and expiry of existing terrain. */
function geometryFingerprint(surface: SurfaceSnapshotV2, profile: MovementProfile, nowMs: number): string {
  return JSON.stringify([surface.displayId, surface.width, surface.floorY, surface.valid,
    livePlatforms(surface, nowMs).map(p => [p.id, p.version, p.x1, p.x2, p.y]).sort(),
    surface.valid && profile.canClimb ? surface.grips.filter(g => isSurfaceSegmentLive(g, nowMs))
      .map(g => [g.id, g.version, g.x, g.y1, g.y2]).sort() : []]);
}
