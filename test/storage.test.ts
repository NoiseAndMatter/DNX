import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMessage } from "@noiseandmatter/dnx-core/device/api.js";
import {
  FREEZES,
  STORED_FORM,
  ListingError,
  StorageCode,
  copyRequest,
  deleteRequest,
  listRequest,
  moveRequest,
  openRequest,
  parseClose,
  parseListing,
  writeChunkRequest,
  writeCloseRequest,
  writeOpenRequest,
} from "@noiseandmatter/dnx-core/device/storage.js";

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
    {
      name: "HH TICK_PITX_AR",
      kind: "file",
      index: 28,
      size: 302,
      // 0x7e is the full permission mask and `01 01` says the slot holds something. Identified
      // 2026-07-30 when the user mentioned write protection: exactly the two protected projects
      // out of 128 carry 0x12 instead, and an entire factory soundbank carries it on all 256.
      permissions: 0x7e,
      occupied: true,
      writable: true,
      trailer: Uint8Array.of(0x00, 0x7e, 0x01, 0x01),
    },
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
    permissions: 0x12,
    // `01 00` is neither of the two pairs seen on a project listing. Occupancy is read as the exact
    // pair `01 01`, so this is not occupied — and a directory's occupancy is not a thing we have
    // any evidence about either way.
    occupied: false,
    writable: false,
    trailer: Uint8Array.of(0x00, 0x12, 0x01, 0x00),
  });
  assert.equal(listing.entries[1]!.name, "B");
  assert.equal(listing.entries[1]!.index, 1);
});

test("a bank's size is an allocation, not its contents", () => {
  // 262,144 is a fixed 256 KiB per bank, the way each Digitone 1 project gets a fixed 4 MiB — 256
  // sounds of 302 bytes is only 77,312. Nobody should compute free space from these.
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

// --- Transfer's own requests, byte for byte -------------------------------------------------------
//
// Everything below is a **literal transcription of what Elektron Transfer put on the wire**,
// captured over USB on 2026-07-30. These are the highest-value fixtures in this project: the
// requests were guessed at for three days from replies alone, and the guesses froze the instrument
// three times. Pinning them to the exact bytes is what stops that being re-derived.

test("the trailing byte selects the file's form, and we omit it on purpose", () => {
  // Transfer sends `01` and gets the stored .dnprj payload; omitting the byte returns the raw
  // image. Measured on hardware, on the same project, twice:
  //
  //   with 01     40 chunks,    ~90 KB           the stored payload
  //   omitted     1,358 chunks, 2,781,743 bytes  the raw image
  //
  // DNX wants raw - byte-for-byte what decodeProjectImage produces from the file, no LZ4 step.
  // Sending it was tried this session and broke `imageFrom`; this pins the regression.
  const path = [0x2f, 0x70, 0x72, 0x6f, 0x6a, 0x65, 0x63, 0x74, 0x73, 0x2f, 0x37, 0x00];
  const size = [0x00, 0x00, 0x08, 0x00];

  assert.deepEqual([...decodeMessage(openRequest(1, "/projects/7", FREEZES)).body], [...path, ...size]);

  // Transfer's exact request stays reachable, for a caller that wants a `.dnprj` to save to disk.
  assert.deepEqual(
    [...decodeMessage(openRequest(1, "/projects/7", FREEZES, 2048, STORED_FORM)).body],
    [...path, ...size, 0x01],
  );
});

test("open-for-write puts the length before the path", () => {
  // 00 00 46 90  2f 70 72 6f 6a 65 63 74 73 2f 35 36 00
  // 18,064       /projects/56\0
  //
  // Length first is not where anyone would put it, and no trailing slash — unlike the mutations.
  const sent = decodeMessage(writeOpenRequest(1, "/projects/56", 18_064)).body;
  assert.deepEqual(
    [...sent],
    [0x00, 0x00, 0x46, 0x90, 0x2f, 0x70, 0x72, 0x6f, 0x6a, 0x65, 0x63, 0x74, 0x73, 0x2f, 0x35, 0x36, 0x00],
  );
});

test("a write chunk carries handle, offset, checksum and total length before the data", () => {
  // 00 00 00 05  00 00 00 00  cb 49 92 19  00 00 01 0d  <269 bytes>
  const data = new Uint8Array(269).fill(0xac);
  const sent = decodeMessage(writeChunkRequest(1, 5, 0, 0xcb499219, 269, data)).body;

  assert.equal(sent.length, 16 + 269, "16-byte header, then the data");
  assert.deepEqual([...sent.subarray(0, 16)], [0, 0, 0, 5, 0, 0, 0, 0, 0xcb, 0x49, 0x92, 0x19, 0, 0, 0x01, 0x0d]);
});

test("closing a writer commits", () => {
  assert.deepEqual([...decodeMessage(writeCloseRequest(1, 5)).body], [0, 0, 0, 5, 0, 0, 0, 1]);
});

test("move and copy send two paths, each with a trailing slash", () => {
  // 2f 70 72 6f 6a 65 63 74 73 2f 35 35 2f 00  2f 70 72 6f 6a 65 63 74 73 2f 35 36 2f 00
  // /projects/55/\0                             /projects/56/\0
  const expected = [...Buffer.from("/projects/55/\0/projects/56/\0", "latin1")];

  assert.deepEqual([...decodeMessage(moveRequest(1, "/projects/55", "/projects/56")).body], expected);
  assert.deepEqual([...decodeMessage(copyRequest(1, "/projects/55", "/projects/56")).body], expected);
});

test("a caller who forgets the trailing slash still sends a valid mutation", () => {
  // Every other path in this API is written without one, so a caller correct everywhere else will
  // be wrong here — and the failure, `Could not resolve path`, looks exactly like naming a file
  // that is not there.
  const with_ = decodeMessage(deleteRequest(1, "/soundbanks/C/30/")).body;
  const without = decodeMessage(deleteRequest(1, "/soundbanks/C/30")).body;
  assert.deepEqual([...without], [...with_]);
  assert.deepEqual([...without], [...Buffer.from("/soundbanks/C/30/\0", "latin1")]);
});

test("a close reply states the file's length", () => {
  // 01 00 00 00 03 00 00 00 81 — handle 3, 129 bytes. That is how Transfer learns a size without
  // reading the file.
  const result = parseClose(Uint8Array.of(0x01, 0, 0, 0, 0x03, 0, 0, 0, 0x81));
  assert.equal(result.handle, 3);
  assert.equal(result.length, 129);
});
