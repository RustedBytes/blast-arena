// Compact binary wire protocol; mirrors src/protocol.rs (see there for the
// full layout). Every frame starts with a one-byte opcode; integers are
// LEB128 varints (signed ones zigzag encoded), strings are a varint length
// plus UTF-8, floats are little-endian f64. Snapshots are deltas against a
// snapshot this client acknowledged, so decoding one needs that base.
// The parts live in client/protocol/.

export * from './protocol/constants.js';
export * from './protocol/types.js';
export { decodeServer } from './protocol/decode.js';
export { encodeClient } from './protocol/encode.js';
export { meObject } from './protocol/snapshot.js';
