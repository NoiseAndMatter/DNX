/**
 * One verdict for a silence, and the sentence that has to survive it.
 *
 * The probe asks a device six different questions, and each one can come back with nothing. What
 * to do about that is settled: send something the device always answers, and see. What was *not*
 * settled is what to say afterwards — six call sites wrote that out six times, and the copies had
 * drifted apart in the one place it mattered.
 *
 * **`RESULT_IS_VOID` appeared on one of the six.** A silence that never reached a device says
 * nothing about the device, and the whole reason the link check exists is that a set of such
 * silences was once written down as findings. Five of the six paths would have let that happen
 * again, and no test could have noticed, because the sentence was a string literal inside a DOM
 * call inside an async function that needs an instrument to reach.
 *
 * So the first test here is the one that could not be written before: whatever the operation,
 * whatever its wording, a failed link check ends in a refusal to record. It is checked across
 * every shape the input can take rather than on one example, because the bug was never that a
 * single path was wrong — it was that each path was written on its own.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEVICE_FROZEN,
  LINK_DEAD,
  RESULT_IS_VOID,
  verdictAfterSilence,
} from "../web/src/probe/silence.js";

/** Every shape a caller can present, so a rule is checked against all of them, not an example. */
const SHAPES = [
  { what: "Listing", outcome: "nothing within 400ms", means: "not implemented here." },
  { what: "The read", outcome: "Error: refused", outcomeLabel: "Error" as const, means: "wrong shape." },
  { what: "0x62", outcome: "nothing within 3000ms", means: "the code is not implemented.", canFreeze: false },
  { what: "The write", outcome: "Error: bad checksum", outcomeLabel: "Error" as const, means: "a genuine refusal.", canFreeze: true },
  { what: "DirList", outcome: "timed out", means: "storage lives at 0x53 instead.", log: [["Advertised", "no"] as [string, string]] },
];

function meansRow(rows: readonly [string, string][]): string {
  const row = rows.find(([label]) => label === "Means");
  assert.ok(row, "every verdict explains what it means");
  return row[1];
}

test("a silence that never reached the device is never worth recording", () => {
  for (const shape of SHAPES) {
    for (const canFreeze of [false, true]) {
      const verdict = verdictAfterSilence({ ...shape, canFreeze, alive: false });
      assert.ok(
        meansRow(verdict.rows).includes(RESULT_IS_VOID),
        `${shape.what} (canFreeze=${canFreeze}) must refuse to record a void result`,
      );
      assert.equal(verdict.level, "error");
    }
  }
});

test("a proven silence is the caller's to interpret, and is worth recording", () => {
  for (const shape of SHAPES) {
    const verdict = verdictAfterSilence({ ...shape, alive: true });
    assert.equal(meansRow(verdict.rows), shape.means);
    assert.ok(!meansRow(verdict.rows).includes(RESULT_IS_VOID));
    assert.equal(verdict.level, "warn");
  }
});

test("the caller's optimistic reading never survives a failed link check", () => {
  // The write site resolves `means` from its own state before calling — if the checksum was
  // deliberately corrupted, its meaning reads as good news. That reading is about a device that
  // answered. It must not appear over a link that is not carrying anything.
  const verdict = verdictAfterSilence({
    what: "The write",
    alive: false,
    outcome: "Error: no ack",
    means: "the checksum IS validated — the answer we wanted.",
    canFreeze: true,
  });
  assert.ok(!meansRow(verdict.rows).includes("the answer we wanted"));
});

test("a request that has frozen an instrument gives different advice than a held port", () => {
  const frozen = verdictAfterSilence({ what: "The read", alive: false, outcome: "x", means: "y", canFreeze: true });
  const held = verdictAfterSilence({ what: "Listing", alive: false, outcome: "x", means: "y" });

  assert.ok(meansRow(frozen.rows).includes(DEVICE_FROZEN));
  assert.ok(meansRow(frozen.rows).includes("Power-cycle"));
  assert.ok(meansRow(held.rows).includes(LINK_DEAD));
  // The held port is somebody else's application, not a dead instrument. Telling the user to
  // power-cycle a working device is advice that costs them the unsaved project.
  assert.ok(!meansRow(held.rows).includes("Power-cycle"));
});

test("what the caller already logged comes first, unchanged", () => {
  const log: [string, string][] = [
    ["Path", "/projects"],
    ["Sending", "API 0x53"],
  ];
  const verdict = verdictAfterSilence({
    what: "Listing",
    alive: true,
    outcome: "nothing within 400ms",
    means: "not implemented.",
    log,
  });
  assert.deepEqual(verdict.rows.slice(0, 2), log);
  assert.deepEqual(log.length, 2, "the caller's array is not appended to in place");
});

test("a timeout is a result and a thrown request is an error", () => {
  const timedOut = verdictAfterSilence({ what: "Listing", alive: true, outcome: "nothing within 400ms", means: "m" });
  const threw = verdictAfterSilence({
    what: "The read",
    alive: true,
    outcome: "Error: Invalid path",
    outcomeLabel: "Error",
    means: "m",
  });
  assert.ok(timedOut.rows.some(([label]) => label === "Result"));
  assert.ok(threw.rows.some(([label, value]) => label === "Error" && value === "Error: Invalid path"));
});

test("the link check is reported either way, so a passing one is visible too", () => {
  // A check that only spoke up when it failed would be indistinguishable from one that never ran,
  // which is the state this whole mechanism exists to rule out.
  for (const alive of [true, false]) {
    const verdict = verdictAfterSilence({ what: "Listing", alive, outcome: "x", means: "y" });
    const row = verdict.rows.find(([label]) => label === "Link check");
    assert.ok(row, "the check is always shown");
    assert.ok(row[1].startsWith(alive ? "PASSED" : "FAILED"));
  }
});

test("the title and the status line agree about whose silence it was", () => {
  const alive = verdictAfterSilence({ what: "Listing", alive: true, outcome: "x", means: "y" });
  assert.ok(alive.title.includes("Listing"));
  assert.ok(alive.title.includes("proven"));

  const dead = verdictAfterSilence({ what: "Listing", alive: false, outcome: "x", means: "y" });
  assert.ok(dead.title.includes("nothing is reaching the device"));
  assert.ok(dead.message.includes("void"));
});
