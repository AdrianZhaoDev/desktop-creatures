import type { CompanionState } from "../companion/types";
export type EntityKind = "garbage" | "egg" | "roach";
export type GameMode = "game" | "idle";
export interface GarbageTypeDefinition { id: string; name: string; qualityId: string; nutritionMultiplier: number; pollutionMultiplier: number }
export type RoachStageId = "newborn" | "small" | "medium" | "large" | "giant";
export type RoachState =
  | "idle" | "groom" | "walk-slow" | "walk" | "flee" | "hide" | "feed" | "sleep"
  | "oviposit" | "live-birth" | "grabbed" | "release-recover" | "pending-recycle";

export interface Range2 { 0: number; 1: number }

export interface CampaignStageDefinition {
  id: string;
  name: string;
  thresholdMinutes: number;
  maximumQuality: number;
  garbageCap: number;
  eggCap: number;
  roachCap: number;
  garbageIntervalSeconds: Range2;
  eggIntervalSeconds: Range2 | null;
}

export interface GarbageQualityDefinition {
  id: string;
  quality: number;
  name: string;
  sizeDip: number;
  spawnWeight: number;
  spoilSeconds: number;
  nutrition: number;
  pollutionWeight: number;
  color: string;
}

export interface SpeciesDefinition {
  id: string;
  name: string;
  scientificName: string;
  adultLengthDip: number;
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  finalWeight: number;
  unlockStage: number;
  eggSeconds: number;
  growthMultiplier: number;
  speedDipPerSecond: Range2;
  fleeSpeedDipPerSecond: number;
  threatRadiusDip: number;
  reproductionCooldownSeconds: Range2;
  broodSize: Range2;
  habitat: "warm-low" | "warm-high" | "damp-low" | "damp-edge" | "fruit-edge";
  liveBirth?: boolean;
  liveBirthGestationSeconds?: number;
}

export interface GrowthStageDefinition {
  id: "egg" | RoachStageId;
  formId: "ootheca" | "nymph-early" | "nymph-late" | "adult";
  scale: number;
  minimumAgeSeconds: number;
  requiredNutrition: number;
}

export interface GameBalanceV1 {
  schemaVersion: 1;
  revision?: number;
  garbageTypes?: GarbageTypeDefinition[];
  time: {
    initialQuietSeconds: number;
    simulationHz: number;
    decisionHz: number;
    maximumContaminationRate: number;
    pollutionAccelerationDivisor: number;
    timeScale: number;
  };
  campaignStages: CampaignStageDefinition[];
  garbageQualities: GarbageQualityDefinition[];
  species: SpeciesDefinition[];
  growthStages: GrowthStageDefinition[];
  giant: { chance: number; maximumCount: number };
  interaction: { pointerSampleHz: number; predictionMilliseconds: number; regionStaleMilliseconds: number };
  audio: { enabled: boolean; hisserVolume: number; entityCooldownSeconds: number; globalCooldownSeconds: number };
}

interface BaseEntity {
  id: number;
  generation: number;
  kind: EntityKind;
  x: number;
  y: number;
  spawnedAtSeconds: number;
  displayId?: string;
  pendingRecycle?: boolean;
  recycleAnimationProgress?: number;
  grabbed?: boolean;
  grabOrigin?: {x:number;y:number;displayId:string};
  recycleTarget?: { x: number; y: number };
  recycleReceiptNumber?: number;
}

export interface GarbageEntity extends BaseEntity {
  kind: "garbage";
  qualityId: string;
  garbageTypeId?: string;
  decaySeconds?: number;
  nutritionRemaining: number;
  consumedFraction: number;
}

export interface EggEntity extends BaseEntity {
  kind: "egg";
  speciesId: string;
  incubationSeconds: number;
  hatchProgress?: number;
}

export interface RoachEntity extends BaseEntity {
  kind: "roach";
  speciesId: string;
  stageId: RoachStageId;
  state: RoachState;
  ageInStageSeconds: number;
  lifetimeSeconds: number;
  nutritionInStage: number;
  heading: number;
  speed: number;
  targetX: number;
  targetY: number;
  targetFoodId?: number;
  decisionRemainingSeconds: number;
  stateRemainingSeconds: number;
  reproductionRemainingSeconds: number;
  gestationRemainingSeconds?: number;
  giantRollComplete: boolean;
  animationPhase: number;
}

export type GameEntity = GarbageEntity | EggEntity | RoachEntity;

export interface BinAnchor {
  displayId: string;
  xDip: number;
  yDip: number;
}

export interface RecycleJournalEntry {
  receiptId: string;
  entityId: number;
  status: "pending" | "recycled";
  fileName?: string;
}

export interface GameSaveV1 {
  saveVersion: 1;
  rngState: number;
  simulationSeconds: number;
  quietElapsedSeconds: number;
  contaminationSeconds: number;
  stageIndex: number;
  nextEntityId: number;
  nextMemorialNumber: number;
  width: number;
  height: number;
  binAnchor: BinAnchor;
  entities: GameEntity[];
  recycleJournal: RecycleJournalEntry[];
}

export interface GameSaveV2 extends Omit<GameSaveV1, "saveVersion"> {
  displayBounds?: Record<string,{width:number;height:number}>;
  saveVersion: 2;
  mode: GameMode;
  savedAt: string;
  garbageRemainingSeconds: number;
  eggRemainingSeconds: number | null;
  autoSave: boolean;
  audioEnabled: boolean;
}
export interface GameSaveV3 extends Omit<GameSaveV2, "saveVersion"> { saveVersion: 3; companion: CompanionState }
export type GameSave = GameSaveV1 | GameSaveV2 | GameSaveV3;

export interface PointerSample {
  displayId?: string;
  x: number;
  y: number;
  previousX: number;
  previousY: number;
  deltaSeconds: number;
}

export interface InteractionRegion {
  entityId: number;
  kind: EntityKind | "companion" | "bed";
  centerDip: { x: number; y: number };
  halfExtentDip: { x: number; y: number };
  rotationRad: number;
  priority: number;
}

export interface InteractionSnapshot {
  revision: number;
  generatedAtMs: number;
  displayId: string;
  regions: InteractionRegion[];
}

export interface GrabEvent {
  sessionId: number;
  phase: "start" | "move" | "end" | "cancel";
  entityId: number;
  kind: EntityKind | "companion" | "bed";
  displayId: string;
  screenPhysical: { x: number; y: number };
  localDip: { x: number; y: number };
  overTrashBin: boolean;
  timestampMs: number;
}

export interface TrashReceipt {
  receiptId: string;
  fileName: string;
  byteLength: 1024;
  recycled: true;
}
