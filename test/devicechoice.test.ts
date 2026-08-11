/**
 * Naming a connected instrument well enough to choose between two of them.
 *
 * Small, but the reason it exists is not. The manager used to take whichever Digitone answered
 * first, which is fine with one connected and wrong with two — and the thing that separates two
 * instruments of the **same model** is not the name or the firmware, it is the port. So the port is
 * the one field this line may never drop.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeChoice } from "../web/src/devicechoice.js";

test("a choice always names its port, because that is what disambiguates", () => {
  // Two Digitone IIs on the same firmware: everything a person could go on is identical except
  // the port. If these two lines were equal the picker would be a coin toss with extra steps.
  const a = describeChoice({ productId: 15, name: "Digitone II", firmwareVersion: "1.10E", port: "Digitone II" });
  const b = describeChoice({ productId: 15, name: "Digitone II", firmwareVersion: "1.10E", port: "Digitone II #2" });

  assert.notEqual(a, b);
  assert.match(a, /Digitone II$/);
  assert.match(b, /#2$/);
});

test("a device that did not answer the version request is not given one", () => {
  // `firmwareVersion` is deliberately absent rather than guessed — a manifest claiming a firmware
  // we invented is the plausible-looking wrong field this codebase keeps paying for. The label has
  // to be honest about that too, rather than printing "undefined" at somebody.
  const line = describeChoice({ productId: 9, name: "Digitone", port: "Digitone" });

  assert.doesNotMatch(line, /undefined/);
  assert.equal(line, "Digitone · Digitone");
});

test("a nameless port does not leave a dangling separator", () => {
  assert.equal(describeChoice({ productId: 9, name: "Digitone", port: "" }), "Digitone");
});
