// The frame loop: prediction, camera, drawing and the performance readout.

import { input, sendInput } from './controls.js';
import { updateRoyaleHud, updateStatusAlerts } from './hud.js';
import { net } from './messages.js';
import { audio, particles, predictor, renderer, tutorial } from './services.js';
import { state } from './session.js';
import { isDraggingLook, stopLooking } from './view.js';
import { ui } from './ui.js';

// ----------------------------------------------------------------- loop

let last = performance.now();
let perfTime = 0, perfFrames = 0, perfWork = 0;
predictor.onJump = () => audio.jump();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  input.pollGamepad();
  particles.update(dt);
  if (!state || state.snaps.len === 0) return;
  const t0 = performance.now();

  // Inputs (and snapshot acks) go out at 20 Hz even while dead.
  predictor.update(dt, input.current, state, sendInput);
  // Ease the remote interpolation delay toward its target (a few % time
  // stretch, invisible) so a jitter spike never makes things jump.
  const dd = state.interpTarget - state.interpDelay;
  state.interpDelay += Math.sign(dd) * Math.min(Math.abs(dd), dt * (dd > 0 ? 2 : 0.6));
  // Local player: predicted. Dead: the camera follows whoever we watch.
  if (state.me?.alive && predictor.active) {
    const px = state.self.x, py = state.self.y;
    predictor.render(state.self, input.current, state, dt);
    state.selfJump = predictor.jumpDir;
    tutorial.notify('moved', Math.abs(state.self.x - px) + Math.abs(state.self.y - py));
    state.focus.x = state.self.x;
    state.focus.y = state.self.y;
  } else if (state.me && !state.me.alive && (state.me.spec || state.replay)) {
    // Dead: watch whoever got you (in the replay too), or your own last moments.
    const f = renderer.frame;
    const watch = state.replay ? (state.me.killer ?? state.myId) : state.me.spec;
    for (let i = 0; i < f.nPlayers; i++) {
      if (f.players[i].id === watch) {
        const k = 1 - Math.exp(-dt * 6);
        state.focus.x += (f.players[i].x - state.focus.x) * k;
        state.focus.y += (f.players[i].y - state.focus.y) * k;
      }
    }
  }
  // Watching another part of the map: the camera glides there (and
  // follows the pointer while dragging); moving or jumping comes back,
  // gliding home from wherever the view was.
  if (state.look && !state.replay) {
    if (input.current.d || input.current.j) stopLooking();
    else {
      // The view has a camera of its own (`lookFrom`): the focus is put
      // back on the player every frame, so it can't glide by itself. A
      // fresh look starts the camera where the view is now.
      if (state.lookBlend < 1 || !state.lookFrom) state.lookFrom = { x: state.focus.x, y: state.focus.y };
      const k = isDraggingLook() ? 1 : 1 - Math.exp(-dt * 10);
      state.lookFrom.x += (state.look.x - state.lookFrom.x) * k;
      state.lookFrom.y += (state.look.y - state.lookFrom.y) * k;
      state.focus.x = state.lookFrom.x;
      state.focus.y = state.lookFrom.y;
      state.lookBlend = 1;
    }
  }
  if (!state.look && state.lookBlend > 0 && state.lookFrom) {
    state.lookBlend = Math.max(0, state.lookBlend - dt * 5);
    const b = state.lookBlend * state.lookBlend;
    state.focus.x += (state.lookFrom.x - state.focus.x) * b;
    state.focus.y += (state.lookFrom.y - state.focus.y) * b;
  }
  state.zoom += (state.zoomTarget - state.zoom) * (1 - Math.exp(-dt * 12));
  renderer.draw(state, now, dt);
  updateStatusAlerts(now);

  perfWork += performance.now() - t0;
  perfFrames++;
  perfTime += dt;
  if (perfTime >= 0.5) {
    const fps = perfFrames / perfTime;
    const el = ui.hud.fps;
    el.textContent = `${Math.round(fps)} FPS · ${(perfWork / perfFrames).toFixed(1)} ms · ${Math.round(state.interpDelay * state.tickMs)} ms buf`;
    el.classList.toggle('slow', fps < 50);
    updateRoyaleHud(now);
    ui.hud.netInfo.textContent = `ping ${net.ping} ms · ${(net.bytesIn / 1024 / perfTime).toFixed(1)} KB/s · ${particles.count} fx`;
    net.bytesIn = 0;
    perfTime = perfFrames = perfWork = 0;
  }
}

/** Starts drawing frames. */
export function startLoop(): void {
  requestAnimationFrame(frame);
}
