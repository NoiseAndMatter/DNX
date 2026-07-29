import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMessage, parseMessage } from "../src/sysex/container.js";
import { ProductId } from "../src/sysex/devices.js";
import { RequestCode, responseFor } from "../src/device/dumprequest.js";
import { DumpReader, stepsToRetry, timeoutFor } from "../src/device/dumpreader.js";
import { RESPONSE_SIZES, planProjectRead } from "../src/device/readplan.js";

/**
 * A device that answers, on an instant clock.
 *
 * The timeout is a zero-delay timer rather than three real seconds, so a test that expects a
 * silence gets one immediately. It still goes through the real settle path: an answered step
 * clears its timer synchronously inside `send`, so only a step that genuinely went unanswered
 * ever fires. `answer` decides what the device does with each request, which is the whole surface
 * worth varying.
 */
function fakeDevice(
  answer: (request: ReturnType<typeof parseMessage>) => Uint8Array | undefined,
): { reader: DumpReader; sent: number[] } {
  const sent: number[] = [];

  const reader: DumpReader = new DumpReader({
    productId: ProductId.DN2,
    send: (bytes) => {
      const request = parseMessage(bytes);
      sent.push(request.dumpType);
      const reply = answer(request);
      if (reply) reader.receive(reply);
    },
    now: () => 0,
    setTimer: (fn) => setTimeout(fn, 0),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  return { reader, sent };
}

/** A well-formed response to a request, of the size that request's object really is. */
function respondTo(request: ReturnType<typeof parseMessage>, overrides: { objNr?: number; payloadBytes?: number } = {}): Uint8Array {
  const sizes = RESPONSE_SIZES[ProductId.DN2]!;
  const bytes =
    overrides.payloadBytes ??
    (request.dumpType === RequestCode.PatternKit
      ? sizes.patternKit
      : request.dumpType === RequestCode.Sound
        ? sizes.sound
        : sizes.settings);

  return buildMessage({
    productId: ProductId.DN2,
    dumpType: responseFor(request.dumpType),
    objNr: overrides.objNr ?? request.objNr,
    payload: new Uint8Array(bytes),
  });
}

test("a plan runs to completion when the device answers every step", async () => {
  const { reader } = fakeDevice((request) => respondTo(request));
  const plan = planProjectRead(ProductId.DN2, { settings: true, sounds: true });

  const report = await reader.run(plan);

  assert.equal(report.ok, plan.length);
  assert.equal(report.silent, 0);
  assert.equal(report.objNrMismatches, 0);
  assert.equal(report.sizeMismatches, 0);
  assert.equal(report.stopped, false);
});

test("a silent step is recorded and the run continues", async () => {
  // The failure this class is shaped around. A device may answer nothing for an empty slot, and a
  // run that stopped there would throw away every answer after it.
  const { reader } = fakeDevice((request) =>
    request.objNr === 3 ? undefined : respondTo(request),
  );
  const plan = planProjectRead(ProductId.DN2, { sounds: true });

  const report = await reader.run(plan);

  assert.equal(report.results.length, plan.length);
  assert.equal(report.silent, 1);
  assert.equal(report.ok, plan.length - 1);
  assert.equal(report.results[3]!.status, "silent");
  assert.equal(report.results[4]!.status, "ok");
});

test("an answer to a step we gave up on is counted late, not filed against the next one", async () => {
  // Off-by-one with every byte present and every checksum good — the failure that would never
  // announce itself. Step 0 goes silent, then its answer turns up while step 1 is waiting.
  let stalled: ReturnType<typeof parseMessage> | undefined;
  const { reader } = fakeDevice((request) => {
    if (request.objNr === 0) {
      stalled = request;
      return undefined;
    }
    // Step 1's request arrives: deliver step 0's answer first, then step 1's.
    if (stalled) {
      reader.receive(respondTo(stalled));
      stalled = undefined;
    }
    return respondTo(request);
  });

  const report = await reader.run(planProjectRead(ProductId.DN2, { sounds: true }));

  assert.equal(report.late, 1);
  assert.equal(report.results[0]!.status, "silent");
  assert.equal(report.results[1]!.objNr, 1, "step 1 must not be answered by step 0's dump");
});

test("an unexpected object number resolves the step and is reported", async () => {
  // We do not know whether a response echoes the requested index. Strict matching would turn that
  // unknown into a hang; this turns it into a number on the report.
  const { reader } = fakeDevice((request) => respondTo(request, { objNr: 0 }));
  const report = await reader.run(planProjectRead(ProductId.DN2, { sounds: true }));

  assert.equal(report.ok, 128);
  assert.equal(report.objNrMismatches, 127, "every step but the one that really is 0");
});

test("a payload of the wrong size is accepted and counted, not refused", async () => {
  const { reader } = fakeDevice((request) => respondTo(request, { payloadBytes: 40 }));
  const report = await reader.run(planProjectRead(ProductId.DN2, { settings: true }));

  assert.equal(report.ok, 1);
  assert.equal(report.sizeMismatches, 1);
  assert.equal(report.results[0]!.payloadBytes, 40);
});

test("traffic that is not the answer is ignored and counted", async () => {
  const { reader } = fakeDevice((request) => {
    reader.receive(Uint8Array.of(0xf8)); // MIDI clock
    reader.receive(buildMessage({ productId: ProductId.DN2, dumpType: 0x51, objNr: 9, payload: new Uint8Array(4) }));
    return respondTo(request);
  });

  const report = await reader.run(planProjectRead(ProductId.DN2, { settings: true }));

  assert.equal(report.ok, 1);
  assert.equal(report.foreign, 2);
});

test("stopping ends the run without abandoning what already arrived", async () => {
  const { reader } = fakeDevice((request) => {
    if (request.objNr === 2) reader.stop();
    return respondTo(request);
  });

  const report = await reader.run(planProjectRead(ProductId.DN2, { sounds: true }));

  assert.equal(report.stopped, true);
  assert.ok(report.ok >= 2, "the answers before the stop are kept");
  assert.ok(report.results.length < 128);
});

test("progress is reported per step, with the total", async () => {
  const seen: string[] = [];
  const reader: DumpReader = new DumpReader({
    productId: ProductId.DN2,
    send: (bytes) => reader.receive(respondTo(parseMessage(bytes))),
    setTimer: (fn) => setTimeout(fn, 0),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onProgress: (result, done, total) => seen.push(`${done}/${total} ${result.step.label}`),
  });

  await reader.run(planProjectRead(ProductId.DN2, { settings: true }));
  assert.deepEqual(seen, ["1/1 Project settings"]);
});

test("a bad checksum is counted, and its step is offered for a second pass", async () => {
  // The failure the first hardware run found: one pattern in 248 arrived corrupt with a good-
  // looking everything-else, and read back perfectly the next night. Rare, silent, and fatal to
  // anything that trusts a single pass.
  const { reader } = fakeDevice((request) => {
    const reply = respondTo(request);
    if (request.objNr === 5) reply[reply.length - 5] = reply[reply.length - 5]! ^ 0x7f;
    return reply;
  });

  const report = await reader.run(planProjectRead(ProductId.DN2, { sounds: true }));

  assert.equal(report.ok, 128, "a bad checksum still counts as an answer — it arrived");
  assert.equal(report.badChecksums, 1);
  assert.deepEqual(
    stepsToRetry(report).map((s) => s.label),
    ["Sound 5"],
  );
});

test("a second pass covers both the silent and the corrupt", async () => {
  const { reader } = fakeDevice((request) => {
    if (request.objNr === 1) return undefined;
    const reply = respondTo(request);
    if (request.objNr === 2) reply[reply.length - 5] = reply[reply.length - 5]! ^ 0x7f;
    return reply;
  });

  const report = await reader.run(planProjectRead(ProductId.DN2, { sounds: true }));

  assert.deepEqual(
    stepsToRetry(report).map((s) => s.objNr),
    [1, 2],
  );
});

test("the wait is sized from the payload, with a floor", async () => {
  const [pattern] = planProjectRead(ProductId.DN2, { patterns: true });
  const [settings] = planProjectRead(ProductId.DN1, { settings: true });

  // A 114 KB answer at the Digitakt II's 800 B/ms is 143 ms — meaningless as a timeout, so the
  // floor takes over. The floor is what makes a silence mean "no answer" rather than "too soon".
  assert.equal(timeoutFor(pattern!, ProductId.DN2), 3000);

  // And a Digitone 1 is slower per byte, so its own numbers must not be sized by the DN2's rate.
  assert.ok(timeoutFor(settings!, ProductId.DN1) >= 3000);
});
