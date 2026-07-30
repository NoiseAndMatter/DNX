import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMessage } from "../src/sysex/container.js";
import { ProductId } from "../src/sysex/devices.js";
import { OBSERVED_DIGITONE_1, OBSERVED_DIGITONE_II } from "../src/device/capabilities.js";
import {
  NotARequest,
  codesUnderTest,
  describeReply,
  isRequestCode,
  probeRequest,
} from "../src/device/probecodes.js";

test("only the request band can be addressed", () => {
  // The one thing enforced rather than reasoned about. A 0x5n sent to a device means "store this",
  // and the difference between asking and telling is one bit in one byte.
  for (const code of [0x50, 0x53, 0x54, 0x5f, 0x70, 0x00]) {
    assert.equal(isRequestCode(code), false, `0x${code.toString(16)} is not a request`);
    assert.throws(
      () => probeRequest(ProductId.DN2, { code }),
      (e: unknown) => e instanceof NotARequest && /store this/.test(String(e)),
    );
  }
  for (const code of [0x60, 0x65, 0x6f]) assert.equal(isRequestCode(code), true);
});

test("a probe request carries nothing, which is the whole safety argument", () => {
  for (const code of [0x65, 0x6a, 0x6f]) {
    const m = parseMessage(probeRequest(ProductId.DN1, { code, objNr: 3 }));
    assert.equal(m.payload.length, 0);
    assert.equal(m.dumpType, code);
    assert.equal(m.objNr, 3);
    assert.equal(m.productId, ProductId.DN1);
  }
});

test("an object number that will not fit is refused rather than truncated", () => {
  assert.throws(() => probeRequest(ProductId.DN2, { code: 0x65, objNr: 128 }), /7-bit field/);
});

test("the known five are offered as controls", () => {
  // A silent unknown code means nothing unless a known one would have spoken. Filtering the known
  // codes out of the list would remove the only way to tell "not implemented" from "not listening".
  const codes = codesUnderTest(OBSERVED_DIGITONE_II);
  const controls = codes.filter((c) => c.known !== undefined);
  assert.equal(controls.length, 5, "0x60..0x64");
  assert.match(controls[0]!.note, /control/);
});

test("what a device advertises decides which unknowns are interesting", () => {
  // A response the device lists but nobody can name is the likeliest place for a project object.
  // One it does not list is a longer shot, and the note says so rather than treating them alike.
  const dn2 = codesUnderTest(OBSERVED_DIGITONE_II);
  const dn1 = codesUnderTest(OBSERVED_DIGITONE_1);

  const advertisedUnknown = (list: ReturnType<typeof codesUnderTest>) =>
    list.filter((c) => c.known === undefined && c.advertised).map((c) => c.code);

  // The DN2 advertises up to 0x5e and the DN1 up to 0x5d, so the DN2 has exactly one more.
  assert.equal(advertisedUnknown(dn2).length, advertisedUnknown(dn1).length + 1);
  assert.ok(advertisedUnknown(dn2).includes(0x6e), "0x5e is advertised by the DN2 and unnamed");
  assert.ok(!advertisedUnknown(dn1).includes(0x6e), "the DN1 does not advertise 0x5e");

  const whole = dn2.find((c) => c.code === 0x6f)!;
  assert.equal(whole.advertised, false);
  assert.match(whole.note, /WholeProject/);
});

test("a reply is measured against records we can name", () => {
  // Every record identified so far was recognised by its size first, so an unfamiliar payload is
  // measured before anything is assumed about it.
  const sizes = { "a DN2 patternKit": 99_840, "a DN2 sound": 359 };

  const known = describeReply(0x60, 0x50, 7, 99_840, true, sizes);
  assert.equal(known.asExpected, true);
  assert.equal(known.resembles, "a DN2 patternKit");

  // The interesting case: an answer that matches nothing we know.
  const novel = describeReply(0x6e, 0x5e, 0, 4_096, true, sizes);
  assert.equal(novel.asExpected, true);
  assert.equal(novel.resembles, undefined);

  // And one that does not even follow the convention, which would be more interesting still.
  const odd = describeReply(0x6e, 0x01, 0, 12, false, sizes);
  assert.equal(odd.asExpected, false);
  assert.equal(odd.checksumOk, false);
});
