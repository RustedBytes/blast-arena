// Which key drops a bomb (or fires a rocket) and which one jumps: F and
// Space by default, or swapped (the `bombKey` setting). Enter always drops
// a bomb too.

export type BombKey = 'f' | 'space';

let bombKey: BombKey = 'f';

export const isBombKey = (v: unknown): v is BombKey => v === 'f' || v === 'space';

export function setBombKey(k: BombKey): void {
  bombKey = k;
}

/** The `KeyboardEvent.code` of the bomb key. */
export function bombCode(): string {
  return bombKey === 'space' ? 'Space' : 'KeyF';
}

/** The `KeyboardEvent.code` of the jump key. */
export function jumpCode(): string {
  return bombKey === 'space' ? 'KeyF' : 'Space';
}

/** Key cap labels: 'F' or 'Space'. */
export function bombLabel(): string {
  return bombKey === 'space' ? 'Space' : 'F';
}

export function jumpLabel(): string {
  return bombKey === 'space' ? 'F' : 'Space';
}
