import type { Locale } from "../i18n";
import { uiText } from "./copy";

export interface CampaignDisplayOption {
  readonly id: string;
  readonly label: string;
}

const escapeHtml = (value: string): string => value.replace(/[&<>'"]/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]!);

/**
 * Keeps a disconnected saved preference visible and selected. Choosing a live option
 * remains an explicit settings command; rendering never rewrites the persisted ID.
 */
export function renderCampaignDisplayOptions(
  locale: Locale,
  currentDisplayId: string,
  availableDisplays: readonly CampaignDisplayOption[],
): string {
  const unique = new Map<string, CampaignDisplayOption>();
  for (const display of availableDisplays) if (!unique.has(display.id)) unique.set(display.id, display);
  const connected = unique.has(currentDisplayId);
  const unavailable = connected ? "" : `<option value="${escapeHtml(currentDisplayId)}" selected disabled>${escapeHtml(uiText(locale, "settings.displayDisconnected", { id: currentDisplayId }))}</option>`;
  const options = [...unique.values()].map(display => `<option value="${escapeHtml(display.id)}"${display.id === currentDisplayId ? " selected" : ""}>${escapeHtml(display.label)} · ${escapeHtml(display.id)}</option>`).join("");
  return unavailable + options;
}
