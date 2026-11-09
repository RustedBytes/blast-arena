// Minimal MessagePack codec covering the types the game protocol uses:
// nil, bool, ints, floats, strings, binary, arrays and maps.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class Writer {
  constructor() {
    this.buf = new Uint8Array(128);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }

  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v) { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  u16(v) { this.ensure(2); this.view.setUint16(this.pos, v); this.pos += 2; }
  u32(v) { this.ensure(4); this.view.setUint32(this.pos, v); this.pos += 4; }
  raw(bytes) { this.ensure(bytes.length); this.buf.set(bytes, this.pos); this.pos += bytes.length; }

  header(len, fix, fixMax, c8, c16, c32) {
    if (len <= fixMax) this.u8(fix | len);
    else if (c8 !== null && len < 0x100) { this.u8(c8); this.u8(len); }
    else if (len < 0x10000) { this.u8(c16); this.u16(len); }
    else { this.u8(c32); this.u32(len); }
  }

  write(v) {
    if (v === null || v === undefined) return this.u8(0xc0);
    if (v === false) return this.u8(0xc2);
    if (v === true) return this.u8(0xc3);
    if (typeof v === 'number') return this.number(v);
    if (typeof v === 'string') {
      const bytes = textEncoder.encode(v);
      this.header(bytes.length, 0xa0, 31, 0xd9, 0xda, 0xdb);
      return this.raw(bytes);
    }
    if (v instanceof Uint8Array) {
      this.header(v.length, 0, -1, 0xc4, 0xc5, 0xc6);
      return this.raw(v);
    }
    if (Array.isArray(v)) {
      this.header(v.length, 0x90, 15, null, 0xdc, 0xdd);
      for (const item of v) this.write(item);
      return;
    }
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    this.header(keys.length, 0x80, 15, null, 0xde, 0xdf);
    for (const k of keys) {
      this.write(k);
      this.write(v[k]);
    }
  }

  number(v) {
    if (Number.isInteger(v) && Math.abs(v) <= 0xffffffff) {
      if (v >= 0) {
        if (v < 0x80) return this.u8(v);
        if (v < 0x100) { this.u8(0xcc); return this.u8(v); }
        if (v < 0x10000) { this.u8(0xcd); return this.u16(v); }
        this.u8(0xce); return this.u32(v);
      }
      if (v >= -32) return this.u8(v & 0xff);
      if (v >= -0x80) { this.u8(0xd0); this.ensure(1); this.view.setInt8(this.pos, v); this.pos += 1; return; }
      if (v >= -0x8000) { this.u8(0xd1); this.ensure(2); this.view.setInt16(this.pos, v); this.pos += 2; return; }
      if (v >= -0x80000000) { this.u8(0xd2); this.ensure(4); this.view.setInt32(this.pos, v); this.pos += 4; return; }
    }
    this.u8(0xcb);
    this.ensure(8);
    this.view.setFloat64(this.pos, v);
    this.pos += 8;
  }
}

export function encode(value) {
  const w = new Writer();
  w.write(value);
  return w.buf.subarray(0, w.pos);
}

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
