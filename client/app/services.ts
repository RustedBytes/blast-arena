// The long-lived parts of the client: settings, alerts, audio, art,
// the renderer, prediction and the tutorial, plus the page parameters.

import { Alerts } from '../alerts.js';
import { Assets } from '../assets.js';
import { GameAudio } from '../audio.js';
import { Particles } from '../particles.js';
import { Predictor } from '../prediction.js';
import { Renderer } from '../render.js';
import { Settings } from '../settings.js';
import { Tutorial } from '../tutorial.js';
import { ui } from './ui.js';

export const settings = new Settings();
export const alerts = new Alerts(ui.alerts);
export const audio = new GameAudio();
export const assets = new Assets();
export const particles = new Particles(2048);
export const renderer = new Renderer(ui.game, ui.minimap, assets, particles);
export const predictor = new Predictor();
export const tutorial = new Tutorial(ui.tutorial, assets, () => settings.set('tutorialDone', true));

// A persistent random token identifies this browser's profile.
export const token = (() => {
  try {
    let tok = localStorage.getItem('blast-token');
    if (!tok) {
      tok = 'randomUUID' in crypto ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem('blast-token', tok);
    }
    return tok;
  } catch {
    return '';
  }
})();
export const params = new URLSearchParams(location.search);
