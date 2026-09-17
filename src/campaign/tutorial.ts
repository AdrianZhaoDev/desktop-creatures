import type { MessageKey } from "./i18n";

export const TUTORIAL_STEPS = [
  "welcome",
  "desktop-pass-through",
  "reachable-trash",
  "bag-two-items",
  "bag-to-bin",
  "example-surface",
  "climb",
  "surface-change",
  "free-ladder",
  "swatter-kill",
  "corpse-collection",
  "run-upgrade",
  "frog-rescue",
  "frog-ability",
  "pollution-shelter",
  "complete",
] as const;

export type TutorialStep = typeof TUTORIAL_STEPS[number];
export type TutorialStatus = "not-started" | "running" | "completed" | "skipped";
export type TutorialTool = "bag" | "swatter" | "trap";

export type TutorialPrompt =
  | { readonly kind: "tool"; readonly tool: TutorialTool; readonly messageKey: MessageKey }
  | { readonly kind: "siege"; readonly messageKey: MessageKey };

/** Persistable UI-only progress. Game time and campaign phase are intentionally absent. */
export interface TutorialState {
  readonly schemaVersion: 1;
  readonly status: TutorialStatus;
  readonly step: TutorialStep;
  readonly completedSteps: readonly TutorialStep[];
  readonly skippedSteps: readonly TutorialStep[];
  readonly collectedBagItemIds: readonly string[];
  readonly learnedTools: readonly TutorialTool[];
  readonly siegeExplained: boolean;
  readonly blockingPrompt: TutorialPrompt | null;
}

export type TutorialEvent =
  | { readonly type: "start" }
  | { readonly type: "replay" }
  | { readonly type: "acknowledge-welcome" }
  | { readonly type: "cleaner-entered" }
  | { readonly type: "trash-cleaned" }
  | { readonly type: "bag-item-collected"; readonly itemId: string }
  | { readonly type: "bag-recycled" }
  | { readonly type: "example-opened" }
  | { readonly type: "climb-observed" }
  | { readonly type: "support-removed" }
  | { readonly type: "ladder-used" }
  | { readonly type: "roach-killed" }
  | { readonly type: "corpse-collected" }
  | { readonly type: "upgrade-purchased" }
  | { readonly type: "frog-unlocked" }
  | { readonly type: "frog-ability-observed" }
  | { readonly type: "shelter-observed" }
  | { readonly type: "tool-equipped"; readonly tool: TutorialTool }
  | { readonly type: "siege-imminent" }
  | { readonly type: "dismiss-prompt" }
  | { readonly type: "skip-step" }
  | { readonly type: "skip-all" };

const TOOL_MESSAGE_KEYS: Readonly<Record<TutorialTool, MessageKey>> = Object.freeze({
  bag: "tutorial.tool.bag",
  swatter: "tutorial.tool.swatter",
  trap: "tutorial.tool.trap",
});

const REQUIRED_EVENT: Readonly<Partial<Record<TutorialStep, TutorialEvent["type"]>>> = Object.freeze({
  welcome: "acknowledge-welcome",
  "desktop-pass-through": "cleaner-entered",
  "reachable-trash": "trash-cleaned",
  "bag-to-bin": "bag-recycled",
  "example-surface": "example-opened",
  climb: "climb-observed",
  "surface-change": "support-removed",
  "free-ladder": "ladder-used",
  "swatter-kill": "roach-killed",
  "corpse-collection": "corpse-collected",
  "run-upgrade": "upgrade-purchased",
  "frog-rescue": "frog-unlocked",
  "frog-ability": "frog-ability-observed",
  "pollution-shelter": "shelter-observed",
});

const STEP_SET = new Set<string>(TUTORIAL_STEPS);
const TOOL_SET = new Set<string>(["bag", "swatter", "trap"] satisfies TutorialTool[]);

export function createTutorialState(): TutorialState {
  return {
    schemaVersion: 1,
    status: "not-started",
    step: "welcome",
    completedSteps: [],
    skippedSteps: [],
    collectedBagItemIds: [],
    learnedTools: [],
    siegeExplained: false,
    blockingPrompt: null,
  };
}

/** A tutorial-owned blocking prompt asks the campaign controller to freeze its independent clock. */
export function tutorialPauseRequested(state: TutorialState): boolean {
  return state.blockingPrompt !== null;
}

export function tutorialMessageKey(step: TutorialStep): MessageKey {
  const explicit: Readonly<Record<TutorialStep, MessageKey>> = {
    welcome: "tutorial.welcome",
    "desktop-pass-through": "tutorial.desktopPassThrough",
    "reachable-trash": "tutorial.reachableTrash",
    "bag-two-items": "tutorial.bagTwoItems",
    "bag-to-bin": "tutorial.bagToBin",
    "example-surface": "tutorial.exampleSurface",
    climb: "tutorial.climb",
    "surface-change": "tutorial.surfaceChange",
    "free-ladder": "tutorial.freeLadder",
    "swatter-kill": "tutorial.swatterKill",
    "corpse-collection": "tutorial.corpseCollection",
    "run-upgrade": "tutorial.runUpgrade",
    "frog-rescue": "tutorial.frogRescue",
    "frog-ability": "tutorial.frogAbility",
    "pollution-shelter": "tutorial.pollutionShelter",
    complete: "tutorial.complete",
  };
  return explicit[step];
}

function appendUnique<Value>(values: readonly Value[], value: Value): readonly Value[] {
  return values.includes(value) ? values : [...values, value];
}

function advance(state: TutorialState, skipped: boolean): TutorialState {
  const index = TUTORIAL_STEPS.indexOf(state.step);
  if (index < 0 || state.step === "complete") return state;
  const completedSteps = skipped ? state.completedSteps : appendUnique(state.completedSteps, state.step);
  const skippedSteps = skipped ? appendUnique(state.skippedSteps, state.step) : state.skippedSteps;
  const step = TUTORIAL_STEPS[index + 1];
  return {
    ...state,
    status: step === "complete" ? "completed" : "running",
    step,
    completedSteps,
    skippedSteps,
  };
}

function dismissPrompt(state: TutorialState): TutorialState {
  const prompt = state.blockingPrompt;
  if (!prompt) return state;
  if (prompt.kind === "tool") {
    return { ...state, learnedTools: appendUnique(state.learnedTools, prompt.tool), blockingPrompt: null };
  }
  return { ...state, siegeExplained: true, blockingPrompt: null };
}

/** Pure reducer: identical state and event inputs always produce the same serializable state. */
export function reduceTutorial(state: TutorialState, event: TutorialEvent): TutorialState {
  if (event.type === "replay") return { ...createTutorialState(), status: "running" };
  if (event.type === "skip-all") {
    return { ...state, status: "skipped", blockingPrompt: null };
  }
  if (event.type === "dismiss-prompt") return dismissPrompt(state);
  if (state.blockingPrompt) return state;
  if (state.status === "skipped") return state;

  if (event.type === "tool-equipped") {
    if (state.learnedTools.includes(event.tool)) return state;
    return {
      ...state,
      blockingPrompt: { kind: "tool", tool: event.tool, messageKey: TOOL_MESSAGE_KEYS[event.tool] },
    };
  }
  if (event.type === "siege-imminent") {
    if (state.siegeExplained) return state;
    return { ...state, blockingPrompt: { kind: "siege", messageKey: "tutorial.siege" } };
  }
  if (event.type === "start") {
    return state.status === "not-started" ? { ...state, status: "running" } : state;
  }
  if (state.status !== "running") return state;
  if (event.type === "skip-step") return advance(state, true);

  if (state.step === "bag-two-items" && event.type === "bag-item-collected") {
    const itemId = event.itemId.trim();
    if (!itemId) return state;
    const collectedBagItemIds = appendUnique(state.collectedBagItemIds, itemId);
    const collected = { ...state, collectedBagItemIds };
    return collectedBagItemIds.length >= 2 ? advance(collected, false) : collected;
  }
  return REQUIRED_EVENT[state.step] === event.type ? advance(state, false) : state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown, allowed?: ReadonlySet<string>): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" && (!allowed || allowed.has(item)));
}

function isPrompt(value: unknown): value is TutorialPrompt | null {
  if (value === null) return true;
  if (!isRecord(value) || typeof value.messageKey !== "string") return false;
  if (value.kind === "siege") return value.messageKey === "tutorial.siege";
  return value.kind === "tool" && typeof value.tool === "string" && TOOL_SET.has(value.tool)
    && value.messageKey === TOOL_MESSAGE_KEYS[value.tool as TutorialTool];
}

export function isTutorialState(value: unknown): value is TutorialState {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (!new Set(["not-started", "running", "completed", "skipped"]).has(String(value.status))) return false;
  if (typeof value.step !== "string" || !STEP_SET.has(value.step)) return false;
  if (!stringArray(value.completedSteps, STEP_SET) || !stringArray(value.skippedSteps, STEP_SET)) return false;
  if (!stringArray(value.collectedBagItemIds) || new Set(value.collectedBagItemIds).size !== value.collectedBagItemIds.length) return false;
  if (!stringArray(value.learnedTools, TOOL_SET) || new Set(value.learnedTools).size !== value.learnedTools.length) return false;
  if (typeof value.siegeExplained !== "boolean" || !isPrompt(value.blockingPrompt)) return false;
  if (value.status === "completed" && value.step !== "complete") return false;
  return true;
}

/** Invalid or future tutorial data starts safely without mutating the supplied value. */
export function parseTutorialState(serialized: string | unknown): TutorialState {
  let value = serialized;
  if (typeof serialized === "string") {
    try { value = JSON.parse(serialized) as unknown; }
    catch { return createTutorialState(); }
  }
  return isTutorialState(value) ? structuredClone(value) : createTutorialState();
}

export function serializeTutorialState(state: TutorialState): string {
  return JSON.stringify(state);
}
