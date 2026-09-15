/**
 * Whether the probe should ask which instrument it is talking to, rather than guess.
 *
 * Split out of `ports.ts` so this one decision can be tested with plain objects and no DOM.
 * `ports.ts` itself reaches into `MIDIAccess`'s port maps with methods (`.values()`, `.get()`,
 * `.has()`) that only typecheck under the browser build's `lib` (`tsconfig.web.json` adds
 * `DOM.Iterable`; the root `tsconfig.json` used for `test/**` does not). A test file importing
 * anything from `ports.ts` would pull that whole file into the root program and fail to typecheck
 * on code the test never touches. This module touches none of it.
 */

import { candidatePairs } from "../devicelink.js";

/** The minimum a port needs to be scored: `candidatePairs` reads only `id` and `name`. */
export interface PortLike {
  id: string;
  name?: string | null;
}

/**
 * Whether the ports on offer name more than one plausible instrument, so a guess would be a coin
 * flip between candidates rather than a reasonable default.
 *
 * ## Why "identical name on both ends" rather than merely "a candidate pair"
 *
 * `candidatePairs` returns one entry per output, always, including a poor guess with no shared
 * prefix at all, on the chance it is still worth trying. Counting those would ask the user to
 * choose every time a stray output with an unrelated name showed up beside a single real
 * instrument, which is the common case this exists to leave alone.
 *
 * A pair whose input and output names are **identical** carries a different weight: that is the
 * OS naming both ends of one interface alike, as confident as this guessing ever gets. Two of
 * those at once is the actual ambiguity a Digitone 1 and a Digitone II present side by side
 * ("Elektron Digitone" on both ends of one, "Elektron Digitone II" on both ends of the other):
 * two real candidates, the situation this function exists to catch. That pairing is what "more
 * than one plausible instrument" means here.
 */
export function needsPortChoice(inputs: PortLike[], outputs: PortLike[]): boolean {
  const pairs = candidatePairs(inputs as unknown as MIDIInput[], outputs as unknown as MIDIOutput[]);
  const confident = pairs.filter(
    (pair) => (pair.input.name ?? "") !== "" && pair.input.name === pair.output.name,
  );
  return confident.length >= 2;
}
