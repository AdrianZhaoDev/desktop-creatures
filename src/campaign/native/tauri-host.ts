import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { NativeCampaignHost } from './types';
/** DOM Esc works only when delivered to this WebView. Global Esc requires a Rust input hook. */
export function createTauriCampaignHost(): NativeCampaignHost {
  return {
    invoke: (command, args) => invoke(command, args),
    listen: (name, callback) => listen(name, event => callback(event.payload)),
    now: () => Date.now(),
    every: (ms, callback) => { const timer = setInterval(callback, ms); return () => clearInterval(timer); },
    onLifecycle: callback => {
      const key = (event: KeyboardEvent) => { if (event.key === 'Escape') callback('escape'); };
      const blur = () => callback('blur');
      const visibility = () => callback(document.hidden ? 'hidden' : 'visible');
      window.addEventListener('keydown', key); window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility);
      visibility();
      return () => { window.removeEventListener('keydown', key); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); };
    },
  };
}
