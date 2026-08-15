/**
 * Editing a song — the operations, with no UI and no bytes.
 *
 * ## Why a layer between the panel and the writer
 *
 * `dn2song.ts` knows where a field lives; it does not know that deleting row 4 of an eighteen-row
 * song means shifting fourteen rows up and dropping the count to seventeen. That arithmetic is easy
 * to get subtly wrong and impossible to see once it has been written into a project, so it lives
 * here, once, and is tested on its own.
 *
 * Every function takes an image and returns a **new** one. That is what the manager's session wants:
 * it diffs before against after to build an undo step, and an operation that edited in place would
 * leave it nothing to diff.
 *
 * ## What the device does, and what this does
 *
 * These are the device's own operations, from the manual §10.13.2 — insert a row, remove a row, copy
 * a row, and the per-row parameters. `moveRow` is the one addition, because the manager's whole
 * vocabulary is dragging things into position and a song with no way to reorder would be the only
 * grid in the app you cannot rearrange.
 *
 * ## Nothing here writes to an instrument
 *
 * A song lives in the image tail, which the dump protocol cannot carry. An edited project is
 * exported as a file, or written whole to a +Drive slot. Songs are, in `deviceproject.ts`'s words,
 * "the one thing this project has always refused to risk".
 */

import {
  type Song,
  type SongRow,
  END_LOOP,
  LIMITS,
  SONG,
  SWING_BASE,
  readSong,
  writeSong,
} from "../project/dn2song.js";
import { type ImageLayout, DN2_LAYOUT } from "../project/dn2image.js";

export class SongEditError extends Error {}

/**
 * What a new row looks like.
 *
 * The device copies the selected row when you insert one — "the new row is added below the
 * currently selected row and is a copy of the selected row" (§10.13.2). So `insertRow` does that,
 * and this is only for the first row of an empty song, where there is nothing to copy.
 *
 * `(EMPTY)` rather than a keyword, and 50% swing rather than the pattern's: the row has no pattern
 * yet, so inventing musical defaults would be pretending to know something.
 */
export function blankRow(): SongRow {
  return {
    pattern: 0,
    repeats: 1,
    label: 0,
    labelName: "(EMPTY)",
    tempo: 120,
    mute: 0,
    length: 16,
    swing: SWING_BASE,
  };
}

/** Read a song, change it, write it back. Every operation below is one of these. */
function edit(
  image: Uint8Array,
  index: number,
  change: (song: Song) => Omit<Song, "index" | "loops">,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  const song = readSong(image, index, layout);
  return writeSong(image, index, change(song), layout);
}

function requireRow(song: Song, row: number): void {
  if (!Number.isInteger(row) || row < 0 || row >= song.rowCount) {
    throw new SongEditError(
      `row ${row} does not exist: song ${song.index + 1} has ${song.rowCount}`,
    );
  }
}

/** Replace one row's fields. */
export function setRow(
  image: Uint8Array,
  index: number,
  row: number,
  values: Partial<SongRow>,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  return edit(image, index, (song) => {
    requireRow(song, row);
    const rows = [...song.rows];
    // Spread over the row as read, so a caller changing one field cannot blank the rest by
    // omission — the failure mode of passing a whole row through a form.
    rows[row] = { ...rows[row]!, ...values };
    return { ...song, rows };
  }, layout);
}

/**
 * Put a pattern on a row.
 *
 * Its own function because it is the one edit that has a gesture: dragging a pattern from the grid
 * onto a row. Everything else is a field in a form.
 */
export function setRowPattern(
  image: Uint8Array,
  index: number,
  row: number,
  pattern: number,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  if (pattern < LIMITS.pattern.min || pattern > LIMITS.pattern.max) {
    throw new SongEditError(`pattern ${pattern} is outside 0..${LIMITS.pattern.max}`);
  }
  return setRow(image, index, row, { pattern }, layout);
}

/**
 * Insert a row below `after`, copying it — which is what the device does.
 *
 * `after` of `-1` inserts at the top, and an empty song gets a `blankRow` because there is nothing
 * to copy from.
 */
export function insertRow(
  image: Uint8Array,
  index: number,
  after: number,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  return edit(image, index, (song) => {
    if (song.rowCount >= SONG.rowCount) {
      throw new SongEditError(`a song holds ${SONG.rowCount} rows and this one is full`);
    }
    if (song.rowCount > 0) requireRow(song, after);

    const rows = [...song.rows];
    const source = song.rowCount === 0 ? blankRow() : { ...rows[after]! };
    rows.splice(after + 1, 0, source);
    return { ...song, rows, rowCount: rows.length };
  }, layout);
}

/** Remove a row, closing the gap. */
export function deleteRow(
  image: Uint8Array,
  index: number,
  row: number,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  return edit(image, index, (song) => {
    requireRow(song, row);
    const rows = [...song.rows];
    rows.splice(row, 1);
    return { ...song, rows, rowCount: rows.length };
  }, layout);
}

/**
 * Move a row to a new position.
 *
 * `to` is where it lands **after** the row has been lifted out, which is the interpretation a drag
 * has: dropping row 2 onto position 5 means "it should end up fifth", not "insert it before what
 * used to be fifth".
 */
export function moveRow(
  image: Uint8Array,
  index: number,
  from: number,
  to: number,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  return edit(image, index, (song) => {
    requireRow(song, from);
    requireRow(song, to);
    const rows = [...song.rows];
    const [lifted] = rows.splice(from, 1);
    rows.splice(to, 0, lifted!);
    return { ...song, rows };
  }, layout);
}

/** Rename a song. The device's SETTINGS > SONG > RENAME. */
export function renameSong(
  image: Uint8Array,
  index: number,
  name: string,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  return edit(image, index, (song) => ({ ...song, name }), layout);
}

/**
 * Set the song's own tempo.
 *
 * Distinct from a row's. The manual is explicit: *"Selecting song tempo on any row overrides all
 * the previously set row and pattern tempos"* — so this is the value that wins, and changing it is
 * not the same edit as changing a row's, however similar the two fields look on screen.
 */
export function setSongTempo(
  image: Uint8Array,
  index: number,
  tempo: number,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  return edit(image, index, (song) => ({ ...song, tempo }), layout);
}

/** Set whether the song loops or stops at the end. */
export function setEndMode(
  image: Uint8Array,
  index: number,
  endMode: number,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  return edit(image, index, (song) => ({ ...song, endMode }), layout);
}

/**
 * Empty a song. The device's SETTINGS > SONG > CLEAR.
 *
 * The name goes too. A cleared slot that kept its name would show in the tab strip as a song that
 * exists and has nothing in it, which is two different states drawn the same way.
 */
export function clearSong(
  image: Uint8Array,
  index: number,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  return writeSong(
    image,
    index,
    { name: "", rowCount: 0, endMode: END_LOOP, tempo: 120, rows: [] },
    layout,
  );
}

/** Toggle one track's mute on a row. Tracks are 1-based, as the instrument numbers them. */
export function toggleRowMute(
  image: Uint8Array,
  index: number,
  row: number,
  track: number,
  layout: ImageLayout = DN2_LAYOUT,
): Uint8Array {
  if (!Number.isInteger(track) || track < 1 || track > 16) {
    throw new SongEditError(`track ${track} is outside 1..16`);
  }
  return edit(image, index, (song) => {
    requireRow(song, row);
    const rows = [...song.rows];
    const bit = 1 << (track - 1);
    rows[row] = { ...rows[row]!, mute: rows[row]!.mute ^ bit };
    return { ...song, rows };
  }, layout);
}
