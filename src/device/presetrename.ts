/**
 * Rename a preset stored on the +Drive: the bytes, without the device.
 *
 * ## What a stored preset is, measured on a Digitone II
 *
 * Read in **stored** form — the only form a write accepts — `/soundbanks/H/1` is **267 bytes**: the
 * 31-byte container header, an LZ4 block chain, and the 12-byte trailer. The chain decodes to the
 * **364-byte body** a raw read returns: a five-byte prefix, then the 359-byte sound object. Header
 * `+25` holds 364, the *uncompressed* body length, in both forms; the trailer holds the chain's own
 * length. `+23` is the bank (7 for H) and `+24` the zero-based slot.
 *
 * So a rename is: decode the chain, write sixteen bytes of name into the object, and encode it again
 * under the same header. That is exactly what `buildPayload` does for a project, and it is used here
 * unchanged — the body's length does not move, so `+25` stays true, and the trailer's length and
 * check field are recomputed over the new chain.
 *
 * ## The name field
 *
 * Sixteen bytes at object `+12`, Latin-1, padded with `0x00`: all 545 named sound objects sampled
 * from the corpus pad with zero. The rules for what a name may contain are the pattern rename's,
 * from `normaliseName`, because the naming screen is the same screen.
 *
 * **An empty name is refused.** A pool slot whose name is all zero reads as empty to every audit in
 * this codebase, and a preset renamed to nothing would be dropped into a pool and then counted as a
 * free slot.
 */

import { decodeProjectImage } from "../project/dn2codec.js";
import { SOUND_NAME_OFFSET, SOUND_NAME_SIZE } from "../project/soundmap.js";
import { buildPayload } from "../project/write.js";
import { normaliseName } from "../librarian/rename.js";
import { objectInStoredBody } from "./library.js";
import { FORM_FLAG_OFFSET, FORM_STORED } from "./storagewrite.js";

export class PresetRenameError extends Error {}

export interface PresetRename {
  /** The stored file to write back: same header, re-encoded body. */
  bytes: Uint8Array;
  /** The name as it was read. */
  from: string;
  /** The name as it will be written, after normalisation. */
  to: string;
  /** Anything done to what was typed — upper-casing, truncation — so a surface can say so. */
  notes: string[];
  /** False when the normalised name is the name already there. Nothing needs writing. */
  changed: boolean;
}

const OBJECT_MAGIC = [0xbe, 0xef, 0xba, 0xce] as const;
const latin1 = new TextDecoder("latin1");

/** The preset's name, out of a stored file. */
export function storedPresetName(stored: Uint8Array): string {
  const { object } = decodePreset(stored);
  return readName(object);
}

/**
 * Build the renamed file.
 *
 * Refuses rather than guesses on anything that is not a stored preset: a raw-form read (which the
 * device would refuse at the commit), a body with no sound object in it, or a name that would leave
 * the field empty.
 */
export function renamePresetFile(stored: Uint8Array, typed: string): PresetRename {
  const { body, object, objectAt } = decodePreset(stored);
  const from = readName(object);

  const { name: to, notes } = normaliseName(typed);
  if (to === "") {
    throw new PresetRenameError(
      "a preset needs a name. An empty name field is how an empty pool slot is recognised, so a " +
        "preset with none would be counted as free the first time it is added to a project.",
    );
  }
  if (to === from) {
    return { bytes: stored, from, to, notes, changed: false };
  }

  const edited = Uint8Array.from(body);
  const field = new Uint8Array(SOUND_NAME_SIZE); // zero-padded, as every named sound in the corpus
  for (let i = 0; i < to.length; i++) field[i] = to.charCodeAt(i);
  edited.set(field, objectAt + SOUND_NAME_OFFSET);

  const bytes = buildPayload(stored, edited);

  // Checked here rather than trusted: the whole claim is that only the name moved, and a write to
  // the instrument is the wrong place to discover it did not.
  const back = decodeProjectImage(bytes).image;
  if (back.length !== edited.length || back.some((b, i) => b !== edited[i])) {
    throw new PresetRenameError("the rebuilt preset does not decode to the renamed body; nothing was written");
  }
  for (let i = 0; i < 31; i++) {
    if (i !== FORM_FLAG_OFFSET && bytes[i] !== stored[i]) {
      throw new PresetRenameError(`the rebuilt preset's header changed at +${i}; nothing was written`);
    }
  }

  return { bytes, from, to, notes, changed: true };
}

function decodePreset(stored: Uint8Array): { body: Uint8Array; object: Uint8Array; objectAt: number } {
  if (stored.length <= FORM_FLAG_OFFSET || stored[FORM_FLAG_OFFSET] !== FORM_STORED) {
    throw new PresetRenameError(
      "this is not a stored-form preset (flag at +29 is not 0x01). Read the slot with STORED_FORM: " +
        "the raw form cannot be written back.",
    );
  }

  let body: Uint8Array;
  try {
    body = decodeProjectImage(stored).image;
  } catch (error) {
    throw new PresetRenameError(`the stored preset did not decode: ${String(error)}`);
  }

  const { object, prefix } = objectInStoredBody(body);
  if (!OBJECT_MAGIC.every((b, i) => object[i] === b)) {
    throw new PresetRenameError("no sound object in this file's body, so there is no name field to write");
  }
  if (object.length < SOUND_NAME_OFFSET + SOUND_NAME_SIZE) {
    throw new PresetRenameError(`the sound object is ${object.length} bytes, too short to hold a name`);
  }
  return { body, object, objectAt: prefix.length };
}

function readName(object: Uint8Array): string {
  const raw = object.subarray(SOUND_NAME_OFFSET, SOUND_NAME_OFFSET + SOUND_NAME_SIZE);
  const nul = raw.indexOf(0);
  return latin1.decode(nul === -1 ? raw : raw.subarray(0, nul));
}
