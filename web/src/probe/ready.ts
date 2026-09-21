/**
 * Is the page in a state worth sending from?
 *
 * Nine call sites opened with the same three guards and had drifted into four wordings of one
 * sentence — *nothing will be collecting the reply*, *nothing collects the reply*, *the answers*,
 * *the replies* — which is four ways of saying a thing that is true once.
 *
 * It used to sit inline in the page on the argument that a module would need `access`, `ports`,
 * `listening` and `status` passed in, which was more machinery than the check. The split settles
 * that: all four are modules now, so the check imports what it reads and the machinery is gone.
 */

import { status } from "./chrome.js";
import { access, lastProductId, ports } from "./link.js";
import { isListening } from "./listen.js";

/**
 * What the reply is for, which is the only thing the Listen check needs to know.
 *
 * A request wants its answer collected. A write wants to read back what it wrote, which is a
 * stronger reason: an unverifiable write is not a test of anything.
 */
export type Await = "reply" | "readback";

/**
 * The output port, if sending is worth doing at all.
 *
 * Nine call sites opened with the same three guards and had drifted into four wordings of one
 * sentence — *nothing will be collecting the reply*, *nothing collects the reply*, *the answers*,
 * *the replies* — which is four ways of saying a thing that is true once. Unlike `silence.ts` this
 * stays here rather than becoming a module: it reads `access`, `ports`, `listening` and `status`,
 * so a separate file would need all four passed in, which is more machinery than the check.
 */
export function readyOutput(waiting: Await): MIDIOutput | undefined {
  if (!access) return undefined;

  const output = ports.output(access);
  if (!output) {
    status("That output is no longer there. Press Rescan.", "error");
    return undefined;
  }
  if (!isListening()) {
    status(
      waiting === "readback"
        ? "Press Listen first: a write that cannot be read back is not verifiable."
        : "Press Listen first — otherwise nothing collects the reply.",
      "warn",
    );
    return undefined;
  }
  return output;
}

/**
 * The same, plus the product id the dump protocol needs to address anything at all.
 *
 * The storage API is addressed by path and does not need this; the `0x6n` requests do.
 */
export function readyDump(waiting: Await): { output: MIDIOutput; productId: number } | undefined {
  const output = readyOutput(waiting);
  if (!output) return undefined;

  const productId = lastProductId;
  if (productId === undefined) {
    // Both halves matter: probing may not have happened, or it happened and returned a product
    // this build has no dump-protocol entry for. They need different things done about them.
    status(
      "No dump-protocol product id for this device — probe it first, and if it has been probed, " +
        "it is a product this build does not know how to address.",
      "warn",
    );
    return undefined;
  }
  return { output, productId };
}
