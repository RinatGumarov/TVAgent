/** ISOLATED world, document_idle. */
import { start } from '../content/panel.ts';
import { toggle } from '../content/panel-mount.js';

if (!window.__tvAgentPanelLoaded) {
  window.__tvAgentPanelLoaded = true;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'toggle-panel') toggle();
  });

  start();
}
