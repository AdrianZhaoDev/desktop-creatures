import type { CampaignSettings, EffectLevel } from "../campaign-settings";
import { formatNumber, type Locale } from "../i18n";
import type { MetaProgress, ResearchSettlement } from "../research";
import type { TutorialState } from "../tutorial";
import { campaignUiRootAttributes, mountCampaignUi, type CampaignUiMount, type CampaignUiMountOptions } from "./campaign-ui";
import {
  CampaignCommandCoordinator,
  type CampaignUiCommandFactory,
  type CampaignUiCommandHandler,
  type CampaignUiCommandResultLike,
} from "./command-dispatch";
import { uiText } from "./copy";
import { renderCampaignDisplayOptions } from "./display-options";
import { researchNodeViewsFor, type CampaignUiCommand, type CampaignUiCommandBody, type CampaignUiLocalState, type CampaignUiSnapshot } from "./model";

/** Structurally compatible with CampaignApplication's lobby snapshot without importing it at runtime. */
export interface CampaignLobbySnapshot {
  readonly mode: "lobby";
  readonly revision: string;
  readonly meta: MetaProgress;
  readonly settlement: ResearchSettlement | null;
  readonly settings: CampaignSettings;
  readonly tutorial: TutorialState;
  readonly ui: CampaignUiLocalState;
  readonly availableDisplays: readonly { readonly id: string; readonly label: string }[];
}

export type CampaignApplicationUiSnapshot =
  | { readonly mode: "run"; readonly revision: string; readonly ui: CampaignUiSnapshot }
  | CampaignLobbySnapshot;

export interface CampaignLobbyMountOptions {
  readonly onHomeAction?: CampaignUiMountOptions['onHomeAction'];
  readonly onMenuOpenChange?: CampaignUiMountOptions['onMenuOpenChange'];
  readonly onCommand: CampaignUiCommandHandler;
  /** Production callers must inject CampaignApplication.createCommand. The fallback is test compatibility only. */
  readonly createCommand?: CampaignUiCommandFactory;
  readonly onSuccess?: (result: CampaignUiCommandResultLike | undefined, command: CampaignUiCommand) => void | Promise<void>;
  readonly onRefresh?: (result: CampaignUiCommandResultLike | undefined, command: CampaignUiCommand) => void | Promise<void>;
}

export interface CampaignLobbyMount {
  update(snapshot: CampaignLobbySnapshot): void;
  destroy(): void;
  getSnapshot(): CampaignLobbySnapshot;
  isBusy(): boolean;
}

export interface CampaignApplicationUiMount {
  openHomeControls(houseId: string): void;
  closeMenu(): void;
  isMenuOpen(): boolean;
  update(snapshot: CampaignApplicationUiSnapshot): void;
  destroy(): void;
  getSnapshot(): CampaignApplicationUiSnapshot;
  isBusy(): boolean;
}

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}
function selected(value: string, expected: string): string { return value === expected ? " selected" : ""; }
function checked(value: boolean): string { return value ? " checked" : ""; }
function disabled(value: boolean): string { return value ? " disabled" : ""; }

export function snapshotCampaignLobby(source: CampaignLobbySnapshot): CampaignLobbySnapshot {
  return Object.freeze(structuredClone(source));
}

/** @deprecated Test-only fallback. It is mount-local and must not be reused in production. */
export function createLegacyLobbyUiCommand(snapshot: CampaignLobbySnapshot, sequence: number, body: CampaignUiCommandBody): CampaignUiCommand {
  return { ...body, commandId: `lobby:ui:${sequence}`, readRevision: snapshot.revision } as CampaignUiCommand;
}

/** @deprecated Test-only fallback shared by the application mount wrapper. Production uses CampaignApplication.createCommand. */
export function createTestOnlyMonotonicCommandFactory(prefix: string, readRevision: () => string): CampaignUiCommandFactory {
  let sequence = 0;
  return (body): CampaignUiCommand => ({ ...body, commandId: `${prefix}:${++sequence}`, readRevision: readRevision() } as CampaignUiCommand);
}

function outcomeText(locale: Locale, outcome: ResearchSettlement["outcome"]): string {
  return uiText(locale, `outcome.${outcome}`);
}

function recentSettlement(snapshot: CampaignLobbySnapshot): string {
  const locale = snapshot.settings.language;
  const settlement = snapshot.settlement;
  if (!settlement) return `<section class="campaign-ui__lobby-section" aria-labelledby="lobby-recent"><h2 id="lobby-recent">${escapeHtml(uiText(locale, "lobby.recent"))}</h2><p>${escapeHtml(uiText(locale, "lobby.noRecent"))}</p></section>`;
  const values = [
    [uiText(locale, "lobby.mission"), settlement.missionId],
    [uiText(locale, "lobby.run"), settlement.runId],
    [uiText(locale, "lobby.outcome"), outcomeText(locale, settlement.outcome)],
    [uiText(locale, "lobby.score"), formatNumber(locale, settlement.score)],
    [uiText(locale, "lobby.reward"), formatNumber(locale, settlement.researchReward)],
  ];
  return `<section class="campaign-ui__lobby-section" aria-labelledby="lobby-recent"><h2 id="lobby-recent">${escapeHtml(uiText(locale, "lobby.recent"))}</h2><dl class="campaign-ui__lobby-metrics">${values.map(([label, value], index) => `<div><dt>${escapeHtml(label)}</dt><dd${index < 2 ? " class=\"campaign-ui__resource-id\"" : ""}>${escapeHtml(value)}</dd></div>`).join("")}</dl></section>`;
}

function appearancePicker(snapshot: CampaignLobbySnapshot): string {
  const locale = snapshot.settings.language;
  const current = snapshot.meta.appearanceId === "male" ? "male" : "female";
  return `<fieldset class="campaign-ui__lobby-section campaign-ui__appearance"><legend>${escapeHtml(uiText(locale, "lobby.appearance"))}</legend>${(["female", "male"] as const).map(appearanceId => `<label class="campaign-ui__appearance-card"><input type="radio" name="campaign-appearance" value="${appearanceId}" data-ui-action="appearance.select" data-focus-key="appearance:${appearanceId}"${checked(current === appearanceId)}><span><strong>${escapeHtml(uiText(locale, `lobby.${appearanceId}`))}</strong><small>${escapeHtml(uiText(locale, `lobby.${appearanceId}Body`))}</small>${current === appearanceId ? `<em>${escapeHtml(uiText(locale, "lobby.selected"))}</em>` : ""}</span></label>`).join("")}</fieldset>`;
}

function research(snapshot: CampaignLobbySnapshot): string {
  const locale = snapshot.settings.language;
  const nodes = researchNodeViewsFor(locale, snapshot.meta).filter(node => node.demo).map(node => {
    const stateLabel = node.state === "owned" ? uiText(locale, "research.owned") : node.state === "prerequisite" ? uiText(locale, "research.locked", { id: node.prerequisite ?? "" }) : uiText(locale, "research.buy", { cost: node.cost });
    return `<article class="campaign-ui__card is-${node.state}" data-resource-id="${escapeHtml(node.id)}"><header><h3>${escapeHtml(node.branchName)} · ${node.tier}</h3><code>${escapeHtml(node.id)}</code></header><p>${escapeHtml(node.effect)}</p><button type="button" data-ui-action="research.purchase" data-id="${escapeHtml(node.id)}" data-focus-key="research:${escapeHtml(node.id)}"${disabled(node.state !== "available")}>${escapeHtml(stateLabel)}</button></article>`;
  }).join("");
  return `<section class="campaign-ui__lobby-section campaign-ui__lobby-research" aria-labelledby="lobby-research"><header><div><h2 id="lobby-research">${escapeHtml(uiText(locale, "lobby.researchTitle"))}</h2><p>${escapeHtml(uiText(locale, "lobby.researchBody"))}</p></div><div class="campaign-ui__research-balance"><strong>${escapeHtml(uiText(locale, "research.balance", { count: formatNumber(locale, snapshot.meta.researchPoints) }))}</strong><button type="button" data-ui-action="research.reset" data-focus-key="research:reset"${disabled(snapshot.meta.nodes.length === 0)}>${escapeHtml(uiText(locale, "research.freeRespec"))}</button></div></header><div class="campaign-ui__grid">${nodes}</div></section>`;
}

function option(locale: Locale, value: string): string {
  return uiText(locale, `option.${value as "low" | "medium" | "high" | "gentle" | "standard" | "intense" | "desktop" | "practice" | EffectLevel}`);
}
function selectOptions(locale: Locale, values: readonly string[], current: string): string {
  return values.map(value => `<option value="${escapeHtml(value)}"${selected(value, current)}>${escapeHtml(option(locale, value))}</option>`).join("");
}

function settings(snapshot: CampaignLobbySnapshot): string {
  const locale = snapshot.settings.language;
  const value = snapshot.settings;
  const setting = (label: string, path: string, choices: string): string => `<label>${escapeHtml(label)}<select data-ui-action="settings.update" data-path="${escapeHtml(path)}" data-focus-key="settings:${escapeHtml(path)}">${choices}</select></label>`;
  const languages = `<option value="zh-CN"${selected("zh-CN", locale)}>简体中文</option><option value="en"${selected("en", locale)}>English</option>`;
  const scales = ([1, 1.5, 2] as const).map(scale => `<option value="${scale}"${selected(String(scale), String(value.visual.uiScale))}>${scale * 100}%</option>`).join("");
  const displays = renderCampaignDisplayOptions(locale, value.gameplay.displayId, snapshot.availableDisplays);
  const diagnostics = `<label class="campaign-ui__check"><input type="checkbox" data-ui-action="settings.update" data-path="diagnosticsConsent" data-value-type="boolean" data-focus-key="settings:diagnosticsConsent"${checked(value.diagnosticsConsent)}><span>${escapeHtml(uiText(locale, "settings.diagnostics"))}</span></label>`;
  return `<section class="campaign-ui__lobby-section" aria-labelledby="lobby-settings"><h2 id="lobby-settings">${escapeHtml(uiText(locale, "lobby.settingsTitle"))}</h2><div class="campaign-ui__lobby-settings">${setting(uiText(locale, "settings.language"), "language", languages)}${setting(uiText(locale, "settings.uiScale"), "visual.uiScale", scales)}${setting(uiText(locale, "settings.quality"), "visual.quality", selectOptions(locale, ["low", "medium", "high"], value.visual.quality))}${setting(uiText(locale, "settings.intensity"), "gameplay.intensity", selectOptions(locale, ["gentle", "standard", "intense"], value.gameplay.intensity))}${setting(uiText(locale, "settings.detection"), "gameplay.detectionMode", selectOptions(locale, ["desktop", "practice"], value.gameplay.detectionMode))}${setting(uiText(locale, "settings.display"), "gameplay.displayId", displays)}${diagnostics}</div></section>`;
}

export function renderCampaignLobby(snapshot: CampaignLobbySnapshot): string {
  const locale = snapshot.settings.language;
  return `<main class="campaign-ui__lobby" tabindex="-1" data-lobby-focus aria-labelledby="campaign-lobby-title"><header class="campaign-ui__lobby-hero"><div><p class="campaign-ui__eyebrow">Desktop Creatures</p><h1 id="campaign-lobby-title">${escapeHtml(uiText(locale, "lobby.title"))}</h1><p>${escapeHtml(uiText(locale, "lobby.subtitle"))}</p></div><section class="campaign-ui__start" aria-labelledby="lobby-start-title"><h2 id="lobby-start-title">${escapeHtml(uiText(locale, "lobby.startTitle"))}</h2><p>${escapeHtml(uiText(locale, "lobby.startBody"))}</p><button type="button" class="campaign-ui__primary" data-ui-action="campaign.start" data-focus-key="campaign:start">${escapeHtml(uiText(locale, "lobby.start"))}</button></section></header><output class="campaign-ui__announcer campaign-ui__feedback" aria-live="polite" aria-atomic="true"></output>${appearancePicker(snapshot)}${recentSettlement(snapshot)}${research(snapshot)}${settings(snapshot)}</main>`;
}

function setRootBusy(root: HTMLElement, busy: boolean): void {
  root.setAttribute("aria-busy", String(busy));
  for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("button, select, input")) {
    if (busy && !control.disabled) { control.disabled = true; control.dataset.uiBusyDisabled = "true"; }
    else if (!busy && control.dataset.uiBusyDisabled === "true") { control.disabled = false; delete control.dataset.uiBusyDisabled; }
  }
}

export function mountCampaignLobby(root: HTMLElement, initial: CampaignLobbySnapshot, options: CampaignLobbyMountOptions): CampaignLobbyMount {
  let snapshot = snapshotCampaignLobby(initial);
  let sequence = 0;
  let destroyed = false;
  const feedback = (kind: "busy" | "success" | "error", message: string): void => {
    if (destroyed) return;
    const output = root.querySelector<HTMLOutputElement>(".campaign-ui__announcer");
    if (output) { output.dataset.kind = kind; output.textContent = message; }
  };
  const factory = options.createCommand ?? ((body: CampaignUiCommandBody) => createLegacyLobbyUiCommand(snapshot, ++sequence, body));
  const coordinator = new CampaignCommandCoordinator({
    createCommand: factory,
    onCommand: options.onCommand,
    onBusyChange: busy => { if (!destroyed) setRootBusy(root, busy); if (busy) feedback("busy", uiText(snapshot.settings.language, "feedback.busy")); },
    onFailure: reason => feedback("error", uiText(snapshot.settings.language, "feedback.failure", { reason })),
    onSuccess: async (result, command) => { feedback("success", uiText(snapshot.settings.language, "feedback.success")); await options.onSuccess?.(result, command); },
    onRefresh: options.onRefresh,
  });
  const render = (focusKey?: string, focusMain = false): void => {
    root.className = "campaign-ui campaign-ui--lobby";
    for (const [name, attribute] of Object.entries(campaignUiRootAttributes(snapshot))) root.setAttribute(name, attribute);
    root.innerHTML = renderCampaignLobby(snapshot);
    setRootBusy(root, coordinator.busy);
    const target = focusMain ? root.querySelector<HTMLElement>("[data-lobby-focus]") : focusKey ? root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`) : null;
    target?.focus();
  };
  const submit = (body: CampaignUiCommandBody): void => { void coordinator.submit(body); };
  const onClick = (event: Event): void => {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-ui-action]");
    if (!target || !root.contains(target) || target instanceof HTMLButtonElement && target.disabled) return;
    const action = target.dataset.uiAction;
    if (action === "campaign.start") submit({ type: "campaign.start" });
    else if (action === "research.purchase" && target.dataset.id) submit({ type: "research.purchase", nodeId: target.dataset.id });
    else if (action === "research.reset") submit({ type: "research.reset" });
  };
  const onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || !root.contains(target)) return;
    if (target.dataset.uiAction === "appearance.select" && target instanceof HTMLInputElement && (target.value === "female" || target.value === "male")) {
      submit({ type: "appearance.select", appearanceId: target.value });
      return;
    }
    if (target.dataset.uiAction !== "settings.update" || !target.dataset.path) return;
    const raw = target.value;
    const value: string | number | boolean = target.dataset.valueType === "boolean" && target instanceof HTMLInputElement ? target.checked : target.dataset.path === "visual.uiScale" ? Number(raw) : raw;
    submit({ type: "settings.update", path: target.dataset.path, value });
  };
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  render(undefined, true);
  return {
    update(next): void {
      const active = root.ownerDocument.activeElement as HTMLElement | null;
      const focusKey = active?.dataset.focusKey;
      snapshot = snapshotCampaignLobby(next);
      render(focusKey);
    },
    destroy(): void {
      destroyed = true;
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      root.replaceChildren();
      root.removeAttribute("class"); root.removeAttribute("aria-busy");
      for (const name of Object.keys(campaignUiRootAttributes(snapshot))) root.removeAttribute(name);
    },
    getSnapshot: () => snapshot,
    isBusy: () => coordinator.busy,
  };
}

/** Keeps one injected command factory across run/lobby dispose-and-remount transitions. */
export function mountCampaignApplicationUi(root: HTMLElement, initial: CampaignApplicationUiSnapshot, options: CampaignLobbyMountOptions): CampaignApplicationUiMount {
  let snapshot = initial;
  let currentRevision = initial.revision;
  const sharedFactory = options.createCommand ?? createTestOnlyMonotonicCommandFactory("application-ui:test-only", () => currentRevision);
  const sharedOptions: CampaignUiMountOptions = { ...options, createCommand: sharedFactory };
  let child: CampaignUiMount | CampaignLobbyMount = initial.mode === "run" ? mountCampaignUi(root, initial.ui, sharedOptions) : mountCampaignLobby(root, initial, sharedOptions);
  return {
    update(next): void {
      currentRevision = next.revision;
      if (snapshot.mode === next.mode) {
        if (next.mode === "run") (child as CampaignUiMount).update(next.ui);
        else (child as CampaignLobbyMount).update(next);
      } else {
        child.destroy();
        child = next.mode === "run" ? mountCampaignUi(root, next.ui, sharedOptions) : mountCampaignLobby(root, next, sharedOptions);
      }
      snapshot = next;
    },
    openHomeControls(houseId): void { if (snapshot.mode === 'run') (child as CampaignUiMount).openHomeControls(houseId); },
    closeMenu(): void { if (snapshot.mode === 'run') (child as CampaignUiMount).closeMenu(); },
    isMenuOpen: () => snapshot.mode === 'run' && (child as CampaignUiMount).isMenuOpen(),
    destroy(): void { child.destroy(); },
    getSnapshot: () => snapshot,
    isBusy: () => child.isBusy(),
  };
}
