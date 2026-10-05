/**
 * What a table is called on the device's screen.
 *
 * **One job, and it is display.** It lives apart from `convert.ts` because a name is not part of
 * converting audio: the conversion produces bytes, and this produces something for a person
 * reading a +Drive listing on a small screen.
 *
 * ## Nothing reads this back
 *
 * `_wt<points>` gives the wave size and a trailing `r` means no interpolation, which is Tonverk's
 * convention. **The geometry lives in the index**, and `entries.ts` decodes the name as a label
 * only. DNX writes the convention into the name for people; nothing parses it.
 *
 * That separation is the point. This project has twice been bitten by a number that was inferred
 * rather than stored — the song array's record count, and a row count read as one byte — and a
 * name that carries meaning is a format with no version field.
 */

import { ENTRY } from "./entries.js";

/**
 * The display name for a table, with the convention appended.
 *
 * Truncated to fit the entry's 64 bytes **with the suffix intact**, because the suffix is the part
 * that carries information and the stem is the part somebody can still recognise shortened.
 */
export function tableName(stem: string, points: number, interpolate: boolean): string {
  const suffix = `_wt${points}${interpolate ? "" : "r"}`;
  const room = ENTRY.nameBytes - suffix.length;
  const trimmed = stem.length > room ? stem.slice(0, room) : stem;
  return `${trimmed}${suffix}`;
}
