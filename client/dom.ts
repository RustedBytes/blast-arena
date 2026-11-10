// Small DOM helpers shared by the client modules.

/** The element with this id; the pages always contain the ids the client asks for. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}
