export const SUPPORTED_LOCALES = ["zh-CN", "en"] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];

export const FALLBACK_LOCALE: Locale = "en";

export const MESSAGE_KEYS = [
  "toolbar.currentTask",
  "toolbar.parts",
  "toolbar.pollution",
  "toolbar.infestation",
  "toolbar.homeStatus",
  "toolbar.tools",
  "toolbar.pause",
  "toolbar.resume",
  "term.parts",
  "term.researchPoints",
  "term.collectionBag",
  "term.electricSwatter",
  "term.baitStation",
  "term.gluePad",
  "term.bugTrap",
  "term.pollution",
  "term.infestation",
  "status.companionsSheltering",
  "status.bothHomesFallen",
  "status.noReachableRoute",
  "status.detectionUnavailable",
  "status.exitToolMode",
  "settings.title",
  "settings.language",
  "settings.quality",
  "settings.intensity",
  "settings.desktopDetection",
  "settings.display",
  "settings.uiScale",
  "settings.masterVolume",
  "settings.musicVolume",
  "settings.effectsVolume",
  "settings.alertVolume",
  "settings.motionEffects",
  "settings.flashes",
  "settings.stains",
  "settings.swarmAtmosphere",
  "settings.visualAlerts",
  "settings.tutorial",
  "settings.pauseWhenPanelOpen",
  "settings.feedback",
  "tutorial.welcome",
  "tutorial.desktopPassThrough",
  "tutorial.reachableTrash",
  "tutorial.bagTwoItems",
  "tutorial.bagToBin",
  "tutorial.exampleSurface",
  "tutorial.climb",
  "tutorial.surfaceChange",
  "tutorial.freeLadder",
  "tutorial.swatterKill",
  "tutorial.corpseCollection",
  "tutorial.runUpgrade",
  "tutorial.frogRescue",
  "tutorial.frogAbility",
  "tutorial.pollutionShelter",
  "tutorial.complete",
  "tutorial.tool.bag",
  "tutorial.tool.swatter",
  "tutorial.tool.trap",
  "tutorial.siege",
  "tutorial.dismiss",
  "tutorial.skipStep",
  "tutorial.skipAll",
  "error.invalidNumber",
  "error.modelMissing",
  "error.detectionFailed",
  "count.parts.one",
  "count.parts.other",
  "count.researchPoints.one",
  "count.researchPoints.other",
] as const;

export type MessageKey = typeof MESSAGE_KEYS[number];
type TranslationTable = Readonly<Record<MessageKey, string>>;

const ZH_CN = Object.freeze({
  "toolbar.currentTask": "当前任务",
  "toolbar.parts": "零件：{count}",
  "toolbar.pollution": "污染：{percent}%",
  "toolbar.infestation": "感染密度：{percent}%",
  "toolbar.homeStatus": "两屋状态",
  "toolbar.tools": "工具",
  "toolbar.pause": "暂停",
  "toolbar.resume": "继续",
  "term.parts": "零件",
  "term.researchPoints": "研究点",
  "term.collectionBag": "垃圾袋",
  "term.electricSwatter": "电网拍",
  "term.baitStation": "诱饵盒",
  "term.gluePad": "黏胶垫",
  "term.bugTrap": "捕虫箱",
  "term.pollution": "污染",
  "term.infestation": "感染密度",
  "status.companionsSheltering": "伙伴正在回家",
  "status.bothHomesFallen": "两座家都被攻破了",
  "status.noReachableRoute": "没有可到达的路线",
  "status.detectionUnavailable": "桌面识别暂不可用",
  "status.exitToolMode": "退出工具模式",
  "settings.title": "设置",
  "settings.language": "语言",
  "settings.quality": "画质",
  "settings.intensity": "强度",
  "settings.desktopDetection": "桌面感知",
  "settings.display": "显示器",
  "settings.uiScale": "界面缩放",
  "settings.masterVolume": "主音量",
  "settings.musicVolume": "音乐",
  "settings.effectsVolume": "音效",
  "settings.alertVolume": "警报音量",
  "settings.motionEffects": "震动与动态效果",
  "settings.flashes": "闪光",
  "settings.stains": "污渍",
  "settings.swarmAtmosphere": "虫群氛围",
  "settings.visualAlerts": "视觉警报始终开启",
  "settings.tutorial": "教学提示",
  "settings.pauseWhenPanelOpen": "打开面板时暂停",
  "settings.feedback": "反馈与诊断",
  "tutorial.welcome": "欢迎。先选择语言，并了解桌面感知只读取稳定几何。",
  "tutorial.desktopPassThrough": "普通工作时鼠标会穿透游戏区域；只有工具栏自身可点。",
  "tutorial.reachableTrash": "观察青年从底部出场并处理一份可到达的垃圾。",
  "tutorial.bagTwoItems": "装备垃圾袋，收集两件垃圾或尸体。",
  "tutorial.bagToBin": "把整袋拖进垃圾桶；收益只在投桶后结算。",
  "tutorial.exampleSurface": "打开随附示例页，用水平线和竖线搭出路线。",
  "tutorial.climb": "让竖线靠近角色，观察抓握和攀爬。",
  "tutorial.surfaceChange": "移动或滚动页面，观察支撑消失后的安全下落。",
  "tutorial.freeLadder": "放置免费的教学梯子，避免路线卡死。",
  "tutorial.swatterKill": "装备电网拍，按住扫掠并击杀一只虫。",
  "tutorial.corpseCollection": "击杀会留下尸体；再用垃圾袋收走。",
  "tutorial.runUpgrade": "购买一次局内升级，比较升级前后的实际效果。",
  "tutorial.frogRescue": "完成免费救援任务，解锁青蛙伙伴。",
  "tutorial.frogAbility": "观察青蛙跳跃、吐舌捕虫和返回蛙屋。",
  "tutorial.pollutionShelter": "观察污染与感染预警，并让伙伴安全撤回两座家。",
  "tutorial.complete": "首次教学完成；可在设置中重看。",
  "tutorial.tool.bag": "垃圾袋只捕获从袋图标开始的完整拖动；空白区域继续穿透。",
  "tutorial.tool.swatter": "电网拍装备后，按住目标开始扫掠，释放即结束本次手势。",
  "tutorial.tool.trap": "陷阱只在合法地面确认放置；取消不会扣除零件。",
  "tutorial.siege": "围攻即将开始。战役已暂停：伙伴会撤入两座家，请用工具清尸、攻击主巢并保护至少一座家。",
  "tutorial.dismiss": "知道了",
  "tutorial.skipStep": "跳过此步",
  "tutorial.skipAll": "跳过教学",
  "error.invalidNumber": "数值异常，已使用安全默认值。",
  "error.modelMissing": "角色模型暂不可用，已使用安全替代显示。",
  "error.detectionFailed": "桌面感知失效，战役压力已暂停。",
  "count.parts.one": "{count} 个零件",
  "count.parts.other": "{count} 个零件",
  "count.researchPoints.one": "{count} 个研究点",
  "count.researchPoints.other": "{count} 个研究点",
} as const satisfies TranslationTable);

const EN = Object.freeze({
  "toolbar.currentTask": "Current task",
  "toolbar.parts": "Parts: {count}",
  "toolbar.pollution": "Pollution: {percent}%",
  "toolbar.infestation": "Infestation: {percent}%",
  "toolbar.homeStatus": "Home status",
  "toolbar.tools": "Tools",
  "toolbar.pause": "Pause",
  "toolbar.resume": "Resume",
  "term.parts": "Parts",
  "term.researchPoints": "Research Points",
  "term.collectionBag": "Collection Bag",
  "term.electricSwatter": "Electric Swatter",
  "term.baitStation": "Bait Station",
  "term.gluePad": "Glue Pad",
  "term.bugTrap": "Bug Trap",
  "term.pollution": "Pollution",
  "term.infestation": "Infestation",
  "status.companionsSheltering": "Companions are taking shelter",
  "status.bothHomesFallen": "Both homes have fallen",
  "status.noReachableRoute": "No reachable route",
  "status.detectionUnavailable": "Desktop detection unavailable",
  "status.exitToolMode": "Exit tool mode",
  "settings.title": "Settings",
  "settings.language": "Language",
  "settings.quality": "Graphics quality",
  "settings.intensity": "Intensity",
  "settings.desktopDetection": "Desktop detection",
  "settings.display": "Display",
  "settings.uiScale": "UI scale",
  "settings.masterVolume": "Master volume",
  "settings.musicVolume": "Music",
  "settings.effectsVolume": "Sound effects",
  "settings.alertVolume": "Alert volume",
  "settings.motionEffects": "Motion effects",
  "settings.flashes": "Flashes",
  "settings.stains": "Stains",
  "settings.swarmAtmosphere": "Swarm atmosphere",
  "settings.visualAlerts": "Visual alerts always on",
  "settings.tutorial": "Tutorial prompts",
  "settings.pauseWhenPanelOpen": "Pause while panels are open",
  "settings.feedback": "Feedback and diagnostics",
  "tutorial.welcome": "Welcome. Choose a language and learn how desktop detection reads stable geometry only.",
  "tutorial.desktopPassThrough": "During normal work, clicks pass through the game area; only the toolbar receives them.",
  "tutorial.reachableTrash": "Watch the cleaner enter from below and handle one reachable piece of trash.",
  "tutorial.bagTwoItems": "Equip the Collection Bag and collect two pieces of trash or remains.",
  "tutorial.bagToBin": "Drag the full bag to the bin; rewards are settled only after disposal.",
  "tutorial.exampleSurface": "Open the included example page and use its horizontal and vertical lines as a route.",
  "tutorial.climb": "Move a vertical line near the companion and observe gripping and climbing.",
  "tutorial.surfaceChange": "Move or scroll the page and watch the companion fall safely when support disappears.",
  "tutorial.freeLadder": "Place the free tutorial ladder so the route cannot deadlock.",
  "tutorial.swatterKill": "Equip the Electric Swatter, hold to sweep, and defeat one bug.",
  "tutorial.corpseCollection": "Defeated bugs leave remains; collect them with the Collection Bag.",
  "tutorial.runUpgrade": "Buy one in-run upgrade and compare its actual before-and-after effect.",
  "tutorial.frogRescue": "Complete the free rescue mission to unlock the frog companion.",
  "tutorial.frogAbility": "Watch the frog jump, catch bugs with its tongue, and return to the frog home.",
  "tutorial.pollutionShelter": "Observe pollution and infestation warnings, then shelter both companions safely.",
  "tutorial.complete": "First-time tutorial complete. You can replay it from Settings.",
  "tutorial.tool.bag": "The Collection Bag captures the complete drag that starts on its icon; empty areas still pass clicks through.",
  "tutorial.tool.swatter": "With the Electric Swatter equipped, hold over targets to sweep and release to end the gesture.",
  "tutorial.tool.trap": "Confirm a trap only on valid ground. Cancelling does not spend Parts.",
  "tutorial.siege": "A siege is about to begin. The campaign is paused: companions will shelter in both homes. Clear remains, attack the main nest, and protect at least one home.",
  "tutorial.dismiss": "Got it",
  "tutorial.skipStep": "Skip this step",
  "tutorial.skipAll": "Skip tutorial",
  "error.invalidNumber": "A value was invalid, so a safe default was used.",
  "error.modelMissing": "A character model is unavailable, so a safe fallback is being shown.",
  "error.detectionFailed": "Desktop detection failed. Campaign pressure is paused.",
  "count.parts.one": "{count} Part",
  "count.parts.other": "{count} Parts",
  "count.researchPoints.one": "{count} Research Point",
  "count.researchPoints.other": "{count} Research Points",
} as const satisfies TranslationTable);

export const TRANSLATIONS: Readonly<Record<Locale, TranslationTable>> = Object.freeze({
  "zh-CN": ZH_CN,
  en: EN,
});

type PlaceholderNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;

export type MessageParams<Key extends MessageKey> = Readonly<Record<
  PlaceholderNames<(typeof EN)[Key]>,
  string | number
>>;

type TranslationArguments<Key extends MessageKey> = [PlaceholderNames<(typeof EN)[Key]>] extends [never]
  ? [params?: MessageParams<Key>]
  : [params: MessageParams<Key>];

/** Maps supported language variants to the two launch locales; unknown values use an explicit fallback. */
export function resolveLocale(value: unknown, fallback: Locale = FALLBACK_LOCALE): Locale {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/_/g, "-").toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  return fallback;
}

function placeholderNames(message: string): string[] {
  return [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]);
}

function render(locale: Locale, key: MessageKey, params: Readonly<Record<string, string | number>>): string {
  return TRANSLATIONS[locale][key].replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_token, name: string) => {
    if (!(name in params)) throw new Error(`Missing translation parameter "${name}" for "${key}"`);
    const value = params[name];
    return typeof value === "number" ? formatNumber(locale, value) : value;
  });
}

export function translate<Key extends MessageKey>(
  locale: Locale,
  key: Key,
  ...args: TranslationArguments<Key>
): string {
  return render(locale, key, args[0] ?? {});
}

export function formatNumber(locale: Locale, value: number): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(safeValue);
}

export type CountNoun = "parts" | "researchPoints";

export function formatCount(locale: Locale, noun: CountNoun, count: number): string {
  const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
  const form = new Intl.PluralRules(locale).select(safeCount) === "one" ? "one" : "other";
  return render(locale, `count.${noun}.${form}`, { count: safeCount });
}

/** Returns developer-facing dictionary defects without exposing stack details to players. */
export function validateTranslations(): string[] {
  const defects: string[] = [];
  for (const key of MESSAGE_KEYS) {
    const expected = [...new Set(placeholderNames(EN[key]))].sort();
    for (const locale of SUPPORTED_LOCALES) {
      const actual = [...new Set(placeholderNames(TRANSLATIONS[locale][key]))].sort();
      if (actual.join("|") !== expected.join("|")) {
        defects.push(`${locale}:${key}: expected {${expected.join(",")}}, received {${actual.join(",")}}`);
      }
    }
  }
  return defects;
}
