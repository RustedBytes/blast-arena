// Minimal MessagePack decoder for the welcome message body (the only
// MessagePack left in the protocol): nil, bool, ints, floats, strings,
// binary, arrays and maps.

const textDecoder = new TextDecoder();

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }

  u8() { return this.view.getUint8(this.pos++); }
  u16() { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }

  str(len) {
    const s = textDecoder.decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  bin(len) {
    const b = this.bytes.slice(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }

  array(len) {
    const out = new Array(len);
    for (let i = 0; i < len; i++) out[i] = this.read();
    return out;
  }

  map(len) {
    const out = {};
    for (let i = 0; i < len; i++) {
      const k = this.read();
      out[k] = this.read();
    }
    return out;
  }

  ext(len) {
    this.pos += 1 + len; // type byte + payload; the protocol never sends ext
    return null;
  }

  read() {
    const b = this.u8();
    if (b < 0x80) return b;
    if (b < 0x90) return this.map(b & 0x0f);
    if (b < 0xa0) return this.array(b & 0x0f);
    if (b < 0xc0) return this.str(b & 0x1f);
    if (b >= 0xe0) return b - 0x100;
    const v = this.view;
    let r;
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return this.bin(this.u8());
      case 0xc5: return this.bin(this.u16());
      case 0xc6: return this.bin(this.u32());
      case 0xc7: return this.ext(this.u8());
      case 0xc8: return this.ext(this.u16());
      case 0xc9: return this.ext(this.u32());
      case 0xca: r = v.getFloat32(this.pos); this.pos += 4; return r;
      case 0xcb: r = v.getFloat64(this.pos); this.pos += 8; return r;
      case 0xcc: return this.u8();
      case 0xcd: return this.u16();
      case 0xce: return this.u32();
      case 0xcf: r = Number(v.getBigUint64(this.pos)); this.pos += 8; return r;
      case 0xd0: r = v.getInt8(this.pos); this.pos += 1; return r;
      case 0xd1: r = v.getInt16(this.pos); this.pos += 2; return r;
      case 0xd2: r = v.getInt32(this.pos); this.pos += 4; return r;
      case 0xd3: r = Number(v.getBigInt64(this.pos)); this.pos += 8; return r;
      case 0xd4: return this.ext(1);
      case 0xd5: return this.ext(2);
      case 0xd6: return this.ext(4);
      case 0xd7: return this.ext(8);
      case 0xd8: return this.ext(16);
      case 0xd9: return this.str(this.u8());
      case 0xda: return this.str(this.u16());
      case 0xdb: return this.str(this.u32());
      case 0xdc: return this.array(this.u16());
      case 0xdd: return this.array(this.u32());
      case 0xde: return this.map(this.u16());
      case 0xdf: return this.map(this.u32());
      default: throw new Error(`msgpack: unknown type byte 0x${b.toString(16)}`);
    }
  }
}

export function decode(bytes) {
  return new Reader(bytes).read();
}
