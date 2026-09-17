import { setCampaignPaused } from '../campaign-controller';
import type { CampaignFixedStepHook } from '../campaign-session-v4';
import type { CampaignAgentDriver } from './driver';

/** Apply the driver's safety recommendation inside the existing live transaction, before
 * adapter.step. Calling session.command here would be reentrant. Resume is deliberately
 * host-owned: refresh input, then clear the 'surface' pause in a separate session command.
 * The driver alone remains usable as a diagnostic-only synchronous hook. */
export function createCampaignAgentSessionHook(driver: CampaignAgentDriver): CampaignFixedStepHook {
  return (adapter, seconds) => {
    const result = driver.beforeDomainStep(adapter, seconds);
    if (result.pauseSuggested) setCampaignPaused(adapter.run, 'surface', true);
  };
}
