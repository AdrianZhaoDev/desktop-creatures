import type { TongueOccluder } from "../agent-runtime/geometry";
import type { BinGeometry, Point } from "../native/types";

export const CAMPAIGN_UI_OCCLUDER_SELECTORS = Object.freeze([
  ".campaign-ui__toolbar",
  ".campaign-ui__panel",
  ".campaign-ui__devices",
  ".campaign-ui__tutorial",
  ".campaign-ui__phase",
  ".campaign-ui__lobby",
  ".campaign-runtime__messages",
  ".campaign-display-controls__surface",
  ".campaign-runtime__practice-bin",
] as const);

const CAMPAIGN_UI_OCCLUDER_SELECTOR = CAMPAIGN_UI_OCCLUDER_SELECTORS.join(",");

type VisibilityElement = HTMLElement & {
  readonly parentElement: VisibilityElement | null;
};

function hiddenBySelfOrAncestor(element: VisibilityElement): boolean {
  let current: VisibilityElement | null = element;
  while (current) {
    if (current.hidden || current.inert) return true;
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
    current = current.parentElement;
  }
  return false;
}

function finiteRect(rect: Pick<DOMRect, "left" | "top" | "width" | "height">): boolean {
  return [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
    && rect.width >= 0 && rect.height >= 0;
}

/**
 * Desktop windows are navigable captured scenery behind the always-on-top actors, not
 * foreground opaque obstacles. Only foreground campaign UI and the native bin belong in
 * the frog tongue occluder port. Undefined means the host could not certify visibility.
 */
export function readCampaignUiOccluders(root: ParentNode): readonly TongueOccluder[] | undefined {
  const connected = (root as ParentNode & { readonly isConnected?: boolean }).isConnected;
  if (connected === false) return undefined;
  try {
    const elements = [...root.querySelectorAll<HTMLElement>(CAMPAIGN_UI_OCCLUDER_SELECTOR)];
    const occluders: TongueOccluder[] = [];
    for (const element of elements) {
      if (element.isConnected === false) return undefined;
      if (hiddenBySelfOrAncestor(element as VisibilityElement)) continue;
      const rect = element.getBoundingClientRect();
      if (!finiteRect(rect)) return undefined;
      if (rect.width === 0 || rect.height === 0) continue;
      occluders.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }
    return occluders;
  } catch {
    return undefined;
  }
}

/** Converts a global physical-pixel native bin rectangle to display-local DIP. */
export function nativeBinOccluder(
  geometry: BinGeometry,
  displayOriginPhysical: Readonly<Point>,
  dpiScale: number,
): TongueOccluder | undefined {
  const values = [
    geometry.x, geometry.y, geometry.width, geometry.height, geometry.scale,
    geometry.mouthX, geometry.mouthY,
    displayOriginPhysical.x, displayOriginPhysical.y, dpiScale,
  ];
  if (!values.every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0
    || geometry.scale <= 0 || dpiScale <= 0) return undefined;
  return {
    x: (geometry.x - displayOriginPhysical.x) / dpiScale,
    y: (geometry.y - displayOriginPhysical.y) / dpiScale,
    width: geometry.width / dpiScale,
    height: geometry.height / dpiScale,
  };
}
