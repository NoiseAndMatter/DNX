import assert from "node:assert/strict";
import { test } from "node:test";
import { DN1_BLANK, DN2_BLANK, decodeBlank } from "../src/librarian/blankdata.js";
import { DN1_DEVICE, DN2_DEVICE } from "../src/librarian/device.js";
import { blankFits, blankPatternKit, blankSource } from "../src/librarian/blank.js";
import { RleError, fromBase64, rleDecode, rleEncode, toBase64 } from "../src/librarian/rle.js";

// --- the codec -------------------------------------------------------------

test("RLE round-trips runny data", () => {
  const data = new Uint8Array(5000);
  data.fill(0xff, 0, 4000);
  data.fill(0x07, 4000, 4900);
  const encoded = rleEncode(data);
  assert.ok(encoded.length < 20, `expected tiny output, got ${encoded.length}`);
  assert.deepEqual(rleDecode(encoded, data.length), data);
});

test("RLE round-trips data with no runs at all", () => {
  const data = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
  assert.deepEqual(rleDecode(rleEncode(data), data.length), data);
});

test("RLE handles runs longer than one varint byte", () => {
  const data = new Uint8Array(300_000).fill(0xab);
  assert.deepEqual(rleDecode(rleEncode(data), data.length), data);
});

test("RLE round-trips an empty input", () => {
  assert.deepEqual(rleDecode(rleEncode(new Uint8Array(0)), 0), new Uint8Array(0));
});

test("RLE refuses a stream that does not fill the expected size", () => {
  const encoded = rleEncode(new Uint8Array(10).fill(1));
  assert.throws(() => rleDecode(encoded, 11), RleError);
  assert.throws(() => rleDecode(encoded, 9), RleError);
});

test("RLE refuses a truncated stream", () => {
  const encoded = rleEncode(new Uint8Array(10).fill(1));
  assert.throws(() => rleDecode(encoded.subarray(0, 1), 10), RleError);
});

test("base64 round-trips every byte value and each padding case", () => {
  for (const length of [0, 1, 2, 3, 255, 256, 257]) {
    const data = Uint8Array.from({ length }, (_, i) => (i * 7) % 256);
    assert.deepEqual(fromBase64(toBase64(data)), data, `length ${length}`);
  }
});

// --- the captured blanks ---------------------------------------------------

for (const [label, blank, device] of [
  ["DN1", DN1_BLANK, DN1_DEVICE],
  ["DN2", DN2_BLANK, DN2_DEVICE],
] as const) {
  test(`${label}: the captured blank decodes to the device's record sizes`, () => {
    const { pattern, kit } = decodeBlank(blank);
    assert.equal(pattern.length, device.layout.patternSize);
    assert.equal(kit.length, device.layout.kitSize);
    assert.equal(blankFits(device), true);
  });

  test(`${label}: the blank is a pattern record we can read`, () => {
    const { pattern } = decodeBlank(blank);
    const version = new DataView(pattern.buffer, pattern.byteOffset, 4).getUint32(0, false);
    assert.equal(
      version,
      device.patternVersion,
      "a blank at an unsupported version would be refused the moment it was written",
    );
  });

  test(`${label}: writing a blank stamps the slot it is going to`, () => {
    for (const slot of [0, 1, 63, 127]) {
      const { pattern } = blankPatternKit(device, slot);
      assert.equal(pattern[device.slotIndexOffset], slot);
    }
  });

  test(`${label}: the blank kit carries no name`, () => {
    const { kit } = blankPatternKit(device, 0);
    const nameAt = device.kind === "dn1" ? 4 : 8;
    const name = kit.subarray(nameAt, nameAt + 16);
    assert.ok(
      name.every((b) => b === 0),
      `an untouched kit has no name on the device, got ${JSON.stringify([...name])}`,
    );
  });

  test(`${label}: each call returns fresh buffers`, () => {
    const first = blankPatternKit(device, 4);
    const second = blankPatternKit(device, 4);
    first.pattern[100] = (first.pattern[100]! + 1) & 0xff;
    first.kit[100] = (first.kit[100]! + 1) & 0xff;
    assert.notEqual(first.pattern[100], second.pattern[100], "pattern buffers are shared");
    assert.notEqual(first.kit[100], second.kit[100], "kit buffers are shared");
  });

  test(`${label}: the blank reports where it came from`, () => {
    assert.match(blankSource(device), /slot \d+$/);
  });

  test(`${label}: the blank carries no text beyond Elektron's factory defaults`, () => {
    const { pattern, kit } = decodeBlank(blank);
    const joined = new Uint8Array(pattern.length + kit.length);
    joined.set(pattern, 0);
    joined.set(kit, pattern.length);

    // Word-like runs only. Parameter bytes routinely land in printable ASCII by accident —
    // the DN1 blank contains ` !lq-"` — so counting every printable run as "text" produces
    // false alarms. Letters, digits and spaces is a fair definition of something a person
    // could have typed.
    const found: string[] = [];
    let run = "";
    const wordish = (b: number): boolean =>
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      (b >= 0x30 && b <= 0x39) ||
      b === 0x20;
    for (const b of joined) {
      if (wordish(b)) run += String.fromCharCode(b);
      else {
        if (run.trim().length >= 4) found.push(run.trim());
        run = "";
      }
    }
    if (run.trim().length >= 4) found.push(run.trim());

    // The blank ships in a public repository, so this is the guard against a capture
    // accidentally carrying someone's work. Anything a person named would fail it.
    const allowed = /^(PRESET|SOUND|MIDI|VAL|MACRO|KIT|TRACK|UNTITLED|BANK)/;
    const unexpected = [...new Set(found)].filter((s) => !allowed.test(s));
    assert.deepEqual(unexpected, [], `unexpected text in the ${label} blank`);
  });
}
