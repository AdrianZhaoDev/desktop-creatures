import type {
  RunIdentityPort,
  SettingsStoragePort,
  TutorialStoragePort,
} from "../application/campaign-application";
import type { CampaignStoragePort } from "../campaign-session-v4";

type LocalStorageReader = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type SequenceStorage = Pick<Storage, "getItem" | "setItem">;

export const MACHINE_LOCAL_STORAGE_KEYS = Object.freeze({
  settings: "desktop-creatures:campaign:machine:settings:v1",
  tutorial: "desktop-creatures:campaign:machine:tutorial:v1",
  runSequence: "desktop-creatures:campaign:host:run-sequence:v1",
});

export interface MachineLocalPorts {
  readonly settingsStorage: SettingsStoragePort;
  readonly tutorialStorage: TutorialStoragePort;
}

export interface HostRunIdentityOptions {
  /** Defaults to crypto.getRandomValues. Tests may inject a deterministic Uint32 source. */
  readonly randomUint32?: () => number;
  /** Machine-local durable storage; this counter never enters a V4/native profile. */
  readonly sequenceStorage: SequenceStorage;
  /** Must include every active and settled run known to the current campaign owner. */
  readonly existingRunIds: () => Iterable<string>;
  readonly sequenceKey?: string;
}

export function createMemoryCampaignStorage(): CampaignStoragePort {
  const documents = new Map<string, string>();
  const legacyBackups = new Map<string, string>();

  return {
    async read(profile) {
      return documents.get(profile) ?? null;
    },
    async writeAtomic(profile, json) {
      documents.set(profile, json);
    },
    async preserveLegacy(profile, raw) {
      const existing = legacyBackups.get(profile);
      if (existing !== undefined && existing !== raw) {
        throw new Error(`A different legacy backup already exists for profile ${profile}`);
      }
      legacyBackups.set(profile, raw);
    },
  };
}

function createMachineLocalPort(storage: LocalStorageReader, key: string): SettingsStoragePort {
  return {
    async read() {
      return storage.getItem(key);
    },
    async writeAtomic(serialized) {
      if (serialized === null) storage.removeItem(key);
      else storage.setItem(key, serialized);
    },
  };
}

export function createMachineLocalPorts(storage: LocalStorageReader): MachineLocalPorts {
  return {
    settingsStorage: createMachineLocalPort(storage, MACHINE_LOCAL_STORAGE_KEYS.settings),
    tutorialStorage: createMachineLocalPort(storage, MACHINE_LOCAL_STORAGE_KEYS.tutorial),
  };
}

function secureRandomUint32(): number {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw new Error("Secure Uint32 randomness is unavailable");
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0];
}

function checkedUint32(source: () => number): number {
  const value = source();
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("Run identity random source must return a Uint32");
  }
  return value;
}

function readSequence(storage: SequenceStorage, key: string): number {
  const raw = storage.getItem(key);
  if (raw === null) return 0;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error("Invalid durable run sequence");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid durable run sequence");
  return value;
}

function advanceSequence(storage: SequenceStorage, key: string, current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error("Durable run sequence exhausted");
  const next = current + 1;
  const serialized = String(next);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error("Durable run sequence was not persisted");
  return next;
}

export function createHostRunIdentity(options: HostRunIdentityOptions): RunIdentityPort {
  const sequenceKey = options.sequenceKey ?? MACHINE_LOCAL_STORAGE_KEYS.runSequence;
  if (!sequenceKey) throw new Error("A durable run sequence key is required");
  const randomUint32 = options.randomUint32 ?? secureRandomUint32;
  const issuedByThisHost = new Set<string>();

  return {
    nextRun() {
      const occupied = new Set(options.existingRunIds());
      for (;;) {
        const sequence = advanceSequence(
          options.sequenceStorage,
          sequenceKey,
          readSequence(options.sequenceStorage, sequenceKey),
        );
        const entropy = checkedUint32(randomUint32);
        const runId = `run-${sequence.toString(36)}-${entropy.toString(16).padStart(8, "0")}`;
        if (occupied.has(runId) || issuedByThisHost.has(runId)) continue;

        const seed = checkedUint32(randomUint32);
        issuedByThisHost.add(runId);
        return { runId, seed };
      }
    },
  };
}
