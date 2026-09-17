import type { CampaignSettings, EffectLevel } from "../campaign-settings";
import { isPaused, isTerminal } from "../campaign-controller";
import { DEVICE_PRICES, type RunUpgradeId } from "../economy";
import { formatNumber } from "../i18n";
import { canonicalById, inventoryItems, inventoryWeight } from "../tool-system";
import { uiText } from "./copy";
import { renderCampaignDisplayOptions } from "./display-options";
import {
  CampaignCommandCoordinator,
  type CampaignUiCommandFactory,
  type CampaignUiCommandHandler,
  type CampaignUiCommandResultLike,
} from "./command-dispatch";
import {
  createUiCommand,
  missionLabel,
  pauseReasonText,
  phaseAnnouncement,
  researchNodeViews,
  resultMetrics,
  resultReason,
  resultTitle,
  toolViews,
  tutorialView,
  upgradeViews,
  type CampaignUiCommand,
  type CampaignUiCommandBody,
  type CampaignUiPanel,
  type CampaignUiSnapshot,
  type CampaignUiTool,
  type StrategyPriority,
} from "./model";

export interface CampaignUiMount {
  openHomeControls(houseId: string): void;
  closeMenu(): void;
  isMenuOpen(): boolean;
  update(snapshot: CampaignUiSnapshot): void;
  destroy(): void;
  getSnapshot(): CampaignUiSnapshot;
  isBusy(): boolean;
}

export interface CampaignUiMountOptions {
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly onHomeAction?: (houseId: string, action: import('../home-interaction').HomeInteractionAction) => import('../home-interaction').HomeInteractionResult | Promise<import('../home-interaction').HomeInteractionResult>;
  readonly onCommand: CampaignUiCommandHandler;
  /** Production callers must inject CampaignApplication.createCommand. The fallback is test compatibility only. */
  readonly createCommand?: CampaignUiCommandFactory;
  readonly onSuccess?: (result: CampaignUiCommandResultLike | undefined, command: CampaignUiCommand) => void | Promise<void>;
  readonly onRefresh?: (result: CampaignUiCommandResultLike | undefined, command: CampaignUiCommand) => void | Promise<void>;
}

export function campaignUiRootAttributes(snapshot: Pick<CampaignUiSnapshot, "settings">): Readonly<Record<string, string>> {
  return Object.freeze({
    lang: snapshot.settings.language,
    "data-ui-scale": String(snapshot.settings.visual.uiScale),
    "data-motion": snapshot.settings.visual.motionEffects,
    "data-flashes": snapshot.settings.visual.flashes,
    "data-stains": snapshot.settings.visual.stains,
    "data-swarm": snapshot.settings.visual.swarmAtmosphere,
  });
}

export function nextRovingIndex(current: number, length: number, key: string): number {
  if (!Number.isInteger(current) || !Number.isInteger(length) || length <= 0 || current < 0 || current >= length) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + length) % length;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % length;
  return current;
}

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function selected(value: string, expected: string): string { return value === expected ? " selected" : ""; }
function checked(value: boolean): string { return value ? " checked" : ""; }
function disabled(value: boolean): string { return value ? " disabled" : ""; }

function pollutionIcon(): string {
  return `<svg class="campaign-ui__metric-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2 3 20h18L12 2Zm0 5.2 4.9 10H7.1l4.9-10Zm-1 3v3.8h2v-3.8h-2Zm0 5.1v2h2v-2h-2Z"/></svg>`;
}

function homeBar(snapshot: CampaignUiSnapshot, compact: boolean): string {
  const locale = snapshot.settings.language;
  return snapshot.run.houses.map(house => {
    const current = Math.max(0, Math.round(house.hp));
    const maximum = Math.max(1, Math.round(house.maxHp));
    const label = uiText(locale, house.id === "home.frog" ? "home.frog" : "home.cleaner");
    const fallen = current === 0;
    const repairDisabled = snapshot.run.phase !== "siege" || fallen || house.repaired || snapshot.run.economy.parts < 25 || house.hp >= house.maxHp;
    const repairReason = house.repaired ? uiText(locale, "home.repairUsed") : snapshot.run.phase !== "siege" ? uiText(locale, "home.repairUnavailable") : uiText(locale, "home.repair");
    const homeUnavailable = fallen || snapshot.run.phase !== 'running' || house.id === 'home.frog' && !snapshot.run.frogUnlocked;
    const actions = (['door', 'props', 'call'] as const).map((action, index) => {
      const text = locale === 'zh-CN' ? ['开 / 关门', '屋内互动', '出来工作'][index] : ['Open / close door', 'Play with room items', 'Come out to work'][index];
      return `<button type="button" data-ui-action="house.interact" data-id="${escapeHtml(house.id)}" data-home-action="${action}" data-focus-key="home:${escapeHtml(house.id)}:${action}"${disabled(homeUnavailable)}>${text}</button>`;
    }).join('');
    return `<article class="campaign-ui__home${fallen ? " is-fallen" : ""}" data-house-id="${escapeHtml(house.id)}">
      <div class="campaign-ui__home-copy"><strong>${escapeHtml(label)}</strong>${compact ? "" : `<span>${escapeHtml(fallen ? uiText(locale, "home.fallen") : uiText(locale, "home.hp", { current, maximum }))}</span>`}</div>
      <progress max="${maximum}" value="${current}" aria-label="${escapeHtml(`${label}: ${uiText(locale, "home.hp", { current, maximum })}`)}"></progress>
      <div class="campaign-ui__home-actions">${actions}</div>
      ${compact ? "" : `<button type="button" data-ui-action="house.repair" data-id="${escapeHtml(house.id)}" data-focus-key="repair:${escapeHtml(house.id)}"${disabled(repairDisabled)}>${escapeHtml(repairReason)}</button>`}
    </article>`;
  }).join("");
}

function ecologySummary(snapshot: CampaignUiSnapshot): string {
  if (snapshot.run.ecology.cycleVersion !== 2) return '';
  const items = Object.values(snapshot.run.inventory.objects).filter(item => item.owner === 'world');
  const count = (stage: string) => items.filter(item => item.kind === 'egg' && stage === 'egg' || item.kind === 'bug' && item.ecology?.stage === stage).length;
  const females = items.filter(item => item.kind === 'bug' && item.ecology?.sex === 'female').length;
  const males = items.filter(item => item.kind === 'bug' && item.ecology?.sex === 'male').length;
  const zh = snapshot.settings.language === 'zh-CN';
  const label = zh ? '持续桌面生态' : 'Continuous desktop ecosystem';
  const stages = zh ? `虫卵 ${count('egg')} → 小虫 ${count('small')} → 中虫 ${count('medium')} → 成年 ${count('adult')}`
    : `Eggs ${count('egg')} → Small ${count('small')} → Medium ${count('medium')} → Adults ${count('adult')}`;
  return `<section class="campaign-ui__ecology" aria-label="${label}"><strong>${label}</strong><p>${stages}</p><p>${zh ? `公虫 ${males} · 母虫 ${females} · 垃圾 ${items.filter(item => item.kind === 'trash').length}` : `Males ${males} · Females ${females} · Trash ${items.filter(item => item.kind === 'trash').length}`}</p><small>${zh ? '及时清走垃圾和虫卵，切断食物与繁殖。' : 'Remove trash and eggs to interrupt feeding and breeding.'}</small></section>`;
}

function toolbar(snapshot: CampaignUiSnapshot): string {
  const locale = snapshot.settings.language;
  const pollution = Math.round(snapshot.run.ecology.pollution);
  const infestation = Math.round(snapshot.run.ecology.density);
  const paused = isPaused(snapshot.run);
  const tools = toolViews(snapshot).map(tool => `<button type="button" class="campaign-ui__tool is-${tool.status}" data-ui-action="tool.equip" data-id="${tool.id}" data-focus-key="tool:${tool.id}" aria-pressed="${tool.pressed}" aria-describedby="tool-status-${tool.id}"${tool.pressed ? " data-ui-safe=\"true\"" : ""}${disabled(tool.status === "blocked") }><span>${escapeHtml(tool.name)}</span><small id="tool-status-${tool.id}">${escapeHtml(tool.detail)}</small></button>`).join("");
  const reasons = snapshot.run.pauseReasons.map(reason => pauseReasonText(locale, reason)).join(", ");
  const scrollButton = (direction: "up" | "down"): string => `<button type="button" data-ui-action="toolbar.scroll-${direction}" data-ui-safe="true" data-focus-key="toolbar:scroll-${direction}" aria-label="${escapeHtml(uiText(locale, direction === "up" ? "toolbar.scrollUp" : "toolbar.scrollDown"))}" title="${escapeHtml(uiText(locale, direction === "up" ? "toolbar.scrollUp" : "toolbar.scrollDown"))}" aria-controls="toolbar-scroll-content">${direction === "up" ? "↑" : "↓"}</button>`;
  return `<header class="campaign-ui__toolbar" role="toolbar" aria-label="${escapeHtml(uiText(locale, "app.label"))}" data-roving-group="toolbar">
    <div class="campaign-ui__toolbar-scroll-controls" data-toolbar-scroll-controls>${scrollButton("up")}${scrollButton("down")}</div>
    <div id="toolbar-scroll-content" class="campaign-ui__toolbar-scroll" data-toolbar-scroll>
    ${ecologySummary(snapshot)}
    <div class="campaign-ui__task"><span>${escapeHtml(uiText(locale, "toolbar.task"))}</span><strong>${escapeHtml(missionLabel(snapshot))}</strong><code>${escapeHtml(snapshot.run.missionId)}</code></div>
    <div class="campaign-ui__metric"><strong>${escapeHtml(uiText(locale, "toolbar.parts", { count: formatNumber(locale, snapshot.run.economy.parts) }))}</strong></div>
    <div class="campaign-ui__metric is-pollution" data-level="${pollution >= 85 ? "danger" : pollution >= 60 ? "warning" : "normal"}">${pollutionIcon()}<strong>${escapeHtml(uiText(locale, "toolbar.pollution", { percent: pollution }))}</strong><progress max="100" value="${Math.max(0, Math.min(100, pollution))}" aria-label="${escapeHtml(uiText(locale, "toolbar.pollution", { percent: pollution }))}"></progress></div>
    <div class="campaign-ui__metric is-infestation" data-level="${infestation >= 65 ? "danger" : infestation >= 40 ? "warning" : "normal"}"><span class="campaign-ui__dot" aria-hidden="true"></span><strong>${escapeHtml(uiText(locale, "toolbar.infestation", { percent: infestation }))}</strong><progress max="100" value="${Math.max(0, Math.min(100, infestation))}" aria-label="${escapeHtml(uiText(locale, "toolbar.infestation", { percent: infestation }))}"></progress></div>
    <div class="campaign-ui__homes-compact" aria-label="${escapeHtml(uiText(locale, "toolbar.homes"))}">${homeBar(snapshot, true)}</div>
    <div class="campaign-ui__toolset" aria-label="${escapeHtml(uiText(locale, "toolbar.tools"))}">${tools}</div>
    <nav class="campaign-ui__nav" aria-label="${escapeHtml(uiText(locale, "app.label"))}">
      <button type="button" data-ui-action="panel.open" data-id="shop" data-focus-key="panel:shop">${escapeHtml(uiText(locale, "toolbar.shop"))}</button>
      <button type="button" data-ui-action="panel.open" data-id="strategy" data-focus-key="panel:strategy">${escapeHtml(uiText(locale, "toolbar.strategy"))}</button>
      <button type="button" data-ui-action="panel.open" data-id="settings" data-focus-key="panel:settings">${escapeHtml(uiText(locale, "toolbar.settings"))}</button>
      <button type="button" data-ui-action="campaign.pause-toggle" data-focus-key="pause" aria-pressed="${paused}">${escapeHtml(uiText(locale, paused ? "toolbar.resume" : "toolbar.pause"))}</button>
    </nav>
    <output class="campaign-ui__pause-status" role="status" aria-live="polite">${paused ? escapeHtml(uiText(locale, "toolbar.pausedBy", { reasons: reasons || uiText(locale, "pause.unknown", { id: "unspecified" }) })) : ""}</output>
    </div>
  </header>`;
}

function phaseBanner(snapshot: CampaignUiSnapshot): string {
  const announcement = phaseAnnouncement(snapshot);
  if (!announcement) return "";
  return `<section class="campaign-ui__phase" role="alert"><div><strong>${escapeHtml(announcement.title)}</strong><p>${escapeHtml(announcement.body)}</p></div><div class="campaign-ui__homes">${homeBar(snapshot, false)}</div></section>`;
}

function panelFrame(snapshot: CampaignUiSnapshot, panel: CampaignUiPanel, body: string): string {
  const locale = snapshot.settings.language;
  const title = uiText(locale, `panel.${panel as Exclude<CampaignUiPanel, "none">}`);
  return `<section class="campaign-ui__panel campaign-ui__panel--${panel}" role="dialog" aria-modal="false" aria-labelledby="campaign-ui-panel-title" tabindex="-1" data-ui-panel="${panel}">
    <header><h2 id="campaign-ui-panel-title">${escapeHtml(title)}</h2><button type="button" class="campaign-ui__close" data-ui-action="panel.close" data-ui-safe="true" data-focus-key="panel:close" aria-label="${escapeHtml(uiText(locale, "panel.close"))}">×</button></header>
    ${body}
  </section>`;
}

function shopPanel(snapshot: CampaignUiSnapshot): string {
  const locale = snapshot.settings.language;
  const upgrades = upgradeViews(snapshot).map(item => {
    const detail = !item.available ? uiText(locale, "upgrade.unavailable") : item.next === null ? uiText(locale, "shop.max") : uiText(locale, "shop.currentNext", { current: item.current, next: item.next });
    const button = !item.available ? uiText(locale, "feature.unavailable") : item.cost === null ? uiText(locale, "shop.max") : item.affordable ? uiText(locale, "shop.buy", { cost: item.cost }) : uiText(locale, "shop.cannotAfford", { cost: item.cost });
    return `<article class="campaign-ui__card" data-resource-id="${item.id}"><header><h3>${escapeHtml(item.name)}</h3><code>${item.id}</code></header><p>${escapeHtml(uiText(locale, "shop.level", { level: item.level }))}</p><p>${escapeHtml(detail)}</p><button type="button" data-ui-action="upgrade.purchase" data-id="${item.id}" data-focus-key="upgrade:${item.id}"${disabled(item.cost === null || !item.affordable)}>${escapeHtml(button)}</button></article>`;
  }).join("");
  const deviceNames: Readonly<Record<keyof typeof DEVICE_PRICES, "device.bait" | "device.glue" | "device.catcher" | "device.ladder">> = { bait: "device.bait", glue: "device.glue", catcher: "device.catcher", gridDoor: "device.catcher", ladder: "device.ladder", bouncePad: "device.ladder", repairPack: "device.ladder" };
  const demoDevices = (["bait", "glue", "catcher", "ladder"] as const).map(id => `<article class="campaign-ui__card" data-resource-id="${id}"><header><h3>${escapeHtml(uiText(locale, deviceNames[id]))}</h3><code>${id}</code></header><button type="button" data-ui-action="device.place" data-id="${id}" data-focus-key="device:${id}"${disabled(snapshot.run.economy.parts < DEVICE_PRICES[id])}>${escapeHtml(uiText(locale, "shop.place", { cost: DEVICE_PRICES[id] }))}</button></article>`).join("");
  return panelFrame(snapshot, "shop", `<p class="campaign-ui__balance">${escapeHtml(uiText(locale, "shop.balance", { count: formatNumber(locale, snapshot.run.economy.parts) }))}</p><h3>${escapeHtml(uiText(locale, "shop.upgrades"))}</h3><div class="campaign-ui__grid">${upgrades}</div><h3>${escapeHtml(uiText(locale, "shop.devices"))}</h3><div class="campaign-ui__grid campaign-ui__grid--devices">${demoDevices}</div>`);
}

function researchPanel(snapshot: CampaignUiSnapshot): string {
  const locale = snapshot.settings.language;
  const nodes = researchNodeViews(snapshot).map(node => {
    const stateLabel = node.state === "owned" ? uiText(locale, "research.owned") : node.state === "prerequisite" ? uiText(locale, "research.locked", { id: node.prerequisite ?? "" }) : node.state === "demo-locked" ? uiText(locale, "research.demoLocked") : uiText(locale, "research.buy", { cost: node.cost });
    return `<article class="campaign-ui__card is-${node.state}" data-resource-id="${escapeHtml(node.id)}"><header><h3>${escapeHtml(node.branchName)} · ${node.tier}</h3><code>${escapeHtml(node.id)}</code></header><p>${escapeHtml(node.effect)}</p><button type="button" data-ui-action="research.purchase" data-id="${escapeHtml(node.id)}" data-focus-key="research:${escapeHtml(node.id)}"${disabled(node.state !== "available")}>${escapeHtml(stateLabel)}</button></article>`;
  }).join("");
  return panelFrame(snapshot, "research", `<div class="campaign-ui__panel-actions"><strong>${escapeHtml(uiText(locale, "research.balance", { count: formatNumber(locale, snapshot.meta.researchPoints) }))}</strong><button type="button" data-ui-action="research.reset" data-focus-key="research:reset"${disabled(snapshot.meta.nodes.length === 0)}>${escapeHtml(uiText(locale, "research.freeRespec"))}</button></div><div class="campaign-ui__grid">${nodes}</div>`);
}

function strategyPanel(snapshot: CampaignUiSnapshot): string {
  const locale = snapshot.settings.language;
  const priorities = (["clean", "nearHome", "elite", "maintenance"] as const);
  const actors = snapshot.run.actors.map(actor => {
    const inventory = snapshot.run.inventory.containers[actor.inventoryId];
    const used = inventoryWeight(snapshot.run.inventory, actor.inventoryId);
    const savedPriority = snapshot.ui.strategyByActor[actor.id] ?? (actor.archetype === "cleaner" ? "clean" : "nearHome");
    const priority = savedPriority === "elite" || savedPriority === "maintenance" ? "clean" : savedPriority;
    return `<article class="campaign-ui__card campaign-ui__actor" data-resource-id="${escapeHtml(actor.id)}"><header><h3>${escapeHtml(uiText(locale, actor.archetype === "frog" ? "strategy.frog" : "strategy.cleaner"))}</h3><code>${escapeHtml(actor.id)}</code></header><p>${escapeHtml(uiText(locale, "strategy.stamina", { value: Math.round(actor.pose.stamina) }))}</p><p>${escapeHtml(uiText(locale, "strategy.inventory", { used: formatNumber(locale, used), capacity: formatNumber(locale, inventory?.capacity ?? 0) }))}</p><label>${escapeHtml(uiText(locale, "strategy.priority"))}<select aria-describedby="strategy-unavailable" data-ui-action="strategy.set" data-id="${escapeHtml(actor.id)}" data-focus-key="strategy:${escapeHtml(actor.id)}">${priorities.map(value => `<option value="${value}"${selected(value, priority)}${disabled(value === "elite" || value === "maintenance")}>${escapeHtml(uiText(locale, `priority.${value}`))}${value === "elite" || value === "maintenance" ? ` · ${escapeHtml(uiText(locale, "feature.unavailable"))}` : ""}</option>`).join("")}</select></label></article>`;
  }).join("");
  return panelFrame(snapshot, "strategy", `<p>${escapeHtml(uiText(locale, "strategy.help"))}</p><p id="strategy-unavailable">${escapeHtml(uiText(locale, "strategy.unavailable"))}</p><div class="campaign-ui__grid campaign-ui__grid--actors">${actors}</div>`);
}

function options(locale: CampaignUiSnapshot["settings"]["language"], values: readonly string[], current: string, prefix = "option"): string {
  return values.map(value => `<option value="${escapeHtml(value)}"${selected(value, current)}>${escapeHtml(prefix === "option" ? uiText(locale, `option.${value as "low" | "medium" | "high" | "gentle" | "standard" | "intense" | "desktop" | "practice" | EffectLevel}`) : value)}</option>`).join("");
}

function settingSelect(label: string, path: string, choices: string): string {
  return `<label>${escapeHtml(label)}<select data-ui-action="settings.update" data-path="${escapeHtml(path)}" data-focus-key="settings:${escapeHtml(path)}">${choices}</select></label>`;
}

function settingRange(label: string, path: keyof CampaignSettings["audio"], value: number): string {
  return `<label>${escapeHtml(label)}<span><input type="range" min="0" max="1" step="0.05" value="${value}" data-ui-action="settings.update" data-path="audio.${path}" data-value-type="number" data-focus-key="settings:audio.${path}"><output>${Math.round(value * 100)}%</output></span></label>`;
}

function settingsPanel(snapshot: CampaignUiSnapshot): string {
  const locale = snapshot.settings.language;
  const settings = snapshot.settings;
  const languages = `<option value="zh-CN"${selected("zh-CN", locale)}>简体中文</option><option value="en"${selected("en", locale)}>English</option>`;
  const scales = ([1, 1.5, 2] as const).map(scale => `<option value="${scale}"${selected(String(scale), String(settings.visual.uiScale))}>${scale * 100}%</option>`).join("");
  const displays = renderCampaignDisplayOptions(locale, settings.gameplay.displayId, snapshot.availableDisplays);
  const effectOptions = (current: EffectLevel): string => options(locale, ["off", "reduced", "full"], current);
  const checkbox = (label: string, path: string, value: boolean): string => `<label class="campaign-ui__check"><input type="checkbox" data-ui-action="settings.update" data-path="${escapeHtml(path)}" data-value-type="boolean" data-focus-key="settings:${escapeHtml(path)}"${checked(value)}>${escapeHtml(label)}</label>`;
  return panelFrame(snapshot, "settings", `<div class="campaign-ui__settings-grid">
    <fieldset><legend>${escapeHtml(uiText(locale, "panel.settings"))}</legend>${settingSelect(uiText(locale, "settings.language"), "language", languages)}${settingSelect(uiText(locale, "settings.uiScale"), "visual.uiScale", scales)}${settingSelect(uiText(locale, "settings.quality"), "visual.quality", options(locale, ["low", "medium", "high"], settings.visual.quality))}${settingSelect(uiText(locale, "settings.intensity"), "gameplay.intensity", options(locale, ["gentle", "standard", "intense"], settings.gameplay.intensity))}${settingSelect(uiText(locale, "settings.detection"), "gameplay.detectionMode", options(locale, ["desktop", "practice"], settings.gameplay.detectionMode))}${settingSelect(uiText(locale, "settings.display"), "gameplay.displayId", displays)}</fieldset>
    <fieldset><legend>${escapeHtml(uiText(locale, "settings.audio"))}</legend>${settingRange(uiText(locale, "settings.master"), "master", settings.audio.master)}${settingRange(uiText(locale, "settings.music"), "music", settings.audio.music)}${settingRange(uiText(locale, "settings.effects"), "effects", settings.audio.effects)}${settingRange(uiText(locale, "settings.alerts"), "alerts", settings.audio.alerts)}<p class="campaign-ui__note">${escapeHtml(uiText(locale, "settings.visualAlerts"))}</p></fieldset>
    <fieldset><legend>${escapeHtml(uiText(locale, "settings.visual"))}</legend>${settingSelect(uiText(locale, "settings.motion"), "visual.motionEffects", effectOptions(settings.visual.motionEffects))}${settingSelect(uiText(locale, "settings.flashes"), "visual.flashes", effectOptions(settings.visual.flashes))}${settingSelect(uiText(locale, "settings.stains"), "visual.stains", effectOptions(settings.visual.stains))}${settingSelect(uiText(locale, "settings.swarm"), "visual.swarmAtmosphere", effectOptions(settings.visual.swarmAtmosphere))}${checkbox(uiText(locale, "settings.tutorial"), "gameplay.tutorialPrompts", settings.gameplay.tutorialPrompts)}${checkbox(uiText(locale, "settings.panelPause"), "gameplay.pauseWhenPanelOpen", settings.gameplay.pauseWhenPanelOpen)}${checkbox(uiText(locale, "settings.diagnostics"), "diagnosticsConsent", settings.diagnosticsConsent)}</fieldset>
  </div>`);
}

function resultPanel(snapshot: CampaignUiSnapshot): string {
  const locale = snapshot.settings.language;
  const metrics = resultMetrics(snapshot).map(metric => `<div><dt>${escapeHtml(metric.label)}</dt><dd>${escapeHtml(metric.value)}</dd></div>`).join("");
  return panelFrame(snapshot, "result", `<div class="campaign-ui__result"><h3>${escapeHtml(resultTitle(locale, snapshot.run.phase))}</h3><p role="status">${escapeHtml(uiText(locale, "result.reason", { reason: resultReason(snapshot) }))}</p><dl>${metrics}</dl><div class="campaign-ui__panel-actions"><button type="button" data-ui-action="result.retry" data-focus-key="result:retry">${escapeHtml(uiText(locale, "result.retry"))}</button><button type="button" data-ui-action="result.continue" data-focus-key="result:continue">${escapeHtml(uiText(locale, "result.continue"))}</button><button type="button" data-ui-action="panel.open" data-id="research" data-focus-key="panel:research">${escapeHtml(uiText(locale, "panel.research"))}</button></div></div>`);
}

function visiblePanel(snapshot: CampaignUiSnapshot): CampaignUiPanel {
  const implicitResult = isTerminal(snapshot.run) && snapshot.ui.dismissedResultRunId !== snapshot.run.runId;
  return snapshot.ui.panel === "none" && implicitResult ? "result" : snapshot.ui.panel;
}

function activePanel(snapshot: CampaignUiSnapshot): string {
  const panel = visiblePanel(snapshot);
  if (panel === "shop") return shopPanel(snapshot);
  if (panel === "research") return researchPanel(snapshot);
  if (panel === "strategy") return strategyPanel(snapshot);
  if (panel === "settings") return settingsPanel(snapshot);
  if (panel === "result") return resultPanel(snapshot);
  return "";
}

function tutorialPrompt(snapshot: CampaignUiSnapshot): string {
  const view = tutorialView(snapshot);
  if (!view) return "";
  const locale = snapshot.settings.language;
  return `<aside class="campaign-ui__tutorial" role="${view.blocking ? "alertdialog" : "status"}" aria-labelledby="campaign-ui-tutorial-title" aria-describedby="campaign-ui-tutorial-message"${view.blocking ? " tabindex=\"-1\" data-ui-prompt" : ""}><h2 id="campaign-ui-tutorial-title">${escapeHtml(uiText(locale, "tutorial.title"))}</h2><p class="campaign-ui__eyebrow">${escapeHtml(uiText(locale, "tutorial.step", { current: view.current, total: view.total }))}</p><p id="campaign-ui-tutorial-message">${escapeHtml(view.message)}</p><div class="campaign-ui__panel-actions">${view.blocking ? `<button type="button" data-ui-action="tutorial.dismiss" data-focus-key="tutorial:dismiss">${escapeHtml(uiText(locale, "tutorial.dismiss"))}</button>` : ""}<button type="button" data-ui-action="tutorial.skip-step" data-focus-key="tutorial:skip-step">${escapeHtml(uiText(locale, "tutorial.skipStep"))}</button><button type="button" data-ui-action="tutorial.skip-all" data-focus-key="tutorial:skip-all">${escapeHtml(uiText(locale, "tutorial.skipAll"))}</button></div></aside>`;
}

/** A nonmodal tool surface: opening it never requests a panel pause. */
function deviceManagement(snapshot: CampaignUiSnapshot): string {
  if (snapshot.ui.equippedTool !== "trap" || visiblePanel(snapshot) !== "none" || isTerminal(snapshot.run)) return "";
  const locale = snapshot.settings.language;
  const frozen = isPaused(snapshot.run) || snapshot.run.phase === "preparation";
  const devices = canonicalById(snapshot.run.traps).map((trap, index) => {
    const contents = inventoryItems(snapshot.run.inventory, trap.id);
    const fraction = trap.kind === "bait" ? trap.remaining / 60 : trap.kind === "glue" ? trap.uses / 12 : trap.kind === "catcher" ? Math.max(0, 1 - trap.uses / 6) : 1;
    const name = `${uiText(locale, `device.${trap.kind}`)} · ${index + 1}`;
    const helpId = `device-help-${index}`;
    const action = (type: "maintain" | "remove", label: string, unavailable: boolean): string => `<button type="button" data-ui-action="device.${type}" data-id="${escapeHtml(trap.id)}" data-focus-key="device:${type}:${escapeHtml(trap.id)}" aria-label="${escapeHtml(`${label} · ${name}`)}" aria-describedby="${helpId}"${disabled(unavailable)}>${escapeHtml(label)}</button>`;
    const capacity = trap.kind === "catcher" ? `<p>${escapeHtml(uiText(locale, "device.capacity", { used: contents.length, capacity: snapshot.run.inventory.containers[trap.id]?.capacity ?? 0, count: contents.length }))}</p>` : "";
    return `<article class="campaign-ui__card" data-resource-id="${escapeHtml(trap.id)}"><h3>${escapeHtml(name)}</h3>${capacity}<p>${escapeHtml(uiText(locale, "device.life", { value: Math.floor(fraction * 100) }))}</p><p>${escapeHtml(uiText(locale, "device.refund", { value: Math.floor(trap.paid * fraction * 0.5) }))}</p><p id="${helpId}">${escapeHtml(trap.kind === "catcher" ? uiText(locale, contents.length ? "device.nonempty" : "device.cleanup") : uiText(locale, "device.remove"))}</p><div class="campaign-ui__panel-actions">${trap.kind === "catcher" ? action("maintain", uiText(locale, "device.maintain"), frozen || contents.length === 0) : ""}${action("remove", uiText(locale, "device.remove"), snapshot.run.phase === "preparation" || contents.length > 0)}</div></article>`;
  }).join("");
  const scrollButton = (direction: "up" | "down"): string => `<button type="button" data-ui-action="device.scroll-${direction}" data-ui-safe="true" data-focus-key="device:scroll-${direction}" aria-label="${escapeHtml(uiText(locale, direction === "up" ? "device.scrollUp" : "device.scrollDown"))}" title="${escapeHtml(uiText(locale, direction === "up" ? "device.scrollUp" : "device.scrollDown"))}" aria-controls="device-scroll-content">${direction === "up" ? "↑" : "↓"}</button>`;
  return `<section class="campaign-ui__devices" role="region" aria-labelledby="device-management-title" data-roving-group="devices"><header><h2 id="device-management-title">${escapeHtml(uiText(locale, "device.manage"))}</h2><span data-device-scroll-controls>${scrollButton("up")}${scrollButton("down")}</span></header><div id="device-scroll-content" data-device-scroll><p>${escapeHtml(uiText(locale, "device.live"))} ${escapeHtml(uiText(locale, "device.cleanup"))}</p><div class="campaign-ui__grid">${devices || `<p>${escapeHtml(uiText(locale, "device.empty"))}</p>`}</div></div></section>`;
}

type ManagedScrollArea = "device" | "toolbar" | "menu";

function scrollSelectors(area: ManagedScrollArea): Readonly<{ content: string; controls: string; up: string; down: string }> {
  return area === "menu"
    ? { content: "[data-menu-scroll]", controls: "[data-menu-scroll-controls]", up: '[data-ui-action="menu.scroll-up"]', down: '[data-ui-action="menu.scroll-down"]' }
    : area === "device"
    ? { content: "[data-device-scroll]", controls: "[data-device-scroll-controls]", up: '[data-ui-action="device.scroll-up"]', down: '[data-ui-action="device.scroll-down"]' }
    : { content: "[data-toolbar-scroll]", controls: "[data-toolbar-scroll-controls]", up: '[data-ui-action="toolbar.scroll-up"]', down: '[data-ui-action="toolbar.scroll-down"]' };
}

function syncScrollControls(root: ParentNode, area: ManagedScrollArea): void {
  const selectors = scrollSelectors(area);
  const content = root.querySelector<HTMLElement>(selectors.content);
  if (!content) return;
  const maximum = Math.max(0, content.scrollHeight - content.clientHeight);
  content.scrollTop = Math.max(0, Math.min(maximum, content.scrollTop));
  const controls = root.querySelector<HTMLElement>(selectors.controls);
  if (controls) controls.hidden = maximum <= 0;
  const up = root.querySelector<HTMLButtonElement>(selectors.up);
  const down = root.querySelector<HTMLButtonElement>(selectors.down);
  if (up) up.disabled = maximum <= 0 || content.scrollTop <= 0;
  if (down) down.disabled = maximum <= 0 || content.scrollTop >= maximum;
}

/** Native non-focusable overlays receive button clicks, not DOM wheel input. */
function scrollManagedList(root: ParentNode, area: ManagedScrollArea, direction: "up" | "down"): void {
  const content = root.querySelector<HTMLElement>(scrollSelectors(area).content);
  if (!content) return;
  const distance = Math.max(44, content.clientHeight * 0.75) * (direction === "up" ? -1 : 1);
  content.scrollTop = Math.max(0, Math.min(Math.max(0, content.scrollHeight - content.clientHeight), content.scrollTop + distance));
  syncScrollControls(root, area);
}

export function scrollDeviceList(root: ParentNode, direction: "up" | "down"): void { scrollManagedList(root, "device", direction); }
export function scrollToolbar(root: ParentNode, direction: "up" | "down"): void { scrollManagedList(root, "toolbar", direction); }
export function scrollMenu(root: ParentNode, direction: "up" | "down"): void { scrollManagedList(root, "menu", direction); }

export function commandFailureText(locale: CampaignUiSnapshot["settings"]["language"], reason: string): string {
  const known: Readonly<Record<string, Parameters<typeof uiText>[1]>> = {
    "maintenance-required": "device.nonempty", "missing-trap": "error.missingTrap", "invalid-trap-id": "error.invalidTrap",
    empty: "error.emptyTrap", "domain:empty": "error.emptyTrap", "campaign-frozen": "error.blockedDevice", "refund-unavailable": "error.refund",
    "strategy-unavailable": "strategy.unavailable", "upgrade-unavailable": "feature.unavailable",
    "stale-revision": "error.changed", "command-id-conflict": "error.conflict", "domain:command-conflict": "error.conflict",
    "domain:transaction-failed": "error.operation", "dispatch-failed": "error.operation",
  };
  return known[reason] ? uiText(locale, known[reason]) : uiText(locale, "feedback.failure", { reason });
}

export function renderCampaignUi(snapshot: CampaignUiSnapshot, dockOpen = false): string {
  const chinese = snapshot.settings.language === "zh-CN";
  const triggerLabel = dockOpen
    ? (chinese ? "收起菜单" : "Collapse menu")
    : (chinese ? "打开菜单" : "Open menu");
  const menuTitle = chinese ? "作战控制台" : "Mission control";
  const scrollHint = chinese ? "滚动查看更多" : "Scroll to explore";
  const closeLabel = chinese ? "关闭菜单" : "Close menu";
  const scrollButton = (direction: "up" | "down"): string => `<button type="button" data-ui-action="menu.scroll-${direction}" data-ui-safe="true" data-focus-key="menu:scroll-${direction}" aria-controls="menu-scroll-content" aria-label="${chinese ? (direction === "up" ? "菜单向上滚动" : "菜单向下滚动") : (direction === "up" ? "Scroll menu up" : "Scroll menu down")}">${direction === "up" ? "↑" : "↓"}</button>`;
  return `<button type="button" class="campaign-ui__dock-trigger" data-ui-action="dock.toggle" data-ui-safe="true" data-focus-key="dock:toggle" aria-controls="campaign-ui-dock" aria-expanded="${dockOpen}" aria-label="${triggerLabel}" title="${triggerLabel}"><span>${chinese ? "菜单" : "Menu"}</span></button>
  <aside id="campaign-ui-dock" class="campaign-ui__dock" role="dialog" aria-modal="${dockOpen}" aria-label="${menuTitle}" aria-hidden="${!dockOpen}"${dockOpen ? " data-native-input-modal" : " inert"}>
    <div class="campaign-ui__dock-shell">
      <header class="campaign-ui__dock-head"><div class="campaign-ui__dock-identity"><span class="campaign-ui__dock-kicker">DESKTOP CREATURES / CONTROL</span><h1>${menuTitle}</h1><p>${scrollHint}</p></div><div class="campaign-ui__dock-actions"><div class="campaign-ui__menu-scroll-controls" data-menu-scroll-controls>${scrollButton("up")}${scrollButton("down")}</div><button type="button" class="campaign-ui__dock-close" data-ui-action="dock.toggle" data-ui-safe="true" data-focus-key="dock:close" aria-label="${closeLabel}">×</button></div></header>
      <div id="menu-scroll-content" class="campaign-ui__dock-scroll" data-menu-scroll tabindex="0">
        ${toolbar(snapshot)}<main class="campaign-ui__layer">${phaseBanner(snapshot)}${activePanel(snapshot)}${deviceManagement(snapshot)}${tutorialPrompt(snapshot)}<output class="campaign-ui__announcer campaign-ui__feedback" aria-live="polite" aria-atomic="true"></output></main>
      </div>
    </div>
  </aside>`;
}

function commandBody(action: string, id: string): CampaignUiCommandBody | null {
  if (action === "panel.open" && ["shop", "research", "strategy", "result", "settings"].includes(id)) return { type: "panel.open", panel: id as Exclude<CampaignUiPanel, "none"> };
  if (action === "panel.close") return { type: "panel.close" };
  if (action === "campaign.pause-toggle") return { type: "campaign.pause-toggle" };
  if (action === "tool.equip" && ["bag", "swatter", "trap"].includes(id)) return { type: "tool.equip", tool: id as CampaignUiTool };
  if (action === "upgrade.purchase" && id in ({ cleanerClean: 1, cleanerMove: 1, cleanerCapacity: 1, frogTongue: 1, frogAttack: 1, frogDigestion: 1, frogBatch: 1, frogCapacity: 1, bagCapacity: 1, bagEfficiency: 1, swatDamage: 1, swatHeat: 1, trapMaintenance: 1, homeArmor: 1 })) return { type: "upgrade.purchase", upgradeId: id as RunUpgradeId };
  if (action === "device.place" && id in DEVICE_PRICES) return { type: "device.place", deviceId: id as keyof typeof DEVICE_PRICES };
  if ((action === "device.maintain" || action === "device.remove") && id) return { type: action, trapId: id };
  if (action === "research.purchase" && id) return { type: "research.purchase", nodeId: id };
  if (action === "research.reset") return { type: "research.reset" };
  if (action === "house.repair" && id) return { type: "house.repair", houseId: id };
  if (action === "result.retry") return { type: "result.retry" };
  if (action === "result.continue") return { type: "result.continue" };
  if (action === "tutorial.dismiss" || action === "tutorial.skip-step" || action === "tutorial.skip-all") return { type: action };
  return null;
}

/** Keep native hit handles attached to the same element across snapshot refreshes.
 * Keys describe control/section identity; removed controls are still disconnected so
 * queued native gestures fail the existing input adapter's safety checks. */
function syncCampaignUiDom(parent: Node, desired: Node): void {
  const key = (node: Node): string | null => {
    if (node.nodeType !== 1) return null;
    const element = node as Element;
    for (const name of ["data-focus-key", "id", "data-resource-id", "data-house-id", "data-ui-panel"]) {
      const value = element.getAttribute(name);
      if (value !== null) return `${name}:${value}`;
    }
    return null;
  };
  const compatible = (node: Node, next: Node): boolean => node.nodeType === next.nodeType
    && (node.nodeType !== 1 || (node as Element).tagName === (next as Element).tagName)
    && key(node) === key(next);
  const previous = [...parent.childNodes];
  const retained = new Set<Node>();
  let cursor = parent.firstChild;
  for (const next of [...desired.childNodes]) {
    const nextKey = key(next);
    const current = nextKey !== null
      ? previous.find(node => !retained.has(node) && compatible(node, next))
      : cursor && !retained.has(cursor) && compatible(cursor, next) ? cursor : undefined;
    if (!current) {
      parent.insertBefore(next, cursor);
      retained.add(next);
      continue;
    }
    retained.add(current);
    if (current !== cursor) parent.insertBefore(current, cursor);
    if (current.nodeType === 1) {
      const element = current as Element, template = next as Element;
      const selectValue = template instanceof HTMLSelectElement ? template.value : undefined;
      for (const attribute of [...element.attributes]) if (!template.hasAttribute(attribute.name)) element.removeAttribute(attribute.name);
      for (const attribute of [...template.attributes]) if (element.getAttribute(attribute.name) !== attribute.value) element.setAttribute(attribute.name, attribute.value);
      syncCampaignUiDom(current, next);
      // Attributes alone do not reset dirty native form-control properties.
      if (element instanceof HTMLInputElement && template instanceof HTMLInputElement) {
        if (element.value !== template.value) element.value = template.value;
        element.checked = template.checked;
      } else if (element instanceof HTMLOptionElement && template instanceof HTMLOptionElement) element.selected = template.selected;
      else if (element instanceof HTMLSelectElement && selectValue !== undefined && element.value !== selectValue) element.value = selectValue;
    } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    cursor = current.nextSibling;
  }
  for (const node of previous) if (!retained.has(node)) parent.removeChild(node);
}

/** Mounts event delegation only. Domain state changes occur exclusively in onCommand's owner. */
export function mountCampaignUi(root: HTMLElement, initial: CampaignUiSnapshot, options: CampaignUiMountOptions): CampaignUiMount {
  let snapshot = initial;
  let dockOpen = false;
  let sequence = 0;
  let destroyed = false;
  let homeBusy = false;
  const scrollTop: Record<ManagedScrollArea, number> = { device: 0, toolbar: 0, menu: 0 };
  let feedback: { kind: "busy" | "success" | "error"; message: () => string } | null = null;
  const setBusy = (busy: boolean): void => {
    if (destroyed) return;
    root.setAttribute("aria-busy", String(busy));
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("button, select, input")) {
      const safe = control.dataset.uiSafe === "true";
      if (busy && !safe && !control.disabled) { control.disabled = true; control.dataset.uiBusyDisabled = "true"; }
      else if (!busy && control.dataset.uiBusyDisabled === "true") { control.disabled = false; delete control.dataset.uiBusyDisabled; }
    }
  };
  const setFeedback = (kind: "busy" | "success" | "error", message: () => string): void => {
    if (destroyed) return;
    feedback = { kind, message };
    const output = root.querySelector<HTMLOutputElement>(".campaign-ui__announcer");
    if (!output) return;
    output.dataset.kind = kind;
    output.textContent = message();
  };
  const factory = options.createCommand ?? ((body: CampaignUiCommandBody) => createUiCommand(snapshot, ++sequence, body));
  const coordinator = new CampaignCommandCoordinator({
    createCommand: factory,
    onCommand: options.onCommand,
    onBusyChange: busy => { setBusy(busy || homeBusy); if (busy) setFeedback("busy", () => uiText(snapshot.settings.language, "feedback.busy")); },
    onFailure: reason => setFeedback("error", () => commandFailureText(snapshot.settings.language, reason)),
    onSuccess: async (result, command) => {
      setFeedback("success", () => uiText(snapshot.settings.language, command.type === "device.maintain" ? "device.maintained" : command.type === "device.remove" ? "device.removed" : "feedback.success"));
      await options.onSuccess?.(result, command);
    },
    onRefresh: options.onRefresh,
  });
  const emit = (body: CampaignUiCommandBody): void => { if (!homeBusy) void coordinator.submit(body); };
  const render = (focusKey?: string, focusPanel = false): void => {
    for (const area of ["device", "toolbar", "menu"] as const) {
      const content = root.querySelector<HTMLElement>(scrollSelectors(area).content);
      if (content) scrollTop[area] = content.scrollTop;
    }
    root.className = "campaign-ui";
    root.setAttribute("data-dock-open", String(dockOpen));
    for (const [name, value] of Object.entries(campaignUiRootAttributes(snapshot))) root.setAttribute(name, value);
    const template = root.ownerDocument.createElement("template");
    template.innerHTML = renderCampaignUi(snapshot, dockOpen);
    syncCampaignUiDom(root, template.content);
    for (const area of ["device", "toolbar", "menu"] as const) {
      const content = root.querySelector<HTMLElement>(scrollSelectors(area).content);
      if (content) content.scrollTop = scrollTop[area];
      syncScrollControls(root, area);
    }
    setBusy(coordinator.busy || homeBusy);
    if (feedback) setFeedback(feedback.kind, feedback.message);
    const target = focusPanel ? root.querySelector<HTMLElement>("[data-ui-panel]") : focusKey ? root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`) : null;
    target?.focus();
  };
  const setMenuOpen = (open: boolean, focusKey: string): void => {
    if (dockOpen === open) return;
    dockOpen = open;
    scrollTop.menu = 0;
    render(focusKey);
    options.onMenuOpenChange?.(open);
  };
  const onClick = (event: Event): void => {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-ui-action]");
    if (!target || !root.contains(target) || target instanceof HTMLButtonElement && target.disabled) return;
    const action = target.dataset.uiAction ?? "";
    const id = target.dataset.id ?? "";
    if (action === 'house.interact') {
      const homeAction = target.dataset.homeAction;
      if (!options.onHomeAction || homeBusy || coordinator.busy || !['door', 'props', 'call'].includes(homeAction ?? '')) return;
      const runId = snapshot.run.runId;
      homeBusy = true; setBusy(true);
      void Promise.resolve().then(() => options.onHomeAction!(id, homeAction as import('../home-interaction').HomeInteractionAction)).then(result => {
        if (!destroyed && snapshot.run.runId === runId) setFeedback(result.ok ? 'success' : 'error', () => result.message);
      }, () => { if (!destroyed && snapshot.run.runId === runId) setFeedback('error', () => commandFailureText(snapshot.settings.language, 'dispatch-failed')); })
        .finally(() => { homeBusy = false; if (!destroyed) setBusy(coordinator.busy); });
      return;
    }
    if (action === "dock.toggle") {
      setMenuOpen(!dockOpen, dockOpen ? "dock:toggle" : "dock:close");
      return;
    }
    if (action === "menu.scroll-up" || action === "menu.scroll-down") { scrollMenu(root, action === "menu.scroll-up" ? "up" : "down"); return; }
    if (action === "device.scroll-up" || action === "device.scroll-down") { scrollDeviceList(root, action === "device.scroll-up" ? "up" : "down"); return; }
    if (action === "toolbar.scroll-up" || action === "toolbar.scroll-down") { scrollToolbar(root, action === "toolbar.scroll-up" ? "up" : "down"); return; }
    if (action === "tool.equip" && snapshot.ui.equippedTool === id) { emit({ type: "tool.equip", tool: null }); return; }
    const body = commandBody(action, id);
    if (body) emit(body);
  };
  const onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || !root.contains(target)) return;
    const action = target.dataset.uiAction;
    if (action === "strategy.set") {
      const priority = target.value as StrategyPriority;
      if (target.dataset.id && ["clean", "nearHome"].includes(priority)) emit({ type: "strategy.set", actorId: target.dataset.id, priority });
      return;
    }
    if (action !== "settings.update" || !target.dataset.path) return;
    const value = target.dataset.valueType === "boolean" && target instanceof HTMLInputElement ? target.checked : target.dataset.valueType === "number" ? Number(target.value) : target.value;
    emit({ type: "settings.update", path: target.dataset.path, value });
  };
  const onScroll = (event: Event): void => {
    if (event.target === root.querySelector("[data-menu-scroll]")) syncScrollControls(root, "menu");
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && dockOpen) {
      setMenuOpen(false, "dock:toggle");
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      if (snapshot.ui.equippedTool) emit({ type: "tool.equip", tool: null });
      else if (visiblePanel(snapshot) !== "none") emit({ type: "panel.close" });
      else return;
      event.preventDefault();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const active = event.target as HTMLElement;
    const group = active.closest<HTMLElement>("[data-roving-group]");
    if (!group) return;
    const controls = [...group.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled), input:not(:disabled)")];
    const current = controls.indexOf(active);
    if (current < 0 || controls.length < 2) return;
    const next = nextRovingIndex(current, controls.length, event.key);
    controls[next].focus();
    event.preventDefault();
  };
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("scroll", onScroll, true);
  root.addEventListener("keydown", onKeyDown);
  render();
  return {
    openHomeControls(houseId): void {
      if (destroyed || !snapshot.run.houses.some(house => house.id === houseId)) return;
      if (!dockOpen) setMenuOpen(true, `home:${houseId}:door`);
      else render(`home:${houseId}:door`);
    },
    closeMenu(): void { if (!destroyed) setMenuOpen(false, "dock:toggle"); },
    isMenuOpen: () => dockOpen,
    update(next): void {
      const active = root.ownerDocument.activeElement as HTMLElement | null;
      const focusKey = active?.dataset.focusKey;
      const focusPanel = snapshot.ui.panel !== next.ui.panel && next.ui.panel !== "none";
      snapshot = next;
      render(focusKey, focusPanel);
    },
    destroy(): void {
      destroyed = true;
      if (dockOpen) options.onMenuOpenChange?.(false);
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      root.removeEventListener("scroll", onScroll, true);
      root.removeEventListener("keydown", onKeyDown);
      root.replaceChildren();
      root.removeAttribute("class");
      for (const name of Object.keys(campaignUiRootAttributes(snapshot))) root.removeAttribute(name);
    },
    getSnapshot: () => snapshot,
    isBusy: () => coordinator.busy || homeBusy,
  };
}
