/**
 * One rearrangement, from plan to verified image, with nothing on screen in it.
 *
 * ## Why this is not in the manager
 *
 * The manager's `run()` held the whole shape: plan, refuse on blockers, list what would be
 * destroyed, ask, apply, verify, then say what happened. Only two of those steps are a browser,
 * and the other five are the operation itself. An Android app moving patterns needs the five and
 * has its own idea of the two.
 *
 * So the pipeline lives here and hands the caller two decisions to make:
 *
 * | the caller decides | because |
 * |---|---|
 * | whether to go ahead when `destructive` is not empty | the person is the one losing the work |
 * | how any of this is worded on screen | a dialog, a toast and a terminal are different places |
 *
 * ## Both levels, one shape
 *
 * A pattern rearrangement and a track move report the same fields, which is why `trackmove.ts`
 * mirrors `rearrange.ts` rather than inventing its own plan. That symmetry is what lets the
 * blockers, the destructive list and the verification be written once here rather than twice at
 * the call site.
 *
 * ## Verification is not optional
 *
 * `applyOperation` throws when the result does not verify, rather than returning it with a flag.
 * A caller that forgot to check the flag would write an unverified image to somebody's
 * instrument, and the whole point of the plan/apply split is that the second half is trustworthy.
 */

import { type Device } from "./device.js";
import { applyRearrange, planRearrange } from "./rearrange.js";
import { type Shuffle } from "./shuffle.js";
import {
  applyTrackMove,
  planTrackMove,
  type TrackScope,
  verifyTrackMove,
} from "./trackmove.js";
import { trackName } from "./tracksummary.js";
import { patternName } from "../project/naming.js";

/** What a rearrangement is being asked to do, at whichever level the caller is working. */
export interface Operation {
  /**
   * The pattern whose tracks are moving, or `undefined` for a pattern-level rearrangement.
   *
   * The level comes from the operation rather than from whatever is on screen when it runs; see
   * `patternForOperation`, which carries that reasoning and its test.
   */
  tracks?: number | undefined;
  shuffle: Shuffle;
  /** Sequence, preset, or both. Read only by a track move. */
  scope: TrackScope;
}

/** A plan, and the two lists a caller has to act on before anything is applied. */
export interface OperationPlan {
  /** Every finding, in the order the planner reported them. */
  findings: readonly { severity: string; message: string }[];
  /** Findings that stop the operation. Non-empty means refuse. */
  blockers: readonly { severity: string; message: string }[];
  /** Findings worth saying afterwards, which do not stop anything. */
  warnings: readonly { severity: string; message: string }[];
  /**
   * What this would overwrite or empty, one line each, already named the way the instrument
   * names it.
   *
   * Formatted here because the names are the instrument's: `A01` and `T3` come from
   * `naming.ts` and `tracksummary.ts`, and a host that re-derived them would eventually disagree
   * with the grid the person is looking at. How the lines are *presented* is still the caller's.
   */
  destructive: readonly string[];
}

/** Plan an operation and say what it would cost. Reads the image; changes nothing. */
export function planOperation(image: Uint8Array, device: Device, operation: Operation): OperationPlan {
  const plan =
    operation.tracks === undefined
      ? planRearrange(image, operation.shuffle)
      : planTrackMove(image, device, operation.tracks, operation.shuffle, operation.scope);

  return {
    findings: plan.findings,
    blockers: plan.findings.filter((f) => f.severity === "blocker"),
    warnings: plan.findings.filter((f) => f.severity === "warning"),
    destructive: plan.destructive.map((c) =>
      "slot" in c
        ? `${patternName(c.slot)}${c.name ? ` "${c.name}"` : ""} — ${c.trigCount} trigs` +
          (c.replacedBy !== undefined ? `, replaced by ${patternName(c.replacedBy)}` : "")
        : `${trackName(c.track)} — ${c.trigCount} trigs`),
  };
}

/**
 * Apply an operation to an image and return the new one, verified.
 *
 * **Throws when verification fails**, which is the only honest answer: the bytes are wrong and
 * nothing downstream can do anything useful with them.
 */
export function applyOperation(image: Uint8Array, device: Device, operation: Operation): Uint8Array {
  if (operation.tracks !== undefined) {
    const result = applyTrackMove(image, device, operation.tracks, operation.shuffle, {
      confirmOverwrite: true,
      scope: operation.scope,
    });
    const verification = verifyTrackMove(
      image, result.image, operation.tracks, operation.shuffle, operation.scope,
    );
    if (!verification.ok) {
      throw new Error(`verification failed: ${verification.problems.join("; ")}`);
    }
    return result.image;
  }

  const result = applyRearrange(image, operation.shuffle, { confirmOverwrite: true });
  if (!result.verification.ok) {
    throw new Error(`verification failed: ${result.verification.problems.join("; ")}`);
  }
  return result.image;
}
