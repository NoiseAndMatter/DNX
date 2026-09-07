/**
 * The one relaxation of "never overwrite", and the ways it must not be granted.
 *
 * `refuseUnlessEmpty` refuses every occupied +Drive slot. This decides the single exception, so
 * every test here is about an exception being withheld — a permission that is wrong in the
 * generous direction costs somebody their music.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { identityOf, mayReplaceSlot, type SlotOrigin } from "../web/src/originclaim.js";

const DN2 = { name: "Digitone II", productId: 21 };
const DN1 = { name: "Digitone", productId: 13 };

function origin(over: Partial<SlotOrigin> = {}): SlotOrigin {
  return { slot: 47, name: "COREVAULT", device: DN2, ...over };
}

test("the slot a project came out of is the slot it may go back into", () => {
  assert.deepEqual(mayReplaceSlot(origin(), DN2, 47), { allowed: true });
});

test("a project from a file has no slot to claim", () => {
  /*
   * The default, and the important one. Everything the picker offers besides an origin is empty,
   * so a project that came from nowhere in particular can only ever land somewhere empty.
   */
  const verdict = mayReplaceSlot(undefined, DN2, 47);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed ? "" : verdict.reason, /did not come out of a \+Drive slot/);
});

test("a different slot on the right instrument is refused", () => {
  const verdict = mayReplaceSlot(origin(), DN2, 48);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed ? "" : verdict.reason, /came out of slot 47, not slot 48/);
});

test("the same slot number on a different instrument is a different slot", () => {
  /*
   * **The bug this file was written for.** Open slot 47 off one instrument, switch to another, and
   * the save picker offered to "replace" the second instrument's slot 47 on the strength of a
   * project that had never been on it.
   */
  const verdict = mayReplaceSlot(origin(), DN1, 47);
  assert.equal(verdict.allowed, false);
  const reason = verdict.allowed ? "" : verdict.reason;
  assert.match(reason, /came off a Digitone II/);
  assert.match(reason, /connected instrument is a Digitone\b/);
  assert.match(reason, /different slot/);
});

test("a matching product id with a different name is still refused", () => {
  /*
   * Nobody has seen this. It is refused rather than reasoned about: the cost of guessing right is
   * nothing, and the cost of guessing wrong is somebody's project.
   */
  const verdict = mayReplaceSlot(origin(), { name: "Digitone II Keys", productId: 21 }, 47);
  assert.equal(verdict.allowed, false);
});

test("two instruments of the same model cannot be told apart, and the claim is granted", () => {
  /*
   * **A stated limit, not an oversight.** A Digitone answers its product id, its name and its
   * firmware, and nothing unique — no serial in `0x01` or `0x02`. So a second Digitone II passes
   * this check, and the protection that still holds is the one that does not depend on identity:
   * every overwrite copies the destination to your machine first, and the confirmation names what
   * the listing says is there now.
   *
   * The test exists so that anybody who later adds a serial number to this comparison finds a
   * failing assertion and the reason next to it.
   */
  const anotherOfTheSame = { name: "Digitone II", productId: 21 };
  assert.deepEqual(mayReplaceSlot(origin(), anotherOfTheSame, 47), { allowed: true });
});

test("an identity is taken from what the device or the manifest already carried", () => {
  /*
   * A backup manifest records exactly the fields `ConnectedDevice` carries, so both sides of the
   * comparison come from the same source. The file API reports a different product id for the same
   * instrument — 43 for a Digitone II against 21 here — and comparing across the two would refuse
   * every legitimate claim.
   */
  assert.deepEqual(
    identityOf({ name: "Digitone II", productId: 21, firmwareVersion: "1.10E" } as never),
    DN2,
  );
});
