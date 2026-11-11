// Entry point of the game page: wires the parts in client/app/ together.

import { assets, audio, alerts, params, predictor, renderer, settings } from './app/services.js';
import { input } from './app/controls.js';
import { setupHud } from './app/hud.js';
import { refreshLobbyLater, setupLobby } from './app/lobby.js';
import { startLoop } from './app/loop.js';
import { net } from './app/messages.js';
import { state } from './app/session.js';
import { applyLanguage, setupSettingsUi } from './app/settings-ui.js';
import { setupView } from './app/view.js';
import { applyI18n, detectLanguage, getLanguage, setLanguage } from './i18n.js';

setLanguage(detectLanguage(settings.get('lang')));
setupView();
setupHud();
setupSettingsUi();
setupLobby();

// With ?debug, expose internals for testing from the browser console.
declare global {
  interface Window { __blast?: unknown }
}
if (params.has('debug')) {
  window.__blast = { get state() { return state; }, predictor, net, audio, input, renderer, alerts };
}

applyLanguage(getLanguage());
applyI18n();
setInterval(() => { if (!state) refreshLobbyLater(); }, 4000);
assets.load().then(startLoop, (e: unknown) => console.error('could not load the game art', e));
