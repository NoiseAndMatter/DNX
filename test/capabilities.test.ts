import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DRIVE_FILE_MESSAGES,
  DRIVE_MANAGE_MESSAGES,
  OBSERVED_DIGITONE_1,
  OBSERVED_DIGITONE_II,
  capabilitiesOf,
  describeMessages,
  hex,
} from "../src/device/capabilities.js";

// --- the Digitone II, as it actually answered ---------------------------------------------

test("a Digitone II cannot read files off its +Drive", () => {
  // The finding that cost an assumption. ROADMAP §3d planned on reading whole projects off the
  // +Drive over SysEx, which elk-herd does on a Digitakt II. A real Digitone II advertises none
  // of the file-API codes, and DirList timed out — two independent signals agreeing.
  const caps = capabilitiesOf(OBSERVED_DIGITONE_II);
  assert.equal(caps.driveFiles, false);
  assert.deepEqual(caps.missingForDriveFiles, [...DRIVE_FILE_MESSAGES], "all four are absent");
});

test("a Digitone II cannot manage its +Drive either, by elk-herd's own test", () => {
  // `hasDriveSamples` in Instrument.elm requires 0x10, 0x11, 0x12, 0x20 and 0x21. Worth checking
  // separately, because "cannot read files" and "cannot reorganise the drive" are different
  // claims and it would be easy to assert one and believe the other.
  assert.equal(capabilitiesOf(OBSERVED_DIGITONE_II).driveManagement, false);
});

test("a Digitone II does advertise dump types, which is how data moves instead", () => {
  const caps = capabilitiesOf(OBSERVED_DIGITONE_II);
  assert.ok(caps.dumps.length >= 5, `expected several dump types, got ${caps.dumps.length}`);
  assert.ok(caps.dumps.includes(0x50), "PatternKit is the one we already parse byte-exactly");
  assert.ok(caps.dumps.includes(0x53), "Sound");
});

test("unnamed API codes are separated from unnamed dump types", () => {
  // A Digitone II advertises 0x03, 0x04, 0x06 and 0x07, which appear in elk-herd and in our own
  // notes nowhere at all — on a device with no file API those are the only unexplored *messages*
  // left, and they should not be buried among ten uncatalogued dump types, which are a different
  // kind of gap: almost certainly dumps, just of data we have not named.
  const caps = capabilitiesOf(OBSERVED_DIGITONE_II);
  assert.deepEqual(caps.unknownApi, [0x03, 0x04, 0x06, 0x07]);
  assert.deepEqual(caps.unknownDumps, [0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e]);
});

// --- naming ---------------------------------------------------------------------------------

test("the two numbering spaces are told apart", () => {
  // One list carries both: 0x01..0x4f are API messages, 0x50..0x5e are dump types. Reading a
  // dump type as an API code, or the reverse, is how an afternoon disappears.
  const [device, kit] = describeMessages([0x01, 0x52]);
  assert.deepEqual(device, { code: 0x01, name: "Device", known: true, kind: "api" });
  assert.equal(kit!.kind, "dump");
  assert.match(kit!.name, /Kit/);
});

test("an unnamed code in the dump band is still a dump", () => {
  // 0x5b is advertised and unnamed. Calling it an unknown *API* message would be a worse guess
  // than calling it an unknown dump, because that band is where Elektron puts dumps.
  const [m] = describeMessages([0x5b]);
  assert.equal(m!.kind, "dump");
  assert.equal(m!.known, false);
  assert.equal(m!.name, "unknown");
});

test("the device's own ordering is preserved", () => {
  // It reports 0x50, 0x52, 0x51 — not sorted. That is a capability list in the device's order,
  // and re-sorting it would throw away the only hint about how it groups them internally.
  const codes = describeMessages(OBSERVED_DIGITONE_II).map((m) => m.code);
  assert.deepEqual(codes, [...OBSERVED_DIGITONE_II]);
});

// --- what the two Digitones have in common ----------------------------------------------------

test("neither Digitone has the +Drive file API, so it is a family fact", () => {
  // The single most useful thing the side-by-side probe bought. One device without the API is a
  // quirk; two, across two firmware generations, means the file API belongs to the Digitakt line
  // and elk-herd having it says nothing about this family.
  for (const [name, codes] of [
    ["Digitone II", OBSERVED_DIGITONE_II],
    ["Digitone 1", OBSERVED_DIGITONE_1],
  ] as const) {
    const caps = capabilitiesOf(codes);
    assert.equal(caps.driveFiles, false, `${name} should not advertise the file API`);
    assert.equal(caps.driveManagement, false, `${name} should not advertise drive management`);
  }
});

test("0x03 and 0x04 are on both machines, and named by nobody", () => {
  // The standing lead. Family-wide and old, which makes them more interesting than the DN2-only
  // codes: whatever they are, they have been there since the first Digitone.
  const shared = capabilitiesOf(OBSERVED_DIGITONE_II).unknownApi.filter((c) =>
    capabilitiesOf(OBSERVED_DIGITONE_1).unknownApi.includes(c),
  );
  assert.deepEqual(shared, [0x03, 0x04]);
});

test("Query is Digitone II only, so the DN1 cannot be asked about itself", () => {
  // Matters for anything two-device: the obvious way to learn what 0x03 and 0x04 do is to ask
  // the device by key, and exactly half the hardware cannot answer.
  assert.ok(OBSERVED_DIGITONE_II.includes(0x09), "the DN2 has Query");
  assert.ok(!OBSERVED_DIGITONE_1.includes(0x09), "the DN1 does not");
});

test("both machines list the dump band in the same unsorted order", () => {
  // 0x50, 0x52, 0x51 on both. Two devices agreeing on an ordering that is not numeric makes it a
  // family trait worth preserving rather than noise worth sorting away.
  const band = (codes: readonly number[]): number[] => codes.filter((c) => c >= 0x50);
  const dn2 = band(OBSERVED_DIGITONE_II);
  const dn1 = band(OBSERVED_DIGITONE_1);
  assert.deepEqual(dn2.slice(0, 3), [0x50, 0x52, 0x51]);
  assert.deepEqual(dn1, dn2.slice(0, dn1.length), "the DN1 band is a prefix of the DN2's");
  assert.equal(dn2.length, dn1.length + 1, "the DN2 adds exactly one dump type, 0x5e");
});

// --- a device that does have the drive API ----------------------------------------------------

test("a device advertising the file API is reported as having it", () => {
  // The Digitakt II shape, so the negative result above is a finding about the Digitone II
  // rather than a function that can only ever answer "no".
  const caps = capabilitiesOf([0x01, 0x02, ...DRIVE_FILE_MESSAGES, ...DRIVE_MANAGE_MESSAGES]);
  assert.equal(caps.driveFiles, true);
  assert.equal(caps.driveManagement, true);
  assert.deepEqual(caps.missingForDriveFiles, []);
});

test("one missing code is enough to withhold the capability", () => {
  // Partial support is not support: opening a file we cannot then read is worse than not trying.
  for (const dropped of DRIVE_FILE_MESSAGES) {
    const caps = capabilitiesOf(DRIVE_FILE_MESSAGES.filter((c) => c !== dropped));
    assert.equal(caps.driveFiles, false, `dropping ${hex(dropped)} should withhold it`);
    assert.deepEqual(caps.missingForDriveFiles, [dropped]);
  }
});

test("hex is padded, because 0x3 and 0x30 are different messages", () => {
  assert.equal(hex(0x03), "0x03");
  assert.equal(hex(0x30), "0x30");
});
