import type { Point } from './tool-system';

/** Serialized per-object state for the continuous desktop ecosystem. */
export interface EntityEcology {
  disposition: 'none' | 'consumed' | 'carrier-cleared';
  stage: 'none' | 'egg' | 'small' | 'medium' | 'adult';
  sex: 'none' | 'male' | 'female';
  energy: number;
  growthSeconds: number;
  breedCooldown: number;
  mated: boolean;
  food: number;
  carrierId: string | null;
  wanderX: number;
  wanderY: number;
  wanderRemaining: number;
  wanderSeed: number;
  heading: number;
  /** Missing means idle. Active actions always persist the complete action triplet. */
  action?: 'feeding' | 'mating' | 'laying';
  actionElapsed?: number;
  actionTargetId?: string | null;
}

/** Transient, host-verified reachable nursery/garbage sites; never saved as terrain authority. */
export interface EcologyPlacement {
  points: readonly Point[];
  floorY: number;
  widthDip?: number;
  heightDip?: number;
  /** Frame-local player claims. They remain part of population/cap accounting while
   * lifecycle, feeding, breeding and movement wait for the direct manipulation to end. */
  frozenObjectIds?: readonly string[];
}

export const ECOLOGY_CYCLE = Object.freeze({
  version: 2 as const,
  openingTrash: 3,
  trashIntervalMin: 20,
  trashIntervalMax: 35,
  infectedTrashChance: 0.2,
  hatchSeconds: 30,
  smallGrowthSeconds: 45,
  mediumGrowthSeconds: 60,
  starvationSeconds: 120,
  maxEnergy: 100,
  hungerThreshold: 45,
  growthEnergyThreshold: 45,
  breedingEnergy: 80,
  breedingCost: 30,
  breedingCooldown: 90,
  clutchSize: 2,
  trashNutrition: 100,
  corpseNutrition: 20,
  feedingPerSecond: 15,
  feedingSlots: 2,
  matingSeconds: 4,
  layingSeconds: 3,
  maxWorldTrash: 40,
  maxPopulation: 200,
});
