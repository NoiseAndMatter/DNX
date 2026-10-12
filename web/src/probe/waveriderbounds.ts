/**
 * What the connected instrument's pool plays, asked before a table write names a geometry.
 *
 * **One job: turn the capability gate's answer into the one argument `unplayableReason` wants.**
 * The gate itself is `device/waveridersupport.ts` and the judging is `waverider/pool.ts`; this is
 * the probe pages' errand boy, and it exists because two controls ask the same question and a
 * second copy of *what to do when the ask fails* is how they come to disagree.
 *
 * ## Asked every press, not cached
 *
 * Three messages against a write that moves up to 512 KiB, so the saving would be invisible, and
 * the port can change under a probe page between one press and the next: the output is picked from
 * a list that Rescan rebuilds. A cache keyed on nothing would answer for the previous instrument.
 *
 * ## A failed ask does not stop the write
 *
 * The verdict card says which rule it applied and that the ask failed, and the write goes ahead
 * under the 16 x 512 rule. Refusing instead would make a busy port look like a refused table, and
 * the bounds only decide a *sentence*: the firmware is the thing that accepts or refuses the
 * bytes, and it does that whatever DNX printed.
 */

import { apiTransport } from "./link.js";
import { pageMessageIds } from "../messageids.js";
import {
  type WaveriderSupport,
  askWaveriderSupport,
} from "@noiseandmatter/dnx-core/device/waveridersupport.js";
import {
  type PlayableBounds,
  playableGeometryPhrase,
} from "@noiseandmatter/dnx-core/waverider/pool.js";

export interface AskedBounds {
  /** Pass straight to `unplayableReason`. `undefined` is the 16 x 512 rule, which is a rule. */
  bounds?: PlayableBounds;
  /** A verdict-card row: which rule is about to be applied, and on whose word. */
  why: string;
}

/** The rule a build without the capability follows, worded by the module that applies it. */
const legacy = playableGeometryPhrase();

export async function askPlayableBounds(output: MIDIOutput): Promise<AskedBounds> {
  let support: WaveriderSupport;
  try {
    support = await askWaveriderSupport({ transport: apiTransport(output), ids: pageMessageIds });
  } catch (error) {
    return {
      why: `${legacy}, assumed: the instrument could not be asked (${String(error)})`,
    };
  }

  if (support.state !== "supported") {
    return { why: `${legacy}, assumed: ${support.why}` };
  }

  const bounds = support.features.playable;
  if (!bounds) {
    return {
      why: support.features.capabilitiesKnown
        ? `${legacy}, which is what this build reports`
        : `${legacy}, assumed: this build carries no /modinfo record`,
    };
  }

  return { bounds, why: `${playableGeometryPhrase(bounds)}, from /modinfo` };
}
