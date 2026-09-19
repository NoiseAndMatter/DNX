/**
 * What to ask a device for, in what order, to read a whole project.
 *
 * A plan and nothing else: no transport, no timers, no device. `dumpreader.ts` executes it. The
 * split is deliberate — *what a project is made of* is format knowledge that belongs with the rest
 * of the format knowledge, while *how to pace a request stream* is a transport concern that has
 * nothing to say about Digitones.
 *
 * ## `0x63` addresses different things on the two families — VERIFIED 2026-07-29
 *
 * **A Digitone II answers `0x63 n` from the project sound pool**: all 128 slots, 0–118 named and
 * 119–127 empty, byte-identical to the pool in the project file.
 *
 * **A Digitone 1 answers `0x63 n` from the active kit's track sounds**: exactly four, `n` = 0..3,
 * and silence from 4 to 127. Each one matched the corresponding track slot of one pattern's kit —
 * sound 0 to track 1, sound 1 to track 2, sound 3 to track 4 — and four is the DN1's synth-track
 * count.
 *
 * **The obvious alternative reading is ruled out by the capture itself.** "A pool with only four
 * entries" would look identical, so it was checked rather than dismissed: the same project's sound
 * locks reference **31 distinct pool slots, up to slot 91**, across 398 locked trigs. The device
 * stayed silent on every one of them. It is declining to hand over slots it provably holds, so
 * `0x63` is not addressing the pool.
 *
 * ### What that does not establish
 *
 * Only that **`0x63` is not the way in.** A Digitone 1 advertises `0x50`–`0x5d` and we can name
 * just `0x50`–`0x54`, so **nine dump types are unidentified** and their requests would be
 * `0x65`–`0x6d`. None has ever been sent, and neither has `0x6f`. The pool may well be
 * requestable by a code nobody here has tried, and it would be wrong to write "unreachable".
 *
 * The free experiment that settles it: the DN1's front panel already sends the whole sound pool.
 * Capturing one with **Listen**, which transmits nothing at all, names the dump type the pool
 * travels as — and the matching request is that code minus `0x10`.
 *
 * Until then a DN1 pool comes from that panel send. Any DN1 workflow needing sound-locked sounds —
 * which is every DN1→DN2 expansion — captures it as a separate step.
 *
 * This correction removes the first reason this module was written the way it is. It was
 * originally justified partly by "asking for the 128 pool slots by number is the only way to get
 * them on a DN1", and that is **false**: it does not work. The decision below still holds, on the
 * reasons that survived.
 *
 * ## Per object, not `0x6f`
 *
 * elk-herd reads a Digitakt project with a single `0x6f` WholeProject request and treats the
 * arrival of ProjectSettings as the end of the stream (`Project/Update.elm`, `receiveDump`). That
 * is one message out instead of 257, and it is tempting.
 *
 * Three reasons to stay per-object, all of them still standing after the DN1 run:
 *
 * 1. **`0x6f` has never been sent to either machine.** The five per-object requests have, twice
 *    over, on both, and now a whole project's worth on each. Building on the proven one is the
 *    difference between a feature that works and one that needs another hardware session.
 * 2. **A plan can be a subset.** "Read pattern A1" and "read the whole project" are the same code
 *    path with a different list, which is what transfer mode actually needs. `0x6f` is
 *    all-or-nothing and costs 14.6 MB every time — §5c measured the device sending all 128
 *    patterns regardless of occupancy.
 * 3. **On a Digitone II, requesting sees more than dumping.** A front-panel dump sends the 119
 *    *occupied* pool slots; requesting enumerates all 128. Anything sizing a pool from a dump
 *    would size it 119.
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

import { patternName } from "../project/naming.js";
import { ProductId } from "../sysex/devices.js";
import { POOL_SOUND_COUNT } from "../project/soundmap.js";
import { RequestCode, responseFor } from "./dumprequest.js";

/** Pattern slots on both families: 8 banks of 16. */
export const PATTERN_COUNT = 128;

/**
 * How many sounds `0x63` will answer for, by family. **[verified]** on hardware, both machines.
 *
 * The Digitone II enumerates its 128-slot project pool. The Digitone 1 answers only its four kit
 * track sounds — so its pool is unreachable by request and must be captured from the front panel.
 * Asking a DN1 for 128 is not merely useless, it costs 124 timeouts.
 */
export function soundRequestCount(dumpProductId: number): number {
  return dumpProductId === ProductId.DN1 ? DN1_KIT_SOUNDS : POOL_SOUND_COUNT;
}

/** Synth tracks on a Digitone 1, and therefore sounds in its kit. */
const DN1_KIT_SOUNDS = 4;

/**
 * True when no request we know of reaches this device's sound pool.
 *
 * The Digitone 1 case, and worded as ignorance rather than impossibility: `0x63` is proven not to
 * be the way in, and nine of its dump types remain unidentified. Until one of them is tried, a
 * workflow that needs sound-locked sounds captures the pool from `SETTINGS > SYSEX DUMP`.
 */
export function poolNeedsPanelDump(dumpProductId: number): boolean {
  return dumpProductId === ProductId.DN1;
}

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
    // **Not the same object on the two machines**, and not the same count either — see the module
    // note. A Digitone II answers 128 pool slots; a Digitone 1 answers four kit track sounds and
    // stays silent for the rest. Asking a DN1 for 128 costs 124 timeouts and returns nothing, so
    // the plan asks for what the device actually has.
    for (let i = 0; i < soundRequestCount(dumpProductId); i++) {
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
