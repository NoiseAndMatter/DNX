/**
 * The file extensions Elektron's own tools give a Digitone object.
 *
 * ## Why this is not a constant
 *
 * A backup names every file it writes, and the name is the only thing that says which instrument
 * the bytes came off once the zip is open in a file browser. `soundbanks/A/001 DIGIT-ONE.dn2snd`
 * taken off a **Digitone 1** is a small lie that survives the backup: it will be read back later by
 * somebody who believes the name.
 *
 * The first backup written assumed a Digitone II throughout, because that is the instrument it was
 * built against. The Digitone 1 run on 2026-09-07 produced correct bytes under Digitone II names.
 *
 * ## What is known, and what is left out
 *
 * `.dnprj`/`.dn2prj` are on disk in the corpus for both instruments. `.dnsnd` is on disk from a
 * Digitone 1 sound export (`99_HardwareTest/HH TICK_PITX_AR.dnsnd`).
 *
 * **There is no kit entry here.** Only a Digitone II has a `/kits` directory, so a Digitone 1 kit
 * extension would be a value invented to fill a field — the kind of plausible-looking guess that
 * this codebase has paid for before. The kits branch of a backup names its own files.
 */

import { ProductId } from "../sysex/devices.js";

export interface ObjectExtensions {
  /** A whole project, as `projects/…` in a backup. */
  project: string;
  /** One preset, as `soundbanks/<bank>/…` in a backup. */
  sound: string;
}

const DN1: ObjectExtensions = { project: ".dnprj", sound: ".dnsnd" };
const DN2: ObjectExtensions = { project: ".dn2prj", sound: ".dn2snd" };

/**
 * What to call this instrument's files.
 *
 * Anything that is not a Digitone 1 is named as a Digitone II, because that is the instrument every
 * other product id in this codebase refers to and a backup that refused to name a file would be
 * worse than one naming it after the newer instrument.
 */
export function extensionsFor(productId: number): ObjectExtensions {
  return productId === ProductId.DN1 ? DN1 : DN2;
}
