// Player input: keyboard, gamepad and touch actions sent to the server.

import { byId as $ } from '../dom.js';
import { Input } from '../input.js';
import { net } from './messages.js';
import { predictor, settings, tutorial } from './services.js';
import { state } from './session.js';
import { toggleSettings } from './settings-ui.js';
import { setZoom, stopLooking } from './view.js';

export const input = new Input({
  // Send a changed direction immediately instead of at the next 50 ms step.
  onDir: () => { if (state) predictor.inputChanged(input.current, sendInput); },
  onBomb: () => {
    stopLooking();
    net.send({ t: 'bomb' });
  },
  onAct: () => { stopLooking(); net.send({ t: 'act' }); },
  onGadget: () => { stopLooking(); net.send({ t: 'gadget' }); },
  onAbility: () => { stopLooking(); net.send({ t: 'ability' }); },
  onCancel: () => net.send({ t: 'cancel' }),
  onEmote: (e) => sendEmote(e),
  onZoom: (factor) => {
    setZoom((state?.zoomTarget ?? settings.get('zoom')) * factor);
    tutorial.notify('zoom');
  },
  onAction(name, down) {
    if (name === 'board') $('leaderboard').classList.toggle('expanded', down);
    else if (name === 'mute') settings.set('muted', !settings.get('muted'));
    else if (name === 'fps') settings.set('showFps', !settings.get('showFps'));
    else if (name === 'minimap') settings.set('showMinimap', !settings.get('showMinimap'));
    else if (name === 'zoomReset') setZoom(1);
    else if (name === 'menu') toggleSettings();
    else $('emote-wheel').classList.toggle('hidden'); // 'emoteWheel'
  },
});

// Every input message also acknowledges the newest decoded snapshot (`k`),
// which the server uses as the base for delta snapshots.
export const sendInput = (d: number, s: number, j: boolean, q: number): void => net.send({ t: 'in', d, s, j, h: input.current.h, q, k: state?.lastK ?? 0 });

export function sendEmote(e: number): void {
  net.send({ t: 'emote', e });
  $('emote-wheel').classList.add('hidden');
}
