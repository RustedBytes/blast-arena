// Reads the binary wire format: LEB128 varints (signed ones zigzag
// encoded), length-prefixed UTF-8 strings and little-endian f64s.

const textDecoder = new TextDecoder();

export class Reader {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    if (this.pos >= this.bytes.length) throw new RangeError('protocol: truncated frame');
    return this.bytes[this.pos++];
  }

  /** Unsigned varint; plain arithmetic keeps values above 2^31 exact. */
  uvar(): number {
    let v = 0, mul = 1, b: number;
    do {
      b = this.u8();
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return v;
  }

  ivar(): number {
    const v = this.uvar();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }

  str(): string {
    const n = this.uvar();
    if (this.pos + n > this.bytes.length) throw new RangeError('protocol: truncated frame');
    const s = textDecoder.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  list<T>(n: number, item: () => T): T[] {
    const out = new Array<T>(n);
    for (let i = 0; i < n; i++) out[i] = item();
    return out;
  }
}
