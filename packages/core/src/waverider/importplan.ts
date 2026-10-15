/**
 * One decoded file becoming one slot's worth of table, decided before anything is sent.
 *
 * **One job: assemble the `PendingSlot` an import produces.** Decoding is the browser's, choosing
 * the shape is `fit.ts`, resizing is `spectral.ts`, packing is `convert.ts`, naming is `naming.ts`,
 * and writing is `waveriderwrite.ts`. This is the short function that puts them in the right order
 * with the right arguments, and it exists so there is exactly one of it: the staging pane and
 * anything else that imports audio later must produce identical bytes from identical input, and two
 * call sites assembling this by hand is how they come to disagree about the gain.
 *
 * ## The hash is of the file, not of the table
 *
 * `PendingSlot.sourceHash` is documented as the hash of the file the table was made from, for
 * recognising a re-import. The probe's own `pendingFrom` hashes the table instead, and is right to:
 * there the chosen file **is** the table, already converted, so the two are the same bytes. Here
 * they are not. Hashing the converted payload would mean the same WAV imported at two geometries
 * recorded two different sources, and a re-import of the same file at the same geometry would not
 * be recognisable as one.
 *
 * ## The gain is recorded and the level is not restored
 *
 * `convertTable` peak-normalises and reports what it applied; that number goes into the entry at
 * +96 where the format says it lives. **The firmware does not read it** — confirmed by the firmware
 * session on 2026-10-13, which found no reference to the field in `csrc/` and a DSP request
 * directory carrying only waves and points. So normalising is a permanent change to how loud this
 * table is, and the stored gain is a record of it rather than something that undoes it.
 *
 * Normalising is still the right default for a wavetable: each frame should use the full int16
 * range, which is what the oscillator reads. It is worth knowing it is a choice, and that two
 * tables imported from differently levelled sources come out equally loud.
 */

import { convertTable, type ConvertedTable } from "./convert.js";
import { WaveriderError } from "./errors.js";
import { blendToWaves, fitToGeometry, type FitResult, type Geometry } from "./fit.js";
import { INDEX_ENTRIES } from "./layout.js";
import { tableName } from "./naming.js";
import { type PendingSlot } from "./slotfile.js";
import { xxHash32 } from "./xxhash32.js";

/** A decoded file, as the import found it. */
export interface AudioSource {
  /** The file's own bytes. Hashed for the re-import record; never converted. */
  bytes: Uint8Array;
  /** Mono samples, nominally -1..1. Float WAV may exceed that and is not clamped on the way in. */
  samples: Float32Array | readonly number[];
}

/** What the person chose, or what was proposed and left alone. */
export interface ImportChoice {
  slot: number;
  /** The name's stem, usually a filename without its extension. */
  stem: string;
  geometry: Geometry;
  /**
   * Whether to leave the no-interpolation flag clear. Default `true`, meaning do interpolate.
   *
   * The flag is stored and never read: the player interpolates between frames regardless. Kept as
   * an option because the field exists and the name carries an `r` when it is set, so a table
   * written by DNX should be able to say the same thing a table written anywhere else says.
   */
  interpolate?: boolean;
  /**
   * Blend up from this shape instead of re-cutting the file.
   *
   * The shape the file already is — so only a file whose sample count divides into whole cycles
   * can blend. Absent, `geometry` re-cuts the samples as it always has. See `blendToWaves`.
   */
  blendFrom?: Geometry;
}

/** Everything the import decided, so a pane can show it before the write. */
export interface PlannedImport {
  pending: PendingSlot;
  /** How the source was made to fit, and what that cost. */
  fit: FitResult;
  /** What the conversion applied, including the gain the device will not undo. */
  converted: ConvertedTable;
}

/**
 * Plan one table.
 *
 * Throws `WaveriderError` for anything that cannot be done, which is the same class every step
 * below throws, so a caller has one thing to catch and one message to show.
 */
export function planImport(source: AudioSource, choice: ImportChoice): PlannedImport {
  const { slot, stem, geometry } = choice;
  if (!Number.isInteger(slot) || slot < 0 || slot >= INDEX_ENTRIES) {
    throw new WaveriderError(`slot ${slot} is outside 0..${INDEX_ENTRIES - 1}`);
  }
  const interpolate = choice.interpolate ?? true;

  const fit = choice.blendFrom
    ? blendToWaves(source.samples, choice.blendFrom, geometry)
    : fitToGeometry(source.samples, geometry);
  const converted = convertTable(fit.samples, geometry.waves, geometry.points);

  return {
    pending: {
      slot,
      name: tableName(stem, geometry.points, interpolate),
      waves: geometry.waves,
      points: geometry.points,
      interpolate,
      table: converted.payload,
      sourceHash: xxHash32(source.bytes),
      sourceSize: source.bytes.length,
      gain: converted.gain,
    },
    fit,
    converted,
  };
}

/**
 * `01 Basic Sine2Saw.wav` becomes `01 Basic Sine2Saw`.
 *
 * A filename is the one label that is already right and already matches whatever manifest produced
 * it, so a batch takes its names from the files rather than asking for them one at a time.
 */
export function stemFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim();
}

/** Where a drop of several files lands, and what stopped it if it did not. */
export interface Placement {
  /** One store slot per file, in the order the files were given. */
  slots: number[];
  /** Slots passed over because something already claims them. */
  skipped: number[];
}

/**
 * Place `count` files from `first` upward, skipping anything already claimed.
 *
 * **Skipping rather than refusing**, which is the opposite of what the batch control does, and the
 * difference is that nothing is written here. The batch asks once and then sends, so one occupied
 * slot has to stop the whole run before the first byte. A drop only stages, and a staged table can
 * be dragged to another slot or thrown away, so landing the files somewhere visible and saying
 * which slots were passed over is more use than refusing the drop and leaving the person to count
 * free slots by eye.
 *
 * `claimed` is both the occupied slots and the ones already staged. A drop that could not place
 * everything throws, because a drop that silently stages four of six files is worse than one that
 * stages none and says why.
 */
export function placeFrom(
  first: number,
  count: number,
  claimed: ReadonlySet<number>,
): Placement {
  if (!Number.isInteger(first) || first < 0 || first >= INDEX_ENTRIES) {
    throw new WaveriderError(`slot ${first} is outside 0..${INDEX_ENTRIES - 1}`);
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new WaveriderError(`cannot place ${count} files`);
  }

  const slots: number[] = [];
  const skipped: number[] = [];
  for (let slot = first; slot < INDEX_ENTRIES && slots.length < count; slot++) {
    if (claimed.has(slot)) skipped.push(slot);
    else slots.push(slot);
  }

  if (slots.length < count) {
    throw new WaveriderError(
      `${count} ${count === 1 ? "table needs" : "tables need"} ${count} free ` +
        `${count === 1 ? "slot" : "slots"} from ${first} upward and there ` +
        `${slots.length === 1 ? "is" : "are"} ${slots.length}. Drop them lower down, or delete ` +
        `something first.`,
    );
  }
  return { slots, skipped };
}
