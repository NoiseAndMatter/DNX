/**
 * The donor — the Digitone II project a device read borrows its missing bytes from.
 *
 * ## Why a device read needs one at all
 *
 * Dumps carry patterns and kits. They do not carry the project header, the song table or the slot
 * array: about 0.49% of the image, and without it there is no project, only most of one. So every
 * path that turns dumps into something openable needs a donor first.
 *
 * ## Why this is a module rather than a line in each page
 *
 * There are four such paths across two pages — the manager's Open Device, and the expander's blank
 * destination, device read and export — and all four asked the same question with four different
 * answers. Three of them refused when a perfectly good donor was compiled into the page: the
 * manager's Open Device said *"No template available"*, which sends you looking for a file the code
 * already has.
 *
 * Same reasoning that moved the grid and `devicesource.ts` up a level. A question four callers ask
 * gets one answer.
 *
 * ## Where a donor comes from, in order
 *
 * 1. **A project the user picked**, when the page has one — their device, their firmware.
 * 2. **`EMPTY.dn2prj` from the local server**, found the way every CLI command finds it.
 * 3. **The blank embedded in the code**, so a fresh clone with no corpus and no server still works.
 *
 * The order is by how well the donor is known to match *this* instrument, and that ordering is the
 * point. `src/cli/serve.ts` argues at length that a template must match the storage version the
 * device writes, and it is right — ours is version 3 from firmware 1.10E. The embedded blank is
 * therefore the **last** resort and says so out loud through `describeDonor`, rather than being
 * either bundled as *the* template or withheld until the page is useless without it.
 */

import { blankDn2ProjectFile } from "@noiseandmatter/dnx-core/librarian/blankproject.js";
import { fetchServedTemplate, readProjectFile, type LoadedProject } from "./project.js";

/** Where a donor came from, worst-matched last. */
export type DonorOrigin = "picked" | "served" | "built-in";

export interface Donor {
  project: LoadedProject;
  origin: DonorOrigin;
}

/**
 * The firmware the embedded blank was written by.
 *
 * Named rather than left in prose because it is the one fact that decides whether the built-in
 * donor is safe for a given instrument, and a user can only check it if we say it.
 */
export const BUILT_IN_BLANK_FIRMWARE = "1.10E";

/**
 * A donor, always.
 *
 * Never returns `undefined` and never throws for want of a template: the embedded blank is the
 * floor. A served template that exists but cannot be read is reported through `onProblem` and
 * stepped over — because "the template is broken" and "there is no template" are different
 * problems, and answering the first with the second is what made this bug hard to see.
 */
export async function loadDonor(
  options: { picked?: LoadedProject | undefined; onProblem?: (message: string) => void } = {},
): Promise<Donor> {
  if (options.picked) return { project: options.picked, origin: "picked" };

  try {
    const served = await fetchServedTemplate();
    if (served) return { project: served, origin: "served" };
  } catch (error) {
    options.onProblem?.(
      `The template the local server offered could not be read (${
        error instanceof Error ? error.message : String(error)
      }). Using the blank built into DNX instead.`,
    );
  }

  return { project: await readProjectFile("blank.dn2prj", blankDn2ProjectFile()), origin: "built-in" };
}

/**
 * One phrase naming the donor, for a status line.
 *
 * The built-in one carries its firmware because it is the only donor whose match to the connected
 * instrument is unverified — everything else came from the user's own machine.
 */
export function describeDonor(donor: Donor): string {
  if (donor.origin === "built-in") {
    return `DNX's built-in blank (device-authored on firmware ${BUILT_IN_BLANK_FIRMWARE})`;
  }
  return donor.project.fileName;
}
