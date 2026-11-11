// Small DOM helpers shared by the client modules. Lookups check what they
// find, so a renamed id or a changed tag fails loudly at the call site
// instead of as a `null` deep inside the game.

/** An element class such as `HTMLInputElement`, used for runtime checks. */
type ElementClass<T extends Element> = abstract new (...args: never[]) => T;

/** The element with this id, which must be a `type` (any `HTMLElement` by default). */
export function byId(id: string): HTMLElement;
export function byId<T extends Element>(id: string, type: ElementClass<T>): T;
export function byId(id: string, type: ElementClass<Element> = HTMLElement): Element {
  const el = document.getElementById(id);
  if (el instanceof type) return el;
  throw new Error(`#${id}: expected a ${type.name}, found ${describe(document.getElementById(id))}`);
}

/** The first element under `root` matching `selector`, which must be a `type`. */
export function query(root: ParentNode, selector: string): HTMLElement;
export function query<T extends Element>(root: ParentNode, selector: string, type: ElementClass<T>): T;
export function query(root: ParentNode, selector: string, type: ElementClass<Element> = HTMLElement): Element {
  const el = root.querySelector(selector);
  if (el instanceof type) return el;
  throw new Error(`${selector}: expected a ${type.name}, found ${describe(root.querySelector(selector))}`);
}

const describe = (el: Element | null): string => (el ? `<${el.tagName.toLowerCase()}>` : 'nothing');

/** The closest ancestor-or-self of an event target matching `selector`, if any. */
export function closest<T extends Element>(target: EventTarget | null, selector: string, type: ElementClass<T>): T | null {
  const el = target instanceof Element ? target.closest(selector) : null;
  return el instanceof type ? el : null;
}

/** The 2D context of a canvas; browsers only fail this when out of memory. */
export function context2d(canvas: HTMLCanvasElement, options?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', options);
  if (!ctx) throw new Error('canvas 2D context unavailable');
  return ctx;
}

/** A new canvas of the given size (square when `height` is left out). */
export function makeCanvas(width: number, height = width): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** Sets the text of an element's last child node (the label after an icon). */
export function setTrailingText(el: Element, text: string): void {
  const last = el.lastChild;
  if (last) last.textContent = text;
  else el.textContent = text;
}

/** Runs a promise for its side effects, logging (not throwing) a failure. */
export function fireAndForget(promise: Promise<unknown>, what: string): void {
  promise.catch((e: unknown) => console.warn(`${what} failed`, e));
}

/** Text made safe to put in HTML. */
export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
