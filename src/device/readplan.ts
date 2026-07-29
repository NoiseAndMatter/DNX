/**
 * What to ask a device for, in what order, to read a whole project.
 *
 * A plan and nothing else: no transport, no timers, no device. `dumpreader.ts` executes it. The
 * split is deliberate — *what a project is made of* is format knowledge that belongs with the rest
 * of the format knowledge, while *how to pace a request stream* is a transport concern that has
 * nothing to say about Digitones.
 *
 * ## Per object, not `0x6f` — and the Digitone 1 is why
 *
 * elk-herd reads a Digitakt project with a single `0x6f` WholeProject request and treats the
 * arrival of ProjectSettings as the end of the stream (`Project/Update.elm`, `receiveDump`). That
 * is one message out instead of 257, and it is tempting.
 *
 * It is the wrong choice here, for reasons the hardware already gave us:
 *
 * 1. **A Digitone 1 project dump carries no sound pool.** Verified — `docs/dn2-format.md` §5c:
 *    128 PatternKit plus one ProjectSettings, and no `0x53` at all. The pool is exactly what the
 *    expander exists to unfold, so a whole-project dump is *structurally incomplete* on the
 *    machine this project's whole workflow starts from. Asking for the 128 pool slots by number
 *    is the only way to get them.
 * 2. **`0x6f` has never been sent to either machine.** The five per-object requests have, twice
 *    over, on both. Building on the proven one is not caution for its own sake — it is the
 *    difference between a feature that works tonight and one that needs another hardware session.
 * 3. **A plan can be a subset.** "Read pattern A1" and "read the whole project" are then the same
 *    code path with a different list, which is what transfer mode actually needs. `0x6f` is
 *    all-or-nothing and costs 14.6 MB every time — §5c measured the device sending all 128
 *    patterns regardless of occupancy.
 *
 * The cost is 257 round trips instead of 1. At the observed USB throughput that is seconds, and
 * it buys resumability, selectivity and a per-object account of what arrived.
 *
 * ## Sizes are measured, not assumed
 *
 * Every payload size below was read off the wire from both machines and is recorded in
 * `docs/dn2-format.md` §5c. They are here so the reader can size its own timeouts: a request whose
 * answer is 100 KB deserves a longer wait than one whose answer is 512 bytes, and a fixed timeout
 * that suits both is either too slow to fail or too quick to succeed.
 */

import { patternName } from "../sheet/naming.js";
import { ProductId } from "../sysex/devices.js";
import { POOL_SOUND_COUNT } from "../project/soundmap.js";
import { RequestCode, responseFor } from "./dumprequest.js";

/** Pattern slots on both families: 8 banks of 16. */
export const PATTERN_COUNT = 128;

/**
 * Payload sizes each family answers with, in bytes.
 *
 * **[verified]** on hardware, both machines, `docs/dn2-format.md` §5c. `patternKit` is
 * `patternSize + kitSize` exactly on both, which is the same fact `src/project/dn2image.ts`
 * records for the file — a pattern on the wire and a pattern in a project are one record.
 */
export const RESPONSE_SIZES: Readonly<Record<number, { patternKit: number; sound: number; settings: number }>> = {
  [ProductId.DN1]: { patternKit: 20_992, sound: 302, settings: 11_776 },
  [ProductId.DN2]: { patternKit: 99_840, sound: 359, settings: 512 },
};

/** One request, and what its answer should look like. */
export interface ReadStep {
  code: RequestCode;
  objNr: number;
  /** The response dump type this step waits for. */
  expect: number;
  /** `Pattern A1`, `Sound 42`, `Project settings` — how a progress line names it. */
  label: string;
  /**
   * Payload bytes the answer should carry.
   *
   * A *prediction*, and the reader reports the difference rather than enforcing it. A step that
   * answers the wrong size is the most interesting result this can produce; refusing it would
   * throw away the finding.
   */
  payloadBytes: number;
}

export interface ReadPlanOptions {
  /** All 128 pattern slots, as `0x60` PatternKit — pattern and kit in one message. */
  patterns?: boolean;
  /** All 128 project sound-pool slots, as `0x63`. */
  sounds?: boolean;
  /** The single `0x64` ProjectSettings record. */
  settings?: boolean;
}

const EVERYTHING: Required<ReadPlanOptions> = { patterns: true, sounds: true, settings: true };

/**
 * The requests that together are a whole project.
 *
 * Ordered patterns → sounds → settings, matching the order a device dumps of its own accord
 * (§5c). Nothing depends on the order, and following the device's is free: if a future capture is
 * ever compared against one of ours, message *n* is the same object in both.
 *
 * @param dumpProductId the **dump protocol's** product id — `0x0D` or `0x15`, not the API's 20/43.
 */
export function planProjectRead(dumpProductId: number, options: ReadPlanOptions = EVERYTHING): ReadStep[] {
  const sizes = RESPONSE_SIZES[dumpProductId];
  if (!sizes) {
    throw new Error(
      `no response sizes recorded for dump product 0x${dumpProductId.toString(16)} — ` +
        `reading a project needs a device whose record sizes we have measured`,
    );
  }

  const steps: ReadStep[] = [];

  if (options.patterns ?? false) {
    for (let i = 0; i < PATTERN_COUNT; i++) {
      steps.push({
        code: RequestCode.PatternKit,
        objNr: i,
        expect: responseFor(RequestCode.PatternKit),
        label: `Pattern ${patternName(i)}`,
        payloadBytes: sizes.patternKit,
      });
    }
  }

  if (options.sounds ?? false) {
    // 128 slots, both families — `POOL_SOUND_COUNT`, established from the project image. The
    // Digitone II sent only 119 of them when dumping itself, which is consistent with a device
    // that skips empty slots and says nothing about how many there are. A slot that answers
    // nothing is the reader's business, not the plan's.
    for (let i = 0; i < POOL_SOUND_COUNT; i++) {
      steps.push({
        code: RequestCode.Sound,
        objNr: i,
        expect: responseFor(RequestCode.Sound),
        label: `Sound ${i}`,
        payloadBytes: sizes.sound,
      });
    }
  }

  if (options.settings ?? false) {
    steps.push({
      code: RequestCode.ProjectSettings,
      objNr: 0,
      expect: responseFor(RequestCode.ProjectSettings),
      label: "Project settings",
      payloadBytes: sizes.settings,
    });
  }

  return steps;
}

/** Roughly how many bytes a plan will pull off the device, framing included. */
export function planBytes(steps: readonly ReadStep[]): number {
  return steps.reduce((total, step) => total + wireBytes(step.payloadBytes), 0);
}

/**
 * Payload bytes as they appear on the wire.
 *
 * 8-in-7 costs one byte per seven, and the container adds ten bytes of header and five of trailer
 * (`src/sysex/container.ts`). Used for sizing waits and warnings, so a rounded-up estimate is
 * exactly right and an exact count would be false precision — the last group of a payload is
 * partial.
 */
export function wireBytes(payloadBytes: number): number {
  return Math.ceil((payloadBytes * 8) / 7) + 15;
}
