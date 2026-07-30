import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMessage } from "../src/device/api.js";
import {
  ListingError,
  StorageCode,
  listRequest,
  parseListing,
} from "../src/device/storage.js";

/** Bytes exactly as a Digitone 1 sent them, transcribed from the Transfer capture. */
const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));

/** The root: two directories, `projects` with 128 children and `soundbanks` with 8. */
const ROOT = bytes(`
  01 00 00 00 00 00 00 00 02 00 00 00 02
  70 72 6f 6a 65 63 74 73 00 01 01 00 00 00 80
  73 6f 75 6e 64 62 61 6e 6b 73 00 01 01 00 00 00 08
`);

/** One sound, at index 28, 302 bytes — the entry whose position the user moved on the device. */
const ONE_SOUND = bytes(`
  01 00 00 00 1c 00 00 00 1d 00 00 00 01
  48 48 20 54 49 43 4b 5f 50 49 54 58 5f 41 52 00
  00 02 00 00 00 1c 00 00 01 2e 00 7e 01 01
`);

test("the root listing decodes to two directories with their child counts", () => {
  const listing = parseListing(ROOT);

  assert.equal(listing.first, 0);
  assert.equal(listing.next, 2);
  assert.deepEqual(listing.entries, [
    { name: "projects", kind: "directory", index: 0, children: 128 },
    { name: "soundbanks", kind: "directory", index: 1, children: 8 },
  ]);
});

test("a file entry carries its position and size, which is the whole point", () => {
  // The dump protocol's object number is seven bits, so a bank past 128 loses its numbering
  // entirely. This field is 32 bits and states the position outright.
  const listing = parseListing(ONE_SOUND);

  assert.deepEqual(listing.entries, [
    { name: "HH TICK_PITX_AR", kind: "file", index: 28, size: 302, unknown: 0x7e },
  ]);
  assert.equal(listing.entries[0]!.size, 302, "a DN1 sound record — how the format was recognised");
  assert.equal(listing.first, 28, "the page starts where it says it does");
});

test("the paging cursor is carried through", () => {
  const listing = parseListing(ONE_SOUND);
  assert.equal(listing.next, 29, "a following request resumes here");
});

/** `/soundbanks` on a Digitone 1 — directories that use the *long* trailer. */
const BANKS = bytes(`
  01 00 00 00 00 00 00 00 02 00 00 00 02
  41 00  01 02  00 00 00 00  00 04 00 00  00 12 01 00
  42 00  01 02  00 00 00 01  00 04 00 00  00 12 01 00
`);

test("a directory can use the long trailer, which is what /soundbanks does", () => {
  // The first parser read the two bytes after a name as one 16-bit tag, which held while only
  // `0101` and `0002` had been seen. `/soundbanks` carries `0102` — a directory with a file-shaped
  // trailer — and the parser refused a perfectly good listing. It refused *loudly* and handed over
  // the bytes, which is the part that went right.
  const listing = parseListing(BANKS);

  assert.equal(listing.entries.length, 2);
  assert.deepEqual(listing.entries[0], {
    name: "A",
    kind: "directory",
    index: 0,
    size: 262_144,
    unknown: 0x12,
  });
  assert.equal(listing.entries[1]!.name, "B");
  assert.equal(listing.entries[1]!.index, 1);
});

test("a bank's size is an allocation, not its contents", () => {
  // 262,144 is a fixed 256 KiB per bank, the way each project gets a fixed 4 MiB — 256 sounds of
  // 302 bytes is only 77,312. Nobody should compute free space from these.
  const bank = parseListing(BANKS).entries[0]!;
  assert.equal(bank.size, 262_144);
  assert.ok(bank.size! > 256 * 302, "the allocation exceeds what the bank can hold");
});

test("the device's own error message is reported rather than a parse failure", () => {
  // It says so in as many words, which is about as forgiving as a wrong guess can be — and this is
  // how a caller learns the *path* was wrong rather than our decoding.
  const invalid = bytes("00 49 6e 76 61 6c 69 64 20 70 61 74 68 00");
  assert.throws(() => parseListing(invalid), (e: unknown) => e instanceof ListingError && /Invalid path/.test(String(e)));
});

test("an unrecognised trailer layout is refused, not decoded on a guess", () => {
  // A directory browser is what a project gets opened from. An entry decoded wrongly is a project
  // opened from the wrong slot, which is the class of mistake this codebase keeps paying for.
  //
  // Note this refuses on the **layout** byte only. Whether the entry calls itself a directory is
  // now irrelevant to how it is read, which is what the `/soundbanks` surprise taught.
  const odd = bytes("01 00 00 00 00 00 00 00 01 00 00 00 01 41 00 09 09 00 00 00 01");
  assert.throws(() => parseListing(odd), /neither short .* nor long/);
});

test("a truncated listing is refused", () => {
  assert.throws(() => parseListing(ROOT.subarray(0, 20)), /truncated|no terminated name/);
  assert.throws(() => parseListing(bytes("01 00 00")), /too short/);
});

test("a status byte that is not 1 is refused", () => {
  const bad = Uint8Array.from(ROOT);
  bad[0] = 2;
  assert.throws(() => parseListing(bad), /status byte is 2/);
});

test("a list request is an API message carrying a NUL-terminated path", () => {
  const frame = decodeMessage(listRequest(7, "projects"));

  assert.equal(frame.code, StorageCode.List);
  assert.equal(frame.msgId, 7);
  assert.equal(frame.respId, undefined, "a request, not a response");
  assert.deepEqual([...frame.body], [...Uint8Array.from([...Buffer.from("projects", "latin1"), 0])]);
});

test("a page appends start AND count; an unpaged request appends neither", () => {
  // Established on hardware one field at a time. A bare path returns everything. Adding a start
  // alone came back `first 28, count 0` — twice, on two paths — because that asks for nothing.
  assert.equal(decodeMessage(listRequest(1, "projects")).body.length, 9, "path only");

  const paged = decodeMessage(listRequest(1, "projects", { start: 28, count: 1 })).body;
  assert.equal(paged.length, 17, "path + two u32");
  assert.deepEqual([...paged.subarray(9)], [0, 0, 0, 28, 0, 0, 0, 1]);
});

test("start and count travel together, because a start alone asks for nothing", () => {
  // The type is the guard: there is no way to express a start without a count, so the request the
  // device answers with an empty page cannot be written by accident.
  const page: Parameters<typeof listRequest>[2] = { start: 28, count: 1 };
  assert.equal(page.start, 28);
  assert.equal(page.count, 1);
});

test("a path outside Windows-1252 is refused before it reaches the wire", () => {
  assert.throws(() => listRequest(1, "proj\u{1F600}cts"), /not encodable/);
});
