// Keyboard, gamepad and touch input. Movement is sent as the newest held
// direction plus the previously held one (`s`), which the server uses for
// turn buffering: hold Right, tap Up early, and the turn happens at the next
// gap. The jump key (Space, or F with the keys swapped; see keymap.ts) is
// held state too (`j`): while it's down you hop
// over a stone pillar in front of you. The detach key (C, held) shakes off a
// sticky bomb and is held state too (`h`). Only changes are sent.

import { bombCode, jumpCode } from './keymap.js';

const KEY_DIRS: Record<string, number> = {
  ArrowUp: 1, KeyW: 1,
  ArrowRight: 2, KeyD: 2,
  ArrowDown: 3, KeyS: 3,
  ArrowLeft: 4, KeyA: 4,
};
const DEADZONE = 0.4;      // gamepad stick
const JOY_DEADZONE = 14;   // touch joystick, CSS px
const JOY_RADIUS = 60;

/** Named one-shot or held UI actions. */
export type InputAction = 'zoomReset' | 'mute' | 'fps' | 'minimap' | 'menu' | 'board' | 'emoteWheel';

export interface InputHandlers {
  onDir(d: number, s: number, j: boolean): void;
  onBomb(): void;
  onAct(): void;
  onGadget(): void;
  onAbility(): void;
  onCancel(): void;
  onEmote(e: number): void;
  onZoom(factor: number): void;
  onAction(name: InputAction, down: boolean): void;
}

/** The on-screen touch controls (shown on touch devices only). */
export interface TouchElements {
  root: HTMLElement;
  joyZone: HTMLElement;
  joyBase: HTMLElement;
  joyKnob: HTMLElement;
  bomb: HTMLElement;
  act: HTMLElement;
  jump: HTMLElement;
  gadget: HTMLElement;
  ability: HTMLElement;
  detach: HTMLElement;
  emote: HTMLElement;
}

/** The held input, read every prediction step. */
export interface HeldInput { d: number; s: number; j: boolean; h: boolean }

export class Input {
  /** Input is only read while a game is running. */
  enabled = false;
  /** The held input, read every prediction step. */
  readonly current: HeldInput = { d: 0, s: 0, j: false, h: false };
  /** Keyboard directions, most recent last. */
  private held: number[] = [];
  private padDir = 0;
  private padAlt = 0;
  private padBomb = false;
  private padJump = false;
  private padDetach = false;
  private padAbility = false;
  private padAct = false;
  private padGadget = false;
  private keyJump = false;
  private keyDetach = false;
  private joyDir = 0;
  private joyAlt = 0;
  private joyJump = false;
  private joyDetach = false;
  /** The last input reported, packed (see update()). */
  private sent = -1;

  constructor(private readonly h: InputHandlers, private readonly touch: TouchElements) {
    addEventListener('keydown', (e) => this.keydown(e));
    addEventListener('keyup', (e) => this.keyup(e));
    addEventListener('blur', () => this.clear());
    addEventListener('wheel', (e) => {
      if (!this.enabled || (e.target instanceof Element && e.target.closest('#settings'))) return;
      e.preventDefault();
      this.h.onZoom(Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    this.setupTouch();
  }

  private keydown(e: KeyboardEvent): void {
    if (!this.enabled || e.target instanceof HTMLInputElement) return;
    const d = KEY_DIRS[e.code];
    if (d) {
      e.preventDefault();
      if (!this.held.includes(d)) this.held.push(d);
      this.update();
      return;
    }
    // F and Space can be swapped in the settings.
    const code = e.code === bombCode() ? 'bomb' : e.code === jumpCode() ? 'jump' : e.code;
    switch (code) {
      case 'jump':
        e.preventDefault();
        if (!this.keyJump) { this.keyJump = true; this.update(); }
        break;
      case 'bomb': case 'Enter':
        e.preventDefault();
        if (!e.repeat) this.h.onBomb();
        break;
      case 'KeyE': case 'ShiftLeft': case 'ShiftRight':
        if (!e.repeat) this.h.onAct();
        break;
      case 'KeyQ':
        if (!e.repeat) this.h.onGadget();
        break;
      case 'KeyR':
        if (!e.repeat) this.h.onAbility();
        break;
      case 'KeyX':
        if (!e.repeat) this.h.onCancel();
        break;
      case 'KeyC':
        if (!this.keyDetach) { this.keyDetach = true; this.update(); }
        break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
      case 'Digit5': case 'Digit6': case 'Digit7': case 'Digit8':
        if (!e.repeat) this.h.onEmote(Number(e.code.slice(5)) - 1);
        break;
      case 'Equal': case 'NumpadAdd': this.h.onZoom(1.15); break;
      case 'Minus': case 'NumpadSubtract': this.h.onZoom(1 / 1.15); break;
      case 'Digit0': case 'Numpad0': this.h.onAction('zoomReset', true); break;
      case 'KeyM': this.h.onAction('mute', true); break;
      case 'KeyP': this.h.onAction('fps', true); break;
      case 'KeyN': this.h.onAction('minimap', true); break;
      case 'Escape': this.h.onAction('menu', true); break;
      case 'Tab': e.preventDefault(); this.h.onAction('board', true); break;
    }
  }

  private keyup(e: KeyboardEvent): void {
    const d = KEY_DIRS[e.code];
    if (d) {
      this.held = this.held.filter((x) => x !== d);
      this.update();
    } else if (e.code === jumpCode()) {
      this.keyJump = false;
      this.update();
    } else if (e.code === 'KeyC') {
      this.keyDetach = false;
      this.update();
    } else if (e.code === 'Tab') {
      this.h.onAction('board', false);
    }
  }

  clear(): void {
    this.held.length = 0;
    this.joyDir = this.joyAlt = 0;
    this.padDir = this.padAlt = 0;
    this.keyJump = this.padJump = this.joyJump = false;
    this.keyDetach = this.padDetach = this.joyDetach = false;
    this.update();
  }

  /** Picks the active source (touch > gamepad > keyboard) and sends changes. */
  private update(): void {
    let d: number, s: number;
    if (this.joyDir) { d = this.joyDir; s = this.joyAlt; }
    else if (this.padDir) { d = this.padDir; s = this.padAlt; }
    else {
      const n = this.held.length;
      d = n ? this.held[n - 1] : 0;
      s = n > 1 ? this.held[n - 2] : 0;
    }
    const j = this.keyJump || this.padJump || this.joyJump;
    const h = this.keyDetach || this.padDetach || this.joyDetach;
    this.current.d = d;
    this.current.s = s;
    this.current.j = j;
    this.current.h = h;
    const key = (d << 3 | s) | (j ? 64 : 0) | (h ? 128 : 0);
    if (key !== this.sent) {
      this.sent = key;
      this.h.onDir(d, s, j);
    }
  }

  /** Call once per frame: reads connected gamepads. */
  pollGamepad(): void {
    if (!this.enabled || !('getGamepads' in navigator)) return;
    let dir = 0, alt = 0, bomb = false, act = false, jump = false, gadget = false, zoom = 0, ability = false, detach = false;
    for (const gp of navigator.getGamepads()) {
      if (!gp) continue;
      const b = (i: number): boolean => gp.buttons[i]?.pressed ?? false;
      const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
      if (b(12)) dir = 1; else if (b(15)) dir = 2; else if (b(13)) dir = 3; else if (b(14)) dir = 4;
      else if (Math.abs(ax) > DEADZONE || Math.abs(ay) > DEADZONE) {
        const [major, minor] = Math.abs(ax) > Math.abs(ay) ? [ax > 0 ? 2 : 4, ay] : [ay > 0 ? 3 : 1, ax];
        dir = major;
        if (Math.abs(minor) > DEADZONE * 0.75) alt = Math.abs(ax) > Math.abs(ay) ? (ay > 0 ? 3 : 1) : (ax > 0 ? 2 : 4);
      }
      bomb ||= b(0);
      gadget ||= b(1);
      act ||= b(2);
      jump ||= b(3);
      detach ||= b(6);
      ability ||= b(7);
      if (b(5)) zoom = 1; else if (b(4)) zoom = -1;
      break; // first connected pad only
    }
    if (bomb && !this.padBomb) this.h.onBomb();
    this.padBomb = bomb;
    if (act && !this.padAct) this.h.onAct();
    this.padAct = act;
    if (gadget && !this.padGadget) this.h.onGadget();
    this.padGadget = gadget;
    if (ability && !this.padAbility) this.h.onAbility();
    this.padAbility = ability;
    if (detach !== this.padDetach) { this.padDetach = detach; this.update(); }
    if (zoom) this.h.onZoom(zoom > 0 ? 1.02 : 1 / 1.02);
    if (dir !== this.padDir || alt !== this.padAlt || jump !== this.padJump) {
      this.padDir = dir;
      this.padAlt = alt;
      this.padJump = jump;
      this.update();
    }
  }

  private setupTouch(): void {
    const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!isTouch) return;
    document.body.classList.add('touch');
    const { root, joyZone: zone, joyBase: base, joyKnob: knob } = this.touch;
    root.classList.remove('hidden');
    let joyId: number | null = null, ox = 0, oy = 0;
    const pinch = new Map<number, PointerEvent>();
    let pinchDist = 0;

    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pinch.set(e.pointerId, e);
      if (pinch.size === 2) {
        // Two fingers: pinch zoom instead of steering.
        const [a, b] = [...pinch.values()];
        pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        joyId = null;
        base.classList.add('hidden');
        this.joyDir = this.joyAlt = 0;
        this.update();
        return;
      }
      try { zone.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      joyId = e.pointerId;
      ox = e.clientX; oy = e.clientY;
      base.style.left = `${ox}px`; base.style.top = `${oy}px`;
      knob.style.transform = 'translate(-50%, -50%)';
      base.classList.remove('hidden');
    });
    zone.addEventListener('pointermove', (e) => {
      if (pinch.has(e.pointerId)) pinch.set(e.pointerId, e);
      if (pinch.size === 2) {
        const [a, b] = [...pinch.values()];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (pinchDist > 0) this.h.onZoom(d / pinchDist);
        pinchDist = d;
        return;
      }
      if (e.pointerId !== joyId) return;
      let dx = e.clientX - ox, dy = e.clientY - oy;
      const len = Math.hypot(dx, dy);
      if (len > JOY_RADIUS) { dx *= JOY_RADIUS / len; dy *= JOY_RADIUS / len; }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      let d = 0, s = 0;
      if (len > JOY_DEADZONE) {
        const horiz = Math.abs(dx) > Math.abs(dy);
        d = horiz ? (dx > 0 ? 2 : 4) : (dy > 0 ? 3 : 1);
        const minor = horiz ? dy : dx;
        if (Math.abs(minor) > JOY_DEADZONE) s = horiz ? (dy > 0 ? 3 : 1) : (dx > 0 ? 2 : 4);
      }
      if (d !== this.joyDir || s !== this.joyAlt) {
        this.joyDir = d;
        this.joyAlt = s;
        this.update();
      }
    });
    const end = (e: PointerEvent): void => {
      pinch.delete(e.pointerId);
      if (pinch.size < 2) pinchDist = 0;
      if (e.pointerId !== joyId) return;
      joyId = null;
      base.classList.add('hidden');
      this.joyDir = this.joyAlt = 0;
      this.update();
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    const bomb = this.touch.bomb;
    bomb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bomb.classList.add('active');
      vibrate(15);
      this.h.onBomb();
    });
    const up = () => bomb.classList.remove('active');
    bomb.addEventListener('pointerup', up);
    bomb.addEventListener('pointercancel', up);

    const act = this.touch.act;
    act.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      vibrate(10);
      this.h.onAct();
    });
    const jumpBtn = this.touch.jump;
    jumpBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      vibrate(10);
      jumpBtn.classList.add('active');
      this.joyJump = true;
      this.update();
    });
    const jumpUp = () => {
      jumpBtn.classList.remove('active');
      this.joyJump = false;
      this.update();
    };
    jumpBtn.addEventListener('pointerup', jumpUp);
    jumpBtn.addEventListener('pointercancel', jumpUp);
    jumpBtn.addEventListener('pointerleave', jumpUp);
    this.touch.gadget.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      vibrate(10);
      this.h.onGadget();
    });
    this.touch.ability.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      vibrate(10);
      this.h.onAbility();
    });
    // Shaking off a sticky bomb: hold the button.
    const detachBtn = this.touch.detach;
    detachBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      vibrate(10);
      detachBtn.classList.add('active');
      this.joyDetach = true;
      this.update();
    });
    const detachUp = () => {
      detachBtn.classList.remove('active');
      this.joyDetach = false;
      this.update();
    };
    detachBtn.addEventListener('pointerup', detachUp);
    detachBtn.addEventListener('pointercancel', detachUp);
    detachBtn.addEventListener('pointerleave', detachUp);
    this.touch.emote.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.h.onAction('emoteWheel', true);
    });
  }
}

/** A short buzz on phones that support it (not iOS Safari). */
function vibrate(ms: number): void {
  if ('vibrate' in navigator) navigator.vibrate(ms);
}
