import type { CampaignSettings } from "../campaign-settings";
import { isPaused, isTerminal, type CampaignPhase, type RunState } from "../campaign-controller";
import {
  BASE_RUN_ATTRIBUTES,
  DEVICE_PRICES,
  RUN_UPGRADES,
  deriveRunAttributes,
  effectiveScore,
  runUpgradeCost,
  type RunAttributes,
  type RunUpgradeId,
} from "../economy";
import { formatNumber, translate, type Locale } from "../i18n";
import { RESEARCH_NODES, type MetaProgress, type ResearchBranch, type ResearchSettlement } from "../research";
import { inventoryWeight } from "../tool-system";
import { TUTORIAL_STEPS, tutorialMessageKey, type TutorialState } from "../tutorial";
import { uiText } from "./copy";

export type CampaignUiPanel = "none" | "shop" | "research" | "strategy" | "result" | "settings";
export type CampaignUiTool = "bag" | "swatter" | "trap";
export type StrategyPriority = "clean" | "nearHome" | "elite" | "maintenance";

export interface CampaignUiLocalState {
  readonly panel: CampaignUiPanel;
  readonly equippedTool: CampaignUiTool | null;
  readonly strategyByActor: Readonly<Record<string, StrategyPriority>>;
  /** Lets the UI shell close an auto-opened result without changing domain outcome state. */
  readonly dismissedResultRunId?: string | null;
}

export interface CampaignUiSource {
  readonly run: RunState;
  readonly meta: MetaProgress;
  readonly settings: CampaignSettings;
  readonly tutorial: TutorialState;
  readonly ui: CampaignUiLocalState;
  readonly settlement?: ResearchSettlement | null;
  /** Localized mission title supplied by the mission catalog. The stable missionId remains separate. */
  readonly missionTitle?: string;
  readonly availableDisplays?: readonly { readonly id: string; readonly label: string }[];
  readonly failureReason?: "both-homes-fallen" | "abandoned" | "unknown";
}

/** Deep-cloned read model. Rendering it cannot observe an in-progress simulation write. */
export interface CampaignUiSnapshot extends CampaignUiSource {
  readonly revision: string;
  readonly run: RunState;
  readonly meta: MetaProgress;
  readonly settings: CampaignSettings;
  readonly tutorial: TutorialState;
  readonly ui: CampaignUiLocalState;
  readonly availableDisplays: readonly { readonly id: string; readonly label: string }[];
}

export type CampaignUiCommand =
  | { readonly commandId: string; readonly readRevision: string; readonly type: "campaign.start" }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "appearance.select"; readonly appearanceId: "female" | "male" }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "panel.open"; readonly panel: Exclude<CampaignUiPanel, "none"> }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "panel.close" }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "campaign.pause-toggle" }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "tool.equip"; readonly tool: CampaignUiTool | null }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "upgrade.purchase"; readonly upgradeId: RunUpgradeId }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "device.place"; readonly deviceId: keyof typeof DEVICE_PRICES }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "device.maintain"; readonly trapId: string }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "device.remove"; readonly trapId: string }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "research.purchase"; readonly nodeId: string }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "research.reset" }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "strategy.set"; readonly actorId: string; readonly priority: StrategyPriority }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "house.repair"; readonly houseId: string }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "result.retry" }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "result.continue" }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "settings.update"; readonly path: string; readonly value: string | number | boolean }
  | { readonly commandId: string; readonly readRevision: string; readonly type: "tutorial.dismiss" | "tutorial.skip-step" | "tutorial.skip-all" };

export type CampaignUiCommandBody = CampaignUiCommand extends infer Command
  ? Command extends CampaignUiCommand ? Omit<Command, "commandId" | "readRevision"> : never
  : never;

export interface UpgradeView {
  readonly id: RunUpgradeId;
  readonly name: string;
  readonly level: number;
  readonly cost: number | null;
  readonly current: string;
  readonly next: string | null;
  readonly affordable: boolean;
  readonly available: boolean;
}

export interface ToolView {
  readonly id: CampaignUiTool;
  readonly name: string;
  readonly status: "available" | "active" | "full" | "overheated" | "cooling" | "blocked";
  readonly detail: string;
  readonly pressed: boolean;
}

export interface ResearchNodeView {
  readonly id: string;
  readonly branch: ResearchBranch;
  readonly branchName: string;
  readonly tier: number;
  readonly cost: number;
  readonly effect: string;
  readonly state: "owned" | "available" | "unaffordable" | "prerequisite" | "demo-locked";
  readonly prerequisite: string | null;
  readonly demo: boolean;
}

const UPGRADE_ATTRIBUTE: Readonly<Record<RunUpgradeId, keyof RunAttributes>> = {
  cleanerClean: "cleanSeconds", cleanerMove: "moveSpeed", cleanerCapacity: "cleanerCapacity",
  frogTongue: "tongueReach", frogAttack: "attackCooldown", frogDigestion: "digestionSeconds",
  frogBatch: "tongueBatch", frogCapacity: "frogCapacity", bagCapacity: "bagCapacity",
  bagEfficiency: "unloadSeconds", swatDamage: "swatDamage", swatHeat: "swatHeat",
  trapMaintenance: "trapMaintenanceMultiplier", homeArmor: "homeMaxHp",
};

const PERCENT_ATTRIBUTES = new Set<keyof RunAttributes>(["trapMaintenanceMultiplier"]);
const SECOND_ATTRIBUTES = new Set<keyof RunAttributes>(["cleanSeconds", "attackCooldown", "digestionSeconds", "unloadSeconds"]);
const DIP_ATTRIBUTES = new Set<keyof RunAttributes>(["moveSpeed", "tongueReach"]);

const RESEARCH_EFFECTS: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  en: {
    "grip-stamina-15pct": "Grip stamina +15%", "half-carry-penalty": "Halves the movement penalty while carrying",
    "platform-vault": "Improves platform vaulting", "cleanse-area": "Briefly purifies an area while cleaning",
    "jump-control-10pct": "Jump control +10%", "base-pouch-plus-2": "Base capture pouch capacity +2",
    "chain-capture": "Improves consecutive captures within capacity", "landing-control": "Improves crowd control on landing",
    "capacity-plus-2": "Bag capacity +2", "area-pickup": "Unlocks short-range pickup",
    "corpse-weight-minus-25pct": "Corpse weight -25%", "chain-pickup-area": "Expands the consecutive pickup area",
    "faster-cooling": "Swatter cools faster", "radius-plus-4dip": "Swatter radius +4 DIP", "armor-break": "Unlocks armor-breaking hits", "limited-chain-lightning": "Unlocks limited chain lightning",
    "enhanced-catcher": "Unlocks enhanced Bug Trap configuration", "slot-plus-1": "Trap slot +1", "grid-door": "Unlocks Grid Door", "slot-plus-1-synergy": "Trap slot +1 and device synergy",
    "hp-plus-10pct": "Both homes maximum HP +10%", "repair-plus-10pct": "Repair effectiveness +10%", "retreat-no-carry-penalty": "No carry-speed penalty during retreat", "siege-shield": "Adds a shield at the start of a siege",
  },
  "zh-CN": {
    "grip-stamina-15pct": "抓握耐力 +15%", "half-carry-penalty": "搬运时的移动惩罚减半", "platform-vault": "强化翻越平台能力", "cleanse-area": "清扫时短暂净化一片区域",
    "jump-control-10pct": "起跳控制 +10%", "base-pouch-plus-2": "基础捕虫囊容量 +2", "chain-capture": "在容量限制内强化连续捕食", "landing-control": "强化落地控场",
    "capacity-plus-2": "垃圾袋容量 +2", "area-pickup": "解锁小范围拾取", "corpse-weight-minus-25pct": "尸体重量 -25%", "chain-pickup-area": "扩大连续拾取范围",
    "faster-cooling": "电网拍冷却更快", "radius-plus-4dip": "电网拍拍面半径 +4 DIP", "armor-break": "解锁破甲打击", "limited-chain-lightning": "解锁限次连锁电击",
    "enhanced-catcher": "解锁捕虫箱强化配置", "slot-plus-1": "陷阱槽 +1", "grid-door": "解锁电网门", "slot-plus-1-synergy": "陷阱槽 +1并强化设备协同",
    "hp-plus-10pct": "两座家最大生命 +10%", "repair-plus-10pct": "修补效率 +10%", "retreat-no-carry-penalty": "撤退携物不再降低速度", "siege-shield": "围攻开始时获得护盾",
  },
};

function finite(value: number): number { return Number.isFinite(value) ? value : 0; }
function percent(value: number): number { return Math.round(Math.max(0, Math.min(100, finite(value)))); }

function formatAttribute(locale: Locale, attribute: keyof RunAttributes, value: number): string {
  if (PERCENT_ATTRIBUTES.has(attribute)) return `${formatNumber(locale, value * 100)}%`;
  if (SECOND_ATTRIBUTES.has(attribute)) return `${formatNumber(locale, value)} s`;
  if (DIP_ATTRIBUTES.has(attribute)) return `${formatNumber(locale, value)} DIP`;
  return formatNumber(locale, value);
}

export function snapshotCampaignUi(source: CampaignUiSource): CampaignUiSnapshot {
  const clone = structuredClone(source) as CampaignUiSource;
  const displays = clone.availableDisplays?.length ? clone.availableDisplays : [{ id: "primary", label: "Primary" }];
  return Object.freeze({
    ...clone,
    revision: `${clone.run.runId}:${clone.run.tick}:${clone.run.phase}:${clone.ui.panel}:${clone.settings.language}`,
    availableDisplays: displays,
  });
}

export function pauseReasonText(locale: Locale, reason: string): string {
  const known: Readonly<Record<string, Parameters<typeof uiText>[1]>> = {
    user: "pause.user", player: "pause.user", shop: "pause.shop", "panel:shop": "pause.shop",
    research: "pause.research", "panel:research": "pause.research", settings: "pause.settings",
    "panel:settings": "pause.settings", tutorial: "pause.tutorial", detection: "pause.detection",
    "desktop-detection": "pause.detection", hidden: "pause.hidden", "emergency-hide": "pause.hidden",
  };
  return known[reason] ? uiText(locale, known[reason]) : uiText(locale, "pause.unknown", { id: reason });
}

export function upgradeViews(snapshot: CampaignUiSnapshot): UpgradeView[] {
  const locale = snapshot.settings.language;
  const currentAttributes = deriveRunAttributes(snapshot.run.upgrades, snapshot.run.researchNodes);
  return (Object.keys(RUN_UPGRADES) as RunUpgradeId[]).map(id => {
    const level = snapshot.run.upgrades.levels[id] ?? 0;
    const cost = runUpgradeCost(snapshot.run.upgrades, id);
    const attribute = UPGRADE_ATTRIBUTE[id];
    let next: string | null = null;
    if (cost !== null) {
      const preview = { levels: { ...snapshot.run.upgrades.levels, [id]: level + 1 } };
      next = formatAttribute(locale, attribute, deriveRunAttributes(preview, snapshot.run.researchNodes)[attribute]);
    }
    return {
      id, name: uiText(locale, `upgrade.${id}`), level, cost,
      current: id === "trapMaintenance" ? uiText(locale, "feature.unavailable") : formatAttribute(locale, attribute, currentAttributes[attribute]),
      next: id === "trapMaintenance" ? null : next,
      available: id !== "trapMaintenance",
      affordable: id !== "trapMaintenance" && cost !== null && snapshot.run.economy.parts >= cost,
    };
  });
}

export function toolViews(snapshot: CampaignUiSnapshot): ToolView[] {
  const locale = snapshot.settings.language;
  const frozen = isPaused(snapshot.run) || isTerminal(snapshot.run) || snapshot.run.phase === "preparation";
  const bagUsed = inventoryWeight(snapshot.run.inventory, "playerBag");
  const bagCapacity = snapshot.run.inventory.containers.playerBag?.capacity ?? BASE_RUN_ATTRIBUTES.bagCapacity;
  const heatCapacity = deriveRunAttributes(snapshot.run.upgrades, snapshot.run.researchNodes).swatHeat;
  const heat = percent(snapshot.run.swatter.heat / Math.max(1, heatCapacity) * 100);
  return (["bag", "swatter", "trap"] as const).map(id => {
    let status: ToolView["status"] = frozen ? "blocked" : snapshot.ui.equippedTool === id ? "active" : "available";
    let detail = status === "blocked" ? uiText(locale, "tool.blocked") : uiText(locale, status === "active" ? "tool.active" : "tool.available");
    if (!frozen && id === "bag") {
      if (bagUsed >= bagCapacity) { status = "full"; detail = uiText(locale, "tool.full"); }
      else detail = uiText(locale, "tool.capacity", { used: bagUsed, capacity: bagCapacity });
    }
    if (!frozen && id === "swatter") {
      if (snapshot.run.swatter.overheated) { status = "overheated"; detail = uiText(locale, "tool.overheated"); }
      else if (heat > 0 && !snapshot.run.swatter.active) { status = "cooling"; detail = uiText(locale, "tool.cooling", { percent: heat }); }
    }
    return { id, name: uiText(locale, `tool.${id}`), status, detail, pressed: snapshot.ui.equippedTool === id };
  });
}

export function researchNodeViewsFor(locale: Locale, meta: MetaProgress): ResearchNodeView[] {
  return RESEARCH_NODES.map(node => {
    const owned = meta.nodes.includes(node.id);
    const prerequisiteMet = node.prerequisite === null || meta.nodes.includes(node.prerequisite);
    const state: ResearchNodeView["state"] = owned ? "owned" : !node.demo ? "demo-locked" : !prerequisiteMet ? "prerequisite" : meta.researchPoints >= node.cost ? "available" : "unaffordable";
    return { ...node, branchName: uiText(locale, `research.${node.branch}`), effect: RESEARCH_EFFECTS[locale][node.effect] ?? node.effect, state };
  });
}

export function researchNodeViews(snapshot: CampaignUiSnapshot): ResearchNodeView[] {
  return researchNodeViewsFor(snapshot.settings.language, snapshot.meta);
}

export function tutorialView(snapshot: CampaignUiSnapshot): { message: string; current: number; total: number; blocking: boolean } | null {
  if (!snapshot.settings.gameplay.tutorialPrompts || snapshot.tutorial.status === "not-started" || snapshot.tutorial.status === "skipped") return null;
  const prompt = snapshot.tutorial.blockingPrompt;
  const key = prompt?.messageKey ?? tutorialMessageKey(snapshot.tutorial.step);
  return {
    message: (translate as (locale: Locale, messageKey: Parameters<typeof translate>[1]) => string)(snapshot.settings.language, key),
    current: Math.max(1, TUTORIAL_STEPS.indexOf(snapshot.tutorial.step) + 1),
    total: TUTORIAL_STEPS.length,
    blocking: prompt !== null,
  };
}

export function resultTitle(locale: Locale, phase: CampaignPhase): string {
  if (phase === "victory") return uiText(locale, "result.victory");
  if (phase === "defeat") return uiText(locale, "result.defeat");
  return uiText(locale, "result.abandoned");
}

export function resultReason(snapshot: CampaignUiSnapshot): string {
  const reason = snapshot.failureReason ?? (snapshot.run.phase === "defeat" ? "both-homes-fallen" : snapshot.run.phase === "abandoned" ? "abandoned" : "unknown");
  return uiText(snapshot.settings.language, reason === "both-homes-fallen" ? "failure.bothHomes" : reason === "abandoned" ? "failure.abandoned" : "failure.unknown");
}

export function resultMetrics(snapshot: CampaignUiSnapshot): readonly { readonly label: string; readonly value: string }[] {
  const locale = snapshot.settings.language;
  let spent = 0;
  for (const [receipt, value] of Object.entries(snapshot.run.economy.purchases)) {
    const tuple = JSON.parse(receipt) as unknown[];
    if (tuple[0] === "spend") spent += value;
    else if (tuple[0] === "refund" || tuple[0] === "unused-refund") spent -= value;
  }
  return [
    { label: uiText(locale, "result.partsSpent"), value: formatNumber(locale, Math.max(0, spent)) },
    { label: uiText(locale, "result.effectiveActions"), value: formatNumber(locale, effectiveScore(snapshot.run.economy)) },
    { label: uiText(locale, "result.peakInfestation"), value: `${formatNumber(locale, snapshot.run.ecology.peakDensity)}%` },
    { label: uiText(locale, "result.research"), value: formatNumber(locale, snapshot.settlement?.researchReward ?? 0) },
  ];
}

export function phaseAnnouncement(snapshot: CampaignUiSnapshot): { readonly title: string; readonly body: string } | null {
  const locale = snapshot.settings.language;
  if (snapshot.run.phase === "retreat") return { title: uiText(locale, "retreat.title"), body: uiText(locale, "retreat.body") };
  if (snapshot.run.phase === "siege") return { title: uiText(locale, "siege.title"), body: uiText(locale, "siege.body") };
  return null;
}

export function missionLabel(snapshot: CampaignUiSnapshot): string {
  return snapshot.missionTitle?.trim() || snapshot.run.missionId;
}

export function createUiCommand<T extends CampaignUiCommandBody>(
  snapshot: CampaignUiSnapshot,
  sequence: number,
  body: T,
): CampaignUiCommand {
  return { ...body, commandId: `${snapshot.run.runId}:ui:${snapshot.run.tick}:${sequence}`, readRevision: snapshot.revision } as CampaignUiCommand;
}
