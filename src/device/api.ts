/**
 * The Elektron SysEx **API** — the protocol that exposes the +Drive as a filesystem.
 *
 * This is not the dump protocol in `src/sysex/`. That one moves patterns and sounds and is
 * addressed per product (`0x0D` Digitone, `0x15` Digitone II). This one is selected by header
 * byte `0x10`, is the same on every Elektron device, and reads **whole files by path**:
 *
 *     F0 00 20 3C 10 00 <8-in-7 encoded payload> F7
 *
 * and the payload, once decoded:
 *
 *     u16be msgId      a counter the caller allocates, echoed back in the response
 *     u16be respId     0 in a request; the request's msgId in a response
 *     u8    code       0x01 Device, 0x10 DirList, 0x32 FileRead, …
 *     …             the arguments for that code
 *
 * **A response's code is the request's code + 0x80.** `buildApi id … (id + 0x80)` in elk-herd's
 * `ApiUtil.elm`, and the kind of detail that is invisible until nothing ever matches.
 *
 * ## Why this protocol and not the dump one
 *
 * `docs/ROADMAP.md` §3d flagged one thing to research first: *whether the +Drive file API lets
 * us enumerate and read whole projects over SysEx*. It does — `FileReadOpen` takes a **path**
 * and `FileRead` returns arbitrary byte ranges of it. So a device hands us a `.dn2prj`, which is
 * the exact unit every other part of DNX already works in. Nothing has to be rebuilt around
 * patterns-over-the-wire.
 *
 * ## Read-only, deliberately
 *
 * The protocol also has `FileWriteOpen`/`FileWrite`, `FileDelete`, `DirCreate`, `DirDelete` and
 * `ItemRename`. None of them are here. A first cut that can delete files off someone's +Drive is
 * a bad first cut, and nothing we want to do needs writing until reading has been proven against
 * a real device. They are named here so the gap is a decision rather than an oversight.
 *
 * ## Stateless, because WebMIDI must be multi-device
 *
 * Every function takes bytes and returns bytes. There is no module-level "the device", no open
 * connection, no ambient message counter. §3d requires two instruments held at once — a DN1 and
 * a DN2, each with its own identity, firmware and storage versions — and elk-herd is
 * single-instrument **by design**, so it is a guide to this wire format and explicitly not to the
 * session architecture above it. Keeping the codec free of connection state is what stops that
 * decision from being made here by accident.
 */

import { decode87, encode87 } from "../sysex/codec.js";

/** `F0 00 20 3C` — Elektron. Shared with the dump protocol. */
const MANUFACTURER = [0xf0, 0x00, 0x20, 0x3c] as const;

/** Header byte selecting the API rather than a per-product dump. */
export const API_SELECTOR = 0x10;

/** Follows the selector, before the encoded payload. Always zero in what we have seen. */
const API_SUBTYPE = 0x00;

const SYSEX_END = 0xf7;

/** A response carries the request's code with this bit set. */
export const RESPONSE_BIT = 0x80;

/**
 * The messages this module speaks. Read-only — see the note above about the rest.
 *
 * Codes are grouped by nibble in the protocol itself: `0x0n` device information, `0x1n`
 * directories, `0x2n` file management, `0x3n` reading, `0x4n` writing.
 */
export const Code = {
  Device: 0x01,
  Version: 0x02,
  Query: 0x09,
  DirList: 0x10,
  FileReadOpen: 0x30,
  FileReadClose: 0x31,
  FileRead: 0x32,
} as const;

export type Code = (typeof Code)[keyof typeof Code];

export class ApiError extends Error {}

// --- framing ---------------------------------------------------------------------------------

/** One decoded API message, request or response. */
export interface ApiFrame {
  msgId: number;
  /** The msgId this answers, or `undefined` when it is a request. */
  respId: number | undefined;
  code: number;
  /** Everything after the code — the arguments, still encoded. */
  body: Uint8Array;
  /** True when `code` has the response bit set. */
  isResponse: boolean;
  /**
   * True when the message ended with `0xF7`, as a complete SysEx message must.
   *
   * **False means this is a fragment, not a message.** A SysEx cut short still decodes — the 7-bit
   * unpacking has no idea it is missing an ending — so an interrupted transfer arrives looking like
   * a short but valid reply. That is how a `0x53` read answered `chunk claims 2048 bytes and
   * carries 863`: the length field and the payload disagreed because the payload had been cut, and
   * nothing upstream could say so.
   *
   * Reported rather than thrown, because the honest handling differs by caller: a reader can retry,
   * a capture wants the bytes regardless. What none of them should do is treat it as complete.
   */
  terminated: boolean;
}

/**
 * Wrap a message body as a complete SysEx message, ready for `MIDIOutput.send`.
 *
 * `msgId` is the caller's to allocate and the caller's to match: the device echoes it, and a
 * connection with two requests outstanding tells them apart by nothing else.
 */
export function encodeMessage(msgId: number, code: number, body: Uint8Array = new Uint8Array()): Uint8Array {
  if (!Number.isInteger(msgId) || msgId < 0 || msgId > 0xffff) {
    throw new ApiError(`msgId must fit in a u16, got ${msgId}`);
  }

  const payload = new Uint8Array(5 + body.length);
  payload[0] = (msgId >> 8) & 0xff;
  payload[1] = msgId & 0xff;
  payload[2] = 0; // respId: zero in a request
  payload[3] = 0;
  payload[4] = code;
  payload.set(body, 5);

  const encoded = encode87(payload);
  const out = new Uint8Array(MANUFACTURER.length + 2 + encoded.length + 1);
  out.set(MANUFACTURER, 0);
  out[MANUFACTURER.length] = API_SELECTOR;
  out[MANUFACTURER.length + 1] = API_SUBTYPE;
  out.set(encoded, MANUFACTURER.length + 2);
  out[out.length - 1] = SYSEX_END;
  return out;
}

/** True when a SysEx message is one of ours, so a port carrying clock and notes can be filtered. */
export function isApiMessage(sysex: Uint8Array): boolean {
  return (
    sysex.length >= MANUFACTURER.length + 3 &&
    MANUFACTURER.every((b, i) => sysex[i] === b) &&
    sysex[MANUFACTURER.length] === API_SELECTOR
  );
}

/** Take a complete SysEx message apart. Throws when it is not an API message. */
export function decodeMessage(sysex: Uint8Array): ApiFrame {
  if (!isApiMessage(sysex)) {
    throw new ApiError(
      `not an Elektron API message: ${[...sysex.slice(0, 6)].map(hex).join(" ")}…`,
    );
  }
  const terminated = sysex[sysex.length - 1] === SYSEX_END;
  const end = terminated ? sysex.length - 1 : sysex.length;
  const payload = decode87(sysex.subarray(MANUFACTURER.length + 2, end));
  if (payload.length < 5) {
    throw new ApiError(`API message too short: ${payload.length} bytes, need at least 5`);
  }

  const respId = (payload[2]! << 8) | payload[3]!;
  const code = payload[4]!;
  return {
    msgId: (payload[0]! << 8) | payload[1]!,
    // Zero is "no response id" rather than "message 0", which is why msgId allocation starts
    // at 1 — a request numbered 0 would be answered by something indistinguishable from a
    // request.
    respId: respId === 0 ? undefined : respId,
    code,
    body: payload.subarray(5),
    isResponse: (code & RESPONSE_BIT) !== 0,
    terminated,
  };
}

function hex(b: number | undefined): string {
  return (b ?? 0).toString(16).padStart(2, "0").toUpperCase();
}

// --- requests --------------------------------------------------------------------------------

/** Ask what the device is. The reply names it and lists every message it supports. */
export function deviceRequest(msgId: number): Uint8Array {
  return encodeMessage(msgId, Code.Device);
}

/** Ask for the firmware build and version strings. */
export function versionRequest(msgId: number): Uint8Array {
  return encodeMessage(msgId, Code.Version);
}

/**
 * Ask the device about itself by key.
 *
 * The one message in this protocol designed to be a **read**: a key goes in, a tagged value
 * comes back, and an unrecognised key answers `none` rather than failing. That makes it the safe
 * way to learn what a device can do — and, on a Digitone II, the only unexplored message we can
 * send without guessing at whether it writes something.
 *
 * Digitone II only: a Digitone 1 does not advertise 0x09.
 */
export function queryRequest(msgId: number, key: string): Uint8Array {
  return encodeMessage(msgId, Code.Query, string0(key));
}

/** List one directory of the +Drive. */
export function dirListRequest(msgId: number, path: string): Uint8Array {
  return encodeMessage(msgId, Code.DirList, string0(path));
}

/** Open a file for reading. The reply carries the handle and the total length. */
export function fileReadOpenRequest(msgId: number, path: string): Uint8Array {
  return encodeMessage(msgId, Code.FileReadOpen, string0(path));
}

/**
 * Read one chunk.
 *
 * Argument order on the wire is **length then start**, which is not the order anyone says it in.
 * Taking them in the readable order here and swapping them on the way out means a caller cannot
 * get it silently backwards — the mistake would otherwise read a valid but wrong range.
 */
export function fileReadRequest(
  msgId: number,
  fd: number,
  start: number,
  length: number,
): Uint8Array {
  const body = new Uint8Array(12);
  const view = new DataView(body.buffer);
  view.setUint32(0, fd, false);
  view.setUint32(4, length, false);
  view.setUint32(8, start, false);
  return encodeMessage(msgId, Code.FileRead, body);
}

/** Release a handle. Worth doing even after a failed read; the device has a finite supply. */
export function fileReadCloseRequest(msgId: number, fd: number): Uint8Array {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setUint32(0, fd, false);
  return encodeMessage(msgId, Code.FileReadClose, body);
}

// --- responses -------------------------------------------------------------------------------

export interface DeviceResponse {
  /**
   * The API's own product numbering, which is **not** the dump protocol's.
   *
   * elk-herd reads 12 = Digitakt and 42 = Digitakt II here; `src/sysex/devices.ts` records
   * 20 = Digitone and 43 = Digitone II. Two separate spaces for two separate protocols, and
   * conflating them is a whole afternoon.
   */
  productId: number;
  /** Every message code the device implements. Capability discovery, rather than our guessing. */
  supportedMessages: number[];
  /** Usually the model name, but elk-herd notes devices with a customised one. */
  deviceName: string;
}

export interface VersionResponse {
  /** An increasing number sent as a zero-padded four-character string. */
  build: string;
  /** For humans, e.g. `1.10E`. */
  version: string;
}

export interface DirEntry {
  hash: number;
  size: number;
  locked: boolean;
  /** A single character: `D` for a directory, `F` for a file. */
  type: string;
  name: string;
}

export interface FileReadOpenResponse {
  ok: boolean;
  fd: number;
  totalLength: number;
}

export interface FileReadResponse {
  ok: boolean;
  fd: number;
  start: number;
  end: number;
  data: Uint8Array;
}

export function readDeviceResponse(body: Uint8Array): DeviceResponse {
  const r = new Reader(body);
  const productId = r.u8();
  const supportedMessages = r.byteList();
  return { productId, supportedMessages, deviceName: r.string0() };
}

export function readVersionResponse(body: Uint8Array): VersionResponse {
  const r = new Reader(body);
  return { build: r.string0(), version: r.string0() };
}

/**
 * A query answer: a type tag, then the value.
 *
 * `none` is a real answer, and the expected one for a key the device does not recognise — which
 * is what makes probing keys safe rather than a guessing game with consequences.
 */
export type QueryValue =
  | { kind: "none" }
  | { kind: "bool"; value: boolean }
  | { kind: "int"; signed: boolean; hi: number; lo: number }
  | { kind: "string"; value: string };

export function readQueryResponse(body: Uint8Array): QueryValue {
  const r = new Reader(body);
  const tag = r.u8();
  switch (tag) {
    case 0:
      return { kind: "none" };
    case 1:
      return { kind: "bool", value: r.bool() };
    // 64-bit, as two big-endian halves. Kept as halves rather than folded into a JS number,
    // which loses precision above 2^53 — and a device reporting a size or a serial has every
    // reason to exceed it.
    case 2:
      return { kind: "int", signed: true, hi: r.u32(), lo: r.u32() };
    case 3:
      return { kind: "int", signed: false, hi: r.u32(), lo: r.u32() };
    case 4:
      return { kind: "string", value: r.string0() };
    default:
      throw new ApiError(`unknown query response type ${tag}`);
  }
}

/** How a query answer reads on screen. */
export function describeQueryValue(value: QueryValue): string {
  switch (value.kind) {
    case "none":
      return "—";
    case "bool":
      return value.value ? "true" : "false";
    case "int":
      return value.hi === 0
        ? String(value.lo)
        : `0x${value.hi.toString(16)}${value.lo.toString(16).padStart(8, "0")}`;
    case "string":
      return value.value;
  }
}

/** Every entry, to the end of the message — the response carries no count. */
export function readDirListResponse(body: Uint8Array): DirEntry[] {
  const r = new Reader(body);
  const entries: DirEntry[] = [];
  while (r.remaining > 0) {
    entries.push({
      hash: r.u32(),
      size: r.u32(),
      locked: r.bool(),
      type: String.fromCharCode(r.u8()),
      name: r.string0(),
    });
  }
  return entries;
}

export function readFileReadOpenResponse(body: Uint8Array): FileReadOpenResponse {
  const r = new Reader(body);
  return { ok: r.bool(), fd: r.u32(), totalLength: r.u32() };
}

export function readFileReadResponse(body: Uint8Array): FileReadResponse {
  const r = new Reader(body);
  const ok = r.bool();
  const fd = r.u32();
  const length = r.u32();
  const start = r.u32();
  const end = r.u32();
  const data = r.rest();

  // Checked, because `length` and the payload are two independent statements of the same fact,
  // and a chunk that is quietly short is how a truncated file gets assembled with nobody the
  // wiser until the device refuses the project weeks later.
  if (ok && data.length !== length) {
    throw new ApiError(`chunk claims ${length} bytes and carries ${data.length}`);
  }

  // `end` is deliberately **not** checked against `start + length`. Whether it is exclusive or
  // inclusive is not established - elk-herd names the field and never relies on it - and
  // asserting the wrong one would fail every read on real hardware while looking like a device
  // fault. It is carried through untouched so one session with a device can settle it.
  return { ok, fd, start, end, data };
}

// --- argument encoding -----------------------------------------------------------------------

/**
/**
 * Windows-1252, NUL-terminated. Not Latin-1, and not UTF-8.
 *
 * The two agree everywhere except 0x80-0x9F, where Latin-1 has control codes and Windows-1252
 * has typographic characters. It matters because these strings are **paths**: a filename decoded
 * wrongly is a file we then fail to open, with an error blaming the device.
 *
 * Five of those 32 positions are **undefined** in Windows-1252 - 0x81, 0x8D, 0x8F, 0x90 and
 * 0x9D. They are holes in the table, not characters, so they need placeholders here. Writing only
 * the printable ones out as a dense string shifts every code point after the first hole by one,
 * which is wrong in a way nothing notices until a filename comes back mangled.
 *
 * Written as escapes rather than literals so the table cannot be damaged by an editor or a tool
 * guessing at this file's encoding - which is exactly how it got written wrong the first time.
 */
const WIN1252_HIGH: readonly (string | undefined)[] = [
  "€", undefined, "‚", "ƒ", "„", "…", "†", "‡", // 80-87
  "ˆ", "‰", "Š", "‹", "Œ", undefined, "Ž", undefined, // 88-8F
  undefined, "‘", "’", "“", "”", "•", "–", "—", // 90-97
  "˜", "™", "š", "›", "œ", undefined, "ž", "Ÿ", // 98-9F
];

function string0(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const high = WIN1252_HIGH.indexOf(ch);
    if (high >= 0) bytes.push(0x80 + high);
    else if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else throw new ApiError(`"${ch}" (U+${code.toString(16).toUpperCase()}) is not in Windows-1252`);
  }
  bytes.push(0);
  return Uint8Array.from(bytes);
}

/** A cursor over a message body, which refuses to read past the end rather than returning zeros. */
class Reader {
  private at = 0;

  constructor(private readonly body: Uint8Array) {}

  get remaining(): number {
    return this.body.length - this.at;
  }

  private need(n: number, what: string): void {
    if (this.remaining < n) {
      throw new ApiError(`message ended while reading ${what}: wanted ${n}, had ${this.remaining}`);
    }
  }

  u8(): number {
    this.need(1, "a byte");
    return this.body[this.at++]!;
  }

  u32(): number {
    this.need(4, "a uint32");
    const v =
      ((this.body[this.at]! << 24) >>> 0) +
      (this.body[this.at + 1]! << 16) +
      (this.body[this.at + 2]! << 8) +
      this.body[this.at + 3]!;
    this.at += 4;
    return v;
  }

  bool(): boolean {
    const b = this.u8();
    if (b > 1) throw new ApiError(`not a boolean byte: ${b}`);
    return b === 1;
  }

  /** A length-prefixed run of bytes: one count byte, then that many. */
  byteList(): number[] {
    const n = this.u8();
    this.need(n, `a list of ${n} bytes`);
    const out = [...this.body.subarray(this.at, this.at + n)];
    this.at += n;
    return out;
  }

  string0(): string {
    const end = this.body.indexOf(0, this.at);
    if (end === -1) throw new ApiError("string is not NUL-terminated before the end of the message");
    let out = "";
    for (let i = this.at; i < end; i++) {
      const b = this.body[i]!;
      const mapped = b >= 0x80 && b <= 0x9f ? WIN1252_HIGH[b - 0x80] : undefined;
      if (b >= 0x80 && b <= 0x9f && mapped === undefined) {
        throw new ApiError(`byte 0x${b.toString(16)} is undefined in Windows-1252`);
      }
      out += mapped ?? String.fromCharCode(b);
    }
    this.at = end + 1;
    return out;
  }

  rest(): Uint8Array {
    const out = this.body.subarray(this.at);
    this.at = this.body.length;
    return out;
  }
}
