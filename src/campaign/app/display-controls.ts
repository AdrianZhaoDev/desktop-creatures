import type { Locale } from "../i18n";
import type { CampaignDisplayInfo } from "../native/types";
import { uiText, type UiMessageKey } from "../ui/copy";
import type { CampaignDisplayController, CampaignDisplayMoveState } from "./display-move";
import "./display-controls.css";

const DISPLAY_PAGE_SIZE = 2;

export interface CampaignDisplayControlsMount {
  /** Re-reads the locale callback and current controller snapshot. */
  update(): void;
  dispose(): void;
}

type Feedback = Readonly<{
  kind: "success" | "error";
  key: UiMessageKey;
  displayId?: string;
  bindingGeneration?: number;
  topologyRevision?: number;
}>;

const escapeHtml = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

function label(display: CampaignDisplayInfo, locale: Locale): string {
  const name = display.name?.trim() || display.id;
  return display.primary ? `${name} (${uiText(locale, "display.primary")})` : name;
}

function details(display: CampaignDisplayInfo, locale: Locale): string {
  return uiText(locale, "display.details", {
    width: display.size.width,
    height: display.size.height,
    scale: Math.round(display.scaleFactor * 100),
  });
}

function button(action: string, text: string, options: {
  displayId?: string;
  focus: string;
  disabled?: boolean;
  className?: string;
  pressed?: boolean;
  controls?: string;
}): string {
  const displayId = options.displayId === undefined ? "" : ` data-display-id="${escapeHtml(options.displayId)}"`;
  const disabled = options.disabled ? " disabled" : "";
  const className = options.className ? ` class="${options.className}"` : "";
  const pressed = options.pressed === undefined ? "" : ` aria-pressed="${options.pressed}"`;
  const controls = options.controls ? ` aria-controls="${escapeHtml(options.controls)}"` : "";
  return `<button type="button"${className} data-ui-action="display.${action}" data-display-action="${action}"${displayId} data-display-focus="${escapeHtml(options.focus)}"${pressed}${controls}${disabled}>${escapeHtml(text)}</button>`;
}

function statusMessage(
  state: CampaignDisplayMoveState,
  locale: Locale,
  feedback: Feedback | null,
  pending: CampaignDisplayInfo | undefined,
  busy: boolean,
): { kind: "status" | "success" | "error"; text: string } | null {
  if (busy && pending) return { kind: "status", text: uiText(locale, "display.moving", { display: label(pending, locale) }) };
  if (feedback) {
    const display = feedback.displayId === undefined
      ? undefined
      : state.native?.displays.find(candidate => candidate.id === feedback.displayId);
    const text = feedback.displayId === undefined
      ? uiText(locale, feedback.key)
      : uiText(locale, feedback.key, { display: display ? label(display, locale) : feedback.displayId });
    return { kind: feedback.kind, text };
  }
  if (!state.native || state.native.phase === "disconnected") return { kind: "error", text: uiText(locale, "display.unavailable") };
  if (state.native.phase === "topology-changed") return { kind: "error", text: uiText(locale, "display.topologyChanged") };
  if (state.native.phase === "failed" || state.error) return { kind: "error", text: uiText(locale, "display.failed") };
  if (state.native.phase === "awaiting-surface") return { kind: "status", text: uiText(locale, "display.awaiting") };
  return null;
}

function markup(
  state: CampaignDisplayMoveState,
  locale: Locale,
  expanded: boolean,
  pendingId: string | null,
  page: number,
  feedback: Feedback | null,
  locallyBusy: boolean,
): string {
  const native = state.native;
  const current = native?.displays.find(display => display.id === native.displayId);
  const pending = native?.displays.find(display => display.id === pendingId);
  const busy = state.moving || locallyBusy;
  const recovering = !!native && (native.phase !== "ready" || !!state.error);
  const candidates = native?.displays.filter(display => recovering || display.id !== native.displayId) ?? [];
  const pageStart = page * DISPLAY_PAGE_SIZE;
  const visibleCandidates = candidates.slice(pageStart, pageStart + DISPLAY_PAGE_SIZE);
  const currentLabel = current ? label(current, locale) : "—";
  const status = statusMessage(state, locale, feedback, pending, busy);
  const statusHtml = status
    ? `<output class="campaign-display-controls__feedback" data-kind="${status.kind}" aria-live="polite" aria-atomic="true">${escapeHtml(status.text)}</output>`
    : `<output class="campaign-display-controls__feedback" aria-live="polite" aria-atomic="true"></output>`;
  const toggle = button("toggle", uiText(locale, expanded ? "display.close" : "display.open"), {
    focus: "toggle", disabled: busy, className: "campaign-display-controls__toggle",
  });
  if (!expanded) {
    return `<section class="campaign-display-controls__surface" aria-labelledby="campaign-display-title"><div><h2 id="campaign-display-title">${escapeHtml(uiText(locale, "display.currentRun"))}</h2><p>${escapeHtml(uiText(locale, "display.current", { display: currentLabel }))}</p></div>${toggle}${statusHtml}</section>`;
  }

  const choices = candidates.length > 0
    ? `<ul class="campaign-display-controls__choices">${visibleCandidates.map(display => {
      const selected = display.id === pendingId;
      return `<li>${button("select", label(display, locale), {
        displayId: display.id,
        focus: `display:${display.id}`,
        disabled: busy,
        className: "campaign-display-controls__choice",
        pressed: selected,
      })}<small>${escapeHtml(details(display, locale))}</small></li>`;
    }).join("")}</ul>`
    : `<p class="campaign-display-controls__empty">${escapeHtml(uiText(locale, "display.noOther"))}</p>`;
  const lastVisible = Math.min(candidates.length, pageStart + DISPLAY_PAGE_SIZE);
  const currentRange = lastVisible > pageStart + 1 ? `${pageStart + 1}–${lastVisible}` : String(lastVisible);
  const pagination = candidates.length > DISPLAY_PAGE_SIZE
    ? `<nav class="campaign-display-controls__pagination" aria-label="${escapeHtml(uiText(locale, "display.choose"))}">${button("previous", uiText(locale, "display.previous"), {
      focus: "previous", disabled: busy || page === 0,
    })}<span aria-live="polite">${escapeHtml(uiText(locale, "display.page", { current: currentRange, total: candidates.length }))}</span>${button("next", uiText(locale, "display.next"), {
      focus: "next", disabled: busy || lastVisible >= candidates.length,
    })}</nav>`
    : "";

  const confirmation = pending
    ? `<section class="campaign-display-controls__confirmation" aria-labelledby="campaign-display-confirm-title"><h3 id="campaign-display-confirm-title">${escapeHtml(uiText(locale, "display.confirmTitle", { display: label(pending, locale) }))}</h3><p>${escapeHtml(uiText(locale, "display.confirmBody"))}</p><div class="campaign-display-controls__actions">${button("confirm", feedback?.key === "display.failed" ? uiText(locale, "display.retry") : uiText(locale, "display.confirm"), {
      displayId: pending.id, focus: "confirm", disabled: busy, className: "campaign-display-controls__confirm",
    })}${button("cancel", uiText(locale, "display.cancel"), { focus: "cancel", disabled: busy })}</div></section>`
    : "";
  const canRefresh = !native || native.phase === "disconnected" || native.phase === "topology-changed" || native.phase === "failed" || !!state.error;
  const refresh = canRefresh
    ? button("refresh", uiText(locale, "display.refresh"), { focus: "refresh", disabled: busy })
    : "";
  const scrollControls = `<nav class="campaign-display-controls__scroll-controls" aria-label="${escapeHtml(uiText(locale, "display.currentRun"))}">${button("scroll-up", `▲ ${uiText(locale, "display.previous")}`, {
    focus: "scroll-up", className: "campaign-display-controls__scroll-button", controls: "campaign-display-scroll", disabled: true,
  })}${button("scroll-down", `▼ ${uiText(locale, "display.next")}`, {
    focus: "scroll-down", className: "campaign-display-controls__scroll-button", controls: "campaign-display-scroll",
  })}</nav>`;

  return `<section class="campaign-display-controls__surface campaign-display-controls__surface--open" role="dialog" aria-modal="false" data-native-input-modal aria-labelledby="campaign-display-title"><div id="campaign-display-scroll" class="campaign-display-controls__viewport" data-display-scroll><header><div><h2 id="campaign-display-title">${escapeHtml(uiText(locale, "display.currentRun"))}</h2><p>${escapeHtml(uiText(locale, "display.current", { display: currentLabel }))}</p></div>${toggle}</header><p id="campaign-display-help" class="campaign-display-controls__help">${escapeHtml(uiText(locale, "display.help"))}</p><fieldset aria-describedby="campaign-display-help"${busy ? " disabled" : ""}><legend>${escapeHtml(uiText(locale, "display.choose"))}</legend>${choices}${pagination}</fieldset>${confirmation}${refresh}${statusHtml}</div>${scrollControls}</section>`;
}

/** Mounts a current-run display mover. It never changes the saved next-run display preference. */
export function mountCampaignDisplayControls(
  root: HTMLElement,
  controller: CampaignDisplayController,
  locale: () => Locale,
): CampaignDisplayControlsMount {
  let expanded = false;
  let pendingId: string | null = null;
  let page = 0;
  let feedback: Feedback | null = null;
  let localBusy = false;
  let disposed = false;
  let lastMarkup = "";

  const syncScrollButtons = (): void => {
    const viewport = root.querySelector<HTMLElement>("[data-display-scroll]");
    if (!viewport) return;
    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const up = root.querySelector<HTMLButtonElement>('[data-display-action="scroll-up"]');
    const down = root.querySelector<HTMLButtonElement>('[data-display-action="scroll-down"]');
    if (up) up.disabled = viewport.scrollTop <= 0;
    if (down) down.disabled = viewport.scrollTop >= maximum;
  };

  const scroll = (direction: -1 | 1): void => {
    const viewport = root.querySelector<HTMLElement>("[data-display-scroll]");
    if (!viewport) return;
    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const step = Math.max(80, viewport.clientHeight * 0.7);
    viewport.scrollTop = Math.max(0, Math.min(maximum, viewport.scrollTop + direction * step));
    syncScrollButtons();
  };

  const render = (): void => {
    if (disposed) return;
    const state = controller.getState();
    if (feedback?.kind === "success") {
      const native = state.native;
      if (!native || native.phase !== "ready" || native.displayId !== feedback.displayId
        || native.bindingGeneration !== feedback.bindingGeneration
        || native.topologyRevision !== feedback.topologyRevision) feedback = null;
    }
    if (pendingId) {
      const exists = state.native?.displays.some(display => display.id === pendingId) === true;
      if (!exists) {
        pendingId = null;
        feedback = { kind: "error", key: "display.stale" };
      } else if (state.native?.displayId === pendingId && state.native.phase === "ready" && !state.error
        && !state.moving && !localBusy && feedback?.kind !== "error") {
        pendingId = null;
      }
    }
    const native = state.native;
    const recovering = !!native && (native.phase !== "ready" || !!state.error);
    const candidateCount = native?.displays.filter(display => recovering || display.id !== native.displayId).length ?? 0;
    page = Math.min(page, Math.max(0, Math.ceil(candidateCount / DISPLAY_PAGE_SIZE) - 1));
    const language = locale();
    const nextMarkup = markup(state, language, expanded, pendingId, page, feedback, localBusy);
    root.setAttribute("lang", language);
    root.setAttribute("aria-busy", String(state.moving || localBusy));
    if (nextMarkup === lastMarkup) { syncScrollButtons(); return; }
    const focusKey = (root.ownerDocument.activeElement as HTMLElement | null)?.dataset.displayFocus;
    const previousScroll = root.querySelector<HTMLElement>("[data-display-scroll]")?.scrollTop ?? 0;
    root.innerHTML = nextMarkup;
    lastMarkup = nextMarkup;
    const viewport = root.querySelector<HTMLElement>("[data-display-scroll]");
    if (viewport) viewport.scrollTop = Math.min(previousScroll, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
    syncScrollButtons();
    if (focusKey) {
      const match = Array.from(root.querySelectorAll<HTMLElement>("[data-display-focus]"))
        .find(element => element.dataset.displayFocus === focusKey && !element.matches(":disabled"));
      match?.focus();
    }
  };

  const refresh = async (): Promise<void> => {
    if (localBusy || controller.getState().moving) return;
    localBusy = true;
    feedback = null;
    render();
    try {
      await controller.refresh();
      if (!disposed && (controller.getState().error || controller.getState().native?.phase === "failed")) {
        feedback = { kind: "error", key: "display.failed" };
      }
    } catch {
      if (!disposed) feedback = { kind: "error", key: "display.failed" };
    } finally {
      localBusy = false;
      render();
    }
  };

  const move = async (targetDisplayId: string): Promise<void> => {
    if (localBusy || controller.getState().moving) return;
    const state = controller.getState();
    const target = state.native?.displays.find(display => display.id === targetDisplayId);
    const retryingIncompleteBinding = state.native?.displayId === targetDisplayId
      && (state.native.phase !== "ready" || !!state.error);
    if (!target || state.native?.displayId === targetDisplayId && !retryingIncompleteBinding) {
      pendingId = null;
      feedback = { kind: "error", key: "display.stale" };
      render();
      return;
    }
    localBusy = true;
    pendingId = targetDisplayId;
    feedback = null;
    render();
    let success = false;
    try {
      success = await controller.move(targetDisplayId);
    } catch {
      success = false;
    }
    if (disposed) return;
    localBusy = false;
    if (success) {
      const completed = controller.getState().native;
      expanded = false;
      pendingId = null;
      feedback = {
        kind: "success",
        key: "display.moved",
        displayId: targetDisplayId,
        bindingGeneration: completed?.bindingGeneration,
        topologyRevision: completed?.topologyRevision,
      };
    } else {
      const stillAvailable = controller.getState().native?.displays.some(display => display.id === targetDisplayId) === true;
      pendingId = stillAvailable ? targetDisplayId : null;
      feedback = { kind: "error", key: stillAvailable ? "display.failed" : "display.stale" };
    }
    render();
  };

  const onClick = (event: Event): void => {
    const target = event.target as Element | null;
    const control = target?.closest?.<HTMLButtonElement>("button[data-display-action]");
    if (!control || !root.contains(control) || control.disabled) return;
    const action = control.dataset.displayAction;
    if (action === "toggle") {
      expanded = !expanded;
      if (!expanded) { pendingId = null; page = 0; }
      feedback = null;
      render();
    } else if (action === "select") {
      pendingId = control.dataset.displayId ?? null;
      feedback = null;
      render();
    } else if (action === "cancel") {
      pendingId = null;
      feedback = null;
      render();
    } else if (action === "previous") {
      page = Math.max(0, page - 1);
      render();
    } else if (action === "next") {
      page++;
      render();
    } else if (action === "scroll-up") {
      scroll(-1);
    } else if (action === "scroll-down") {
      scroll(1);
    } else if (action === "confirm" && control.dataset.displayId) {
      void move(control.dataset.displayId);
    } else if (action === "refresh") {
      void refresh();
    }
  };
  const onScroll = (event: Event): void => {
    if (event.target === root.querySelector("[data-display-scroll]")) syncScrollButtons();
  };

  root.className = "campaign-display-controls";
  root.addEventListener("click", onClick);
  root.addEventListener("scroll", onScroll, true);
  const unsubscribe = controller.subscribe(render);
  render();
  return {
    update: render,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      root.removeEventListener("click", onClick);
      root.removeEventListener("scroll", onScroll, true);
      root.replaceChildren();
      root.removeAttribute("class");
      root.removeAttribute("lang");
      root.removeAttribute("aria-busy");
    },
  };
}
