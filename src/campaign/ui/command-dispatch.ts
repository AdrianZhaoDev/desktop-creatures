import type { CampaignUiCommand, CampaignUiCommandBody } from "./model";

export interface CampaignUiCommandResultLike {
  readonly ok: boolean;
  readonly reason?: string;
  readonly snapshot?: unknown;
}

export type CampaignUiCommandFactory = (body: CampaignUiCommandBody) => CampaignUiCommand;
export type CampaignUiCommandHandler = (
  command: CampaignUiCommand,
) => void | CampaignUiCommandResultLike | Promise<void | CampaignUiCommandResultLike>;

export interface CampaignCommandCoordinatorOptions {
  readonly createCommand: CampaignUiCommandFactory;
  readonly onCommand: CampaignUiCommandHandler;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onFailure?: (reason: string, command: CampaignUiCommand | null) => void;
  readonly onSuccess?: (result: CampaignUiCommandResultLike | undefined, command: CampaignUiCommand) => void | Promise<void>;
  readonly onRefresh?: (result: CampaignUiCommandResultLike | undefined, command: CampaignUiCommand) => void | Promise<void>;
}

export interface CampaignCommandSubmission {
  readonly accepted: boolean;
  readonly ok?: boolean;
  readonly reason?: string;
}

function isSafeWhileBusy(body: CampaignUiCommandBody): boolean {
  return body.type === "panel.close" || body.type === "tool.equip" && body.tool === null;
}

/** Shared async gate for DOM mounts. It serializes mutations, deduplicates double-clicks,
 * and still permits explicit close/cancel commands while another request is pending.
 */
export class CampaignCommandCoordinator {
  private readonly pendingBodies = new Set<string>();
  private pendingCount = 0;

  constructor(private readonly options: CampaignCommandCoordinatorOptions) {}

  get busy(): boolean { return this.pendingCount > 0; }

  async submit(body: CampaignUiCommandBody): Promise<CampaignCommandSubmission> {
    const signature = JSON.stringify(body);
    if (this.pendingBodies.has(signature) || this.busy && !isSafeWhileBusy(body)) return { accepted: false };
    let command: CampaignUiCommand;
    try { command = this.options.createCommand(body); }
    catch {
      const reason = "command-factory-failed";
      this.options.onFailure?.(reason, null);
      return { accepted: false, ok: false, reason };
    }
    this.pendingBodies.add(signature);
    this.pendingCount++;
    this.options.onBusyChange?.(true);
    try {
      const result = await this.options.onCommand(command);
      const normalized = result as CampaignUiCommandResultLike | undefined;
      if (normalized && !normalized.ok) {
        const reason = normalized.reason?.trim() || "command-rejected";
        this.options.onFailure?.(reason, command);
        return { accepted: true, ok: false, reason };
      }
      await this.options.onSuccess?.(normalized, command);
      await this.options.onRefresh?.(normalized, command);
      return { accepted: true, ok: true };
    } catch {
      const reason = "dispatch-failed";
      this.options.onFailure?.(reason, command);
      return { accepted: true, ok: false, reason };
    } finally {
      this.pendingBodies.delete(signature);
      this.pendingCount--;
      this.options.onBusyChange?.(this.busy);
    }
  }
}
