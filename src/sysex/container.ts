/**
 * Elektron SysEx dump container: framing, header fields, checksum and length.
 *
 * Byte layout of a single message:
 *
 *   0        F0                      SysEx start
 *   1..3     00 20 3C                Elektron manufacturer ID
 *   4        <productId>             0x0D = Digitone, 0x15 = Digitone II
 *   5        <devId>                 device/unit ID, 0x00 in every dump seen
 *   6        <dumpType>              0x53 = Sound, 0x50 = Pattern+Kit
 *   7..8     01 01                   container version
 *   9        <objNr>                 slot number (sound 0..127 within a bank)
 *   10..n-6  <payload>               8-in-7 encoded
 *   n-5..n-4 <checksum>              low 14 bits of the sum of the ENCODED payload
 *   n-3..n-2 <length>                (total - 10), low 14 bits — wraps for big dumps
 *   n-1      F7                      SysEx end
 *
 * Both 14-bit fields are stored MSB-first as two 7-bit bytes.
 */

import { decode87, encode87 } from "./codec.js";
import { ELEKTRON_MANUFACTURER_ID } from "./devices.js";

export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;

/** Offset at which the encoded payload begins. */
export const PAYLOAD_START = 0x0a;
/** Bytes occupied by checksum (2) + length (2) + F7 (1). */
export const TRAILER_LENGTH = 5;

export interface SysExMessage {
  /** Index of this message within the source file. */
  index: number;
  /** Byte offset of the F0 within the source file. */
  fileOffset: number;
  productId: number;
  devId: number;
  dumpType: number;
  /** Container version bytes at offsets 7..8, normally [1, 1]. */
  version: readonly [number, number];
  objNr: number;
  /** Payload as it appears on the wire, still 8-in-7 encoded. */
  encodedPayload: Uint8Array;
  /** Payload after 8-in-7 unpacking. This is the data you want to parse. */
  payload: Uint8Array;
  /** Checksum as stored in the message. */
  storedChecksum: number;
  /** Checksum recomputed from `encodedPayload`. */
  computedChecksum: number;
  /** Length field as stored in the message. */
  storedLength: number;
  /** Length recomputed from the message size. */
  computedLength: number;
  /** Total byte length of the message including F0 and F7. */
  byteLength: number;
}

export class SysExParseError extends Error {}

function read14(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! & 0x7f) << 7) | (bytes[at + 1]! & 0x7f);
}

function write14(out: Uint8Array, at: number, value: number): void {
  const v = value & 0x3fff;
  out[at] = (v >> 7) & 0x7f;
  out[at + 1] = v & 0x7f;
}

/** Low 14 bits of the plain sum of the encoded payload bytes. */
export function checksum(encodedPayload: Uint8Array): number {
  let sum = 0;
  for (const b of encodedPayload) sum += b;
  return sum & 0x3fff;
}

/**
 * Split a raw .syx file into individual messages.
 *
 * Bytes between an F7 and the next F0 are skipped rather than treated as an error,
 * since some capture tools pad or interleave timing bytes.
 */
export function splitMessages(data: Uint8Array): Uint8Array[] {
  const messages: Uint8Array[] = [];
  let i = 0;
  while (i < data.length) {
    const start = data.indexOf(SYSEX_START, i);
    if (start === -1) break;
    const end = data.indexOf(SYSEX_END, start + 1);
    if (end === -1) {
      throw new SysExParseError(
        `Unterminated SysEx message starting at byte ${start}: no F7 before end of file`,
      );
    }
    messages.push(data.subarray(start, end + 1));
    i = end + 1;
  }
  return messages;
}

/** Parse one complete F0..F7 message. Does not throw on bad checksum — compare the fields. */
export function parseMessage(raw: Uint8Array, index = 0, fileOffset = 0): SysExMessage {
  if (raw.length < PAYLOAD_START + TRAILER_LENGTH) {
    throw new SysExParseError(`Message ${index} is too short to be a dump (${raw.length} bytes)`);
  }
  if (raw[0] !== SYSEX_START || raw[raw.length - 1] !== SYSEX_END) {
    throw new SysExParseError(`Message ${index} is not delimited by F0..F7`);
  }
  for (let i = 0; i < ELEKTRON_MANUFACTURER_ID.length; i++) {
    if (raw[1 + i] !== ELEKTRON_MANUFACTURER_ID[i]) {
      throw new SysExParseError(
        `Message ${index} is not an Elektron dump (manufacturer ID ` +
          `${[...raw.subarray(1, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ")})`,
      );
    }
  }

  const encodedPayload = raw.subarray(PAYLOAD_START, raw.length - TRAILER_LENGTH);

  return {
    index,
    fileOffset,
    productId: raw[4]!,
    devId: raw[5]!,
    dumpType: raw[6]!,
    version: [raw[7]!, raw[8]!] as const,
    objNr: raw[9]!,
    encodedPayload,
    payload: decode87(encodedPayload),
    storedChecksum: read14(raw, raw.length - 5),
    computedChecksum: checksum(encodedPayload),
    storedLength: read14(raw, raw.length - 3),
    computedLength: (raw.length - 10) & 0x3fff,
    byteLength: raw.length,
  };
}

export function isChecksumValid(msg: SysExMessage): boolean {
  return msg.storedChecksum === msg.computedChecksum;
}

export function isLengthValid(msg: SysExMessage): boolean {
  return msg.storedLength === msg.computedLength;
}

export interface BuildOptions {
  productId: number;
  dumpType: number;
  /** Raw (already unpacked) payload; it is 8-in-7 encoded during the build. */
  payload: Uint8Array;
  devId?: number;
  version?: readonly [number, number];
  objNr?: number;
}

/** Build a complete message, computing the checksum and length fresh. */
export function buildMessage(opts: BuildOptions): Uint8Array {
  const { productId, dumpType, payload, devId = 0, version = [1, 1], objNr = 0 } = opts;
  const encoded = encode87(payload);
  const total = PAYLOAD_START + encoded.length + TRAILER_LENGTH;
  const out = new Uint8Array(total);

  out[0] = SYSEX_START;
  out.set(ELEKTRON_MANUFACTURER_ID, 1);
  out[4] = productId;
  out[5] = devId;
  out[6] = dumpType;
  out[7] = version[0]!;
  out[8] = version[1]!;
  out[9] = objNr;
  out.set(encoded, PAYLOAD_START);

  write14(out, total - 5, checksum(encoded));
  write14(out, total - 3, total - 10);
  out[total - 1] = SYSEX_END;
  return out;
}

/** Re-emit a parsed message byte-for-byte. Used to prove round-trip fidelity. */
export function rebuildMessage(msg: SysExMessage): Uint8Array {
  return buildMessage({
    productId: msg.productId,
    dumpType: msg.dumpType,
    payload: msg.payload,
    devId: msg.devId,
    version: msg.version,
    objNr: msg.objNr,
  });
}

/** Parse every message in a .syx file. */
export function parseFile(data: Uint8Array): SysExMessage[] {
  const messages: Uint8Array[] = [];
  const offsets: number[] = [];
  let i = 0;
  while (i < data.length) {
    const start = data.indexOf(SYSEX_START, i);
    if (start === -1) break;
    const end = data.indexOf(SYSEX_END, start + 1);
    if (end === -1) {
      throw new SysExParseError(
        `Unterminated SysEx message starting at byte ${start}: no F7 before end of file`,
      );
    }
    messages.push(data.subarray(start, end + 1));
    offsets.push(start);
    i = end + 1;
  }
  return messages.map((m, idx) => parseMessage(m, idx, offsets[idx]!));
}
