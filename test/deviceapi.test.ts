import assert from "node:assert/strict";
import { test } from "node:test";
import { decode87, encode87 } from "../src/sysex/codec.js";
import {
  API_SELECTOR,
  ApiError,
  Code,
  RESPONSE_BIT,
  decodeMessage,
  deviceRequest,
  dirListRequest,
  encodeMessage,
  fileReadCloseRequest,
  fileReadOpenRequest,
  fileReadRequest,
  isApiMessage,
  readDeviceResponse,
  readDirListResponse,
  readFileReadOpenResponse,
  readFileReadResponse,
  readVersionResponse,
  versionRequest,
} from "../src/device/api.js";

/**
 * Build a response the way a device would, so the readers are tested against bytes rather than
 * against our own encoder.
 *
 * This is the `fixtures-must-not-come-from-the-code-under-test` rule at the wire level. Nothing
 * here calls `encodeMessage`: the payload is assembled by hand and only the shared 8-in-7 codec
 * is reused, because that one is separately tested against real Digitone dumps.
 */
function deviceSays(respId: number, code: number, ...body: number[]): Uint8Array {
  const payload = Uint8Array.from([
    0x00, 0x63, // the device's own msgId, arbitrary
    (respId >> 8) & 0xff, respId & 0xff,
    code | RESPONSE_BIT,
    ...body,
  ]);
  const encoded = encode87(payload);
  return Uint8Array.from([0xf0, 0x00, 0x20, 0x3c, API_SELECTOR, 0x00, ...encoded, 0xf7]);
}

/** A NUL-terminated Windows-1252 string, as bytes. */
const str = (text: string): number[] => [...text].map((c) => c.charCodeAt(0)).concat(0);

const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

// --- framing ---------------------------------------------------------------------------------

test("a request is framed as an Elektron API message", () => {
  // Checked against the framing arithmetic rather than against our own decoder: F0, the three
  // manufacturer bytes, the API selector, the subtype, and F7 at the end.
  const bytes = deviceRequest(1);
  assert.deepEqual([...bytes.slice(0, 6)], [0xf0, 0x00, 0x20, 0x3c, 0x10, 0x00]);
  assert.equal(bytes[bytes.length - 1], 0xf7);
});

test("the payload is msgId, respId, code — and respId is zero in a request", () => {
  // Hand-decoded rather than round-tripped. A request whose respId were non-zero would be read
  // by the device as an answer to something it never asked.
  const bytes = dirListRequest(0x1234, "/");
  const payload = decode87(bytes.subarray(6, bytes.length - 1));
  assert.deepEqual([...payload.slice(0, 5)], [0x12, 0x34, 0x00, 0x00, Code.DirList]);
  assert.deepEqual([...payload.slice(5)], str("/"));
});

test("every byte on the wire is seven-bit clean", () => {
  // The whole reason the 8-in-7 codec exists. One high bit anywhere between F0 and F7 and the
  // device discards the message, or worse, resynchronises somewhere unexpected.
  const bytes = fileReadRequest(7, 0xdeadbeef, 0xfffff0, 0x8000);
  for (let i = 1; i < bytes.length - 1; i++) {
    assert.ok(bytes[i]! < 0x80, `byte ${i} is 0x${bytes[i]!.toString(16)}, not 7-bit clean`);
  }
});

test("a message survives its own round trip", () => {
  const frame = decodeMessage(fileReadOpenRequest(42, "/projects/JAM.dn2prj"));
  assert.equal(frame.msgId, 42);
  assert.equal(frame.respId, undefined, "a request answers nothing");
  assert.equal(frame.code, Code.FileReadOpen);
  assert.equal(frame.isResponse, false);
});

test("a response is recognised by its code and carries the id it answers", () => {
  // The detail that is invisible until nothing ever matches: a response's code is the request's
  // code plus 0x80. Get it wrong and every reply looks like an unknown message.
  const frame = decodeMessage(deviceSays(42, Code.Device, 20, 0x00, ...str("Digitone II")));
  assert.equal(frame.isResponse, true);
  assert.equal(frame.code, Code.Device | RESPONSE_BIT);
  assert.equal(frame.respId, 42, "the reply must name the request it answers");
});

test("messages from other manufacturers and other protocols are not ours", () => {
  // A MIDI port carries clock, notes and every other device's SysEx. Reading someone else's
  // bytes as an API frame is how a decoder produces confident nonsense.
  assert.equal(isApiMessage(Uint8Array.from([0xf0, 0x43, 0x00, 0x00, 0xf7])), false, "Yamaha");
  assert.equal(
    isApiMessage(Uint8Array.from([0xf0, 0x00, 0x20, 0x3c, 0x15, 0x00, 0xf7])),
    false,
    "an Elektron dump for the DN2 is a different protocol, not an API message",
  );
  assert.equal(isApiMessage(deviceRequest(1)), true);
});

test("a truncated message is refused rather than read as zeros", () => {
  assert.throws(() => decodeMessage(Uint8Array.from([0xf0, 0x00, 0x20, 0x3c, 0x10, 0x00, 0xf7])), ApiError);
  assert.throws(() => decodeMessage(Uint8Array.from([0xf0, 0x7e, 0x00, 0x06, 0x01, 0xf7])), ApiError);
});

test("an id that cannot fit in the field is refused at the call, not truncated", () => {
  // Silently wrapping to 0 would make the reply unmatchable, and the failure would appear as a
  // timeout somewhere else entirely.
  assert.throws(() => encodeMessage(0x10000, Code.Device), ApiError);
  assert.throws(() => encodeMessage(-1, Code.Device), ApiError);
});

// --- responses -------------------------------------------------------------------------------

test("the device response names the device and lists what it supports", () => {
  // `supportedMessages` is capability discovery in the protocol itself, which is why it is worth
  // reading rather than assuming a Digitone II implements what a Digitakt II does.
  const frame = decodeMessage(
    deviceSays(1, Code.Device, 43, 3, Code.Device, Code.DirList, Code.FileRead, ...str("Digitone II")),
  );
  const device = readDeviceResponse(frame.body);
  assert.equal(device.productId, 43);
  assert.deepEqual(device.supportedMessages, [Code.Device, Code.DirList, Code.FileRead]);
  assert.equal(device.deviceName, "Digitone II");
});

test("the version response is two strings, build first", () => {
  // Order matters and is not obvious: `build` is the machine-readable one, `version` the human
  // one, and reading them the other way round gives a plausible answer to the wrong question.
  const frame = decodeMessage(deviceSays(2, Code.Version, ...str("0110"), ...str("1.10E")));
  assert.deepEqual(readVersionResponse(frame.body), { build: "0110", version: "1.10E" });
});

test("a directory listing runs to the end of the message, with no count", () => {
  const frame = decodeMessage(
    deviceSays(
      3,
      Code.DirList,
      ...u32(0xabcd), ...u32(12_889_604), 0, "F".charCodeAt(0), ...str("JAM.dn2prj"),
      ...u32(0x1234), ...u32(0), 1, "D".charCodeAt(0), ...str("factory"),
    ),
  );
  assert.deepEqual(readDirListResponse(frame.body), [
    { hash: 0xabcd, size: 12_889_604, locked: false, type: "F", name: "JAM.dn2prj" },
    { hash: 0x1234, size: 0, locked: true, type: "D", name: "factory" },
  ]);
});

test("opening a file yields a handle and the length to read", () => {
  const frame = decodeMessage(
    deviceSays(4, Code.FileReadOpen, 1, ...u32(9), ...u32(12_889_604)),
  );
  assert.deepEqual(readFileReadOpenResponse(frame.body), {
    ok: true,
    fd: 9,
    totalLength: 12_889_604,
  });
});

test("a chunk whose payload is shorter than it claims is refused", () => {
  // The failure this prevents is silent: short chunks assembled in order produce a file that is
  // the right shape and the wrong contents, and nothing notices until the device rejects it.
  const short = decodeMessage(
    deviceSays(5, Code.FileRead, 1, ...u32(9), ...u32(8), ...u32(0), ...u32(8), 1, 2, 3),
  );
  assert.throws(() => readFileReadResponse(short.body), /claims 8 bytes and carries 3/);
});

test("a good chunk reads back exactly the bytes it carried", () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8];
  const frame = decodeMessage(
    deviceSays(6, Code.FileRead, 1, ...u32(9), ...u32(8), ...u32(1024), ...u32(1032), ...data),
  );
  const chunk = readFileReadResponse(frame.body);
  assert.equal(chunk.ok, true);
  assert.equal(chunk.fd, 9);
  assert.equal(chunk.start, 1024);
  assert.deepEqual([...chunk.data], data);
});

// --- argument encoding -------------------------------------------------------------------------

test("a read asks for start and length in the order the wire wants, not the order we say it", () => {
  // On the wire it is fd, **length, start** — the reverse of how anyone describes a range. The
  // request function takes them in the readable order and swaps them, so a caller cannot get it
  // backwards; backwards would read a valid but wrong region and never error.
  const bytes = fileReadRequest(1, 9, 0x1000, 0x400);
  const payload = decode87(bytes.subarray(6, bytes.length - 1));
  assert.deepEqual([...payload.slice(5)], [...u32(9), ...u32(0x400), ...u32(0x1000)]);
});

test("closing takes just the handle", () => {
  const bytes = fileReadCloseRequest(1, 9);
  const payload = decode87(bytes.subarray(6, bytes.length - 1));
  assert.equal(payload[4], Code.FileReadClose);
  assert.deepEqual([...payload.slice(5)], u32(9));
});

test("a path is written NUL-terminated", () => {
  const bytes = dirListRequest(1, "/projects");
  const payload = decode87(bytes.subarray(6, bytes.length - 1));
  assert.equal(payload[payload.length - 1], 0, "the path must be terminated");
  assert.equal(String.fromCharCode(...payload.slice(5, -1)), "/projects");
});

test("Windows-1252 is not Latin-1, and the gaps in it are real", () => {
  // The two agree everywhere except 0x80..0x9F. Five of those 32 slots are undefined, so a dense
  // table shifts every character after the first hole — which is wrong in a way nothing notices
  // until a filename comes back mangled.
  const frame = decodeMessage(deviceSays(1, Code.Version, ...str("0110"), 0x93, 0x94, 0));
  assert.equal(readVersionResponse(frame.body).version, "“”", "0x93/0x94 are curly quotes");

  const undefinedSlot = decodeMessage(deviceSays(1, Code.Version, ...str("0110"), 0x81, 0));
  assert.throws(() => readVersionResponse(undefinedSlot.body), /undefined in Windows-1252/);
});

test("a string with no terminator is refused rather than running off the end", () => {
  const frame = decodeMessage(deviceSays(1, Code.Version, 0x30, 0x31, 0x31, 0x30));
  assert.throws(() => readVersionResponse(frame.body), /not NUL-terminated/);
});

test("only read operations exist, and that is on purpose", () => {
  // The protocol has FileWrite, FileDelete, DirCreate, DirDelete and ItemRename. A first cut that
  // can delete files off someone's +Drive is a bad first cut, and nothing needs writing until
  // reading has been proven against a real device.
  const codes = Object.keys(Code);
  for (const dangerous of ["FileWrite", "FileDelete", "DirCreate", "DirDelete", "ItemRename"]) {
    assert.ok(
      !codes.some((c) => c.startsWith(dangerous)),
      `${dangerous} is implemented — if that is deliberate, this test should say so`,
    );
  }
});
