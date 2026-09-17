import '../../src/styles.css';
import { bootCampaignProduction } from '../../src/campaign/app/boot';

// Dedicated local candidate entry. No query can select the legacy or development routes.
void bootCampaignProduction().catch(error => {
  console.error(error);
  const status = document.querySelector('#status') ?? document.body.appendChild(document.createElement('output'));
  status.setAttribute('role', 'alert');
  status.textContent = `启动失败：${String(error)}`;
});
