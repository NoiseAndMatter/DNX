/**
 * What the probe reads out of bytes, before anything is drawn.
 *
 * Hex digits, the shape of a payload, the sizes we can name, and the one real check this page makes
 * against a device's own arithmetic. None of it touches a document, a MIDI port or a device handle:
 * every function here takes bytes or numbers and returns a string or a row.
 *
 * ## Why it left `main.ts` and `cards.ts`
 *
 * The same reason `changes.ts`, `silence.ts` and `timing.ts` did before it — **a pure thing inside a
 * DOM module is a pure thing nobody can test.** `describeChunkChecksums` is the strongest piece of
 * evidence this page produces about the +Drive's checksum field, and it sat 1,800 lines into a
 * module that cannot be imported without a browser, so it had never been run against a byte anyone
 * chose.
 *
 * ## The formatters were duplicated, which is the second reason
 *
 * `hex2` existed **twice** — exported from `cards.ts` and declared again as a local in
 * `changes.ts` — and `hex8` sat beside a function that writes `innerHTML`. Two implementations of a
 * formatter is how one card comes to print a byte differently from the card beneath it; this
 * project has already shipped that fault once, in a clock and a bar count that disagreed across two
 * halves of one page. One definition, imported by everyone who prints a number.
 */

import { driveChecksum } from "../../../src/device/storage.js";
import { type StoredFile } from "../../../src/device/storagesession.js";

/** Two hex digits, for a byte. */
export function hex2(b: number): string {
  return b.toString(16).padStart(2, "0");
}

/** Eight hex digits, for a 32-bit field. */
export function hex8(v: number): string {
  return v.toString(16).padStart(8, "0");
}

/**
 * Does this payload open with a ZIP local-file header?
 *
 * A Digitone project read off the +Drive is a ZIP container, so `PK` at the front is the quickest
 * confirmation that a read returned the thing it was asked for rather than an error body or a
 * fragment. It is a shape check and nothing more — it says the first two bytes are right, not that
 * the archive is whole.
 */
export function looksLikeZip(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b;
}

/**
 * Record sizes we can name, so an unfamiliar payload is measured rather than guessed at.
 *
 * **Every record identified so far was recognised by its size first** — 99,840 as pattern + kit,
 * 359 as a DN2 sound, 512 as DN2 settings. A payload matching none of these is the interesting
 * case, and saying so plainly is more use than a guess dressed as a reading.
 */
export const KNOWN_RECORD_SIZES: Readonly<Record<string, number>> = {
  "a DN2 patternKit": 99_840,
  "a DN1 patternKit": 20_992,
  "a DN2 kit": 10_752,
  "a DN1 kit": 2_560,
  "a DN2 sound": 359,
  "a DN1 sound": 302,
  "DN2 project settings": 512,
  "DN1 project settings": 11_776,
};

/**
 * Hold every chunk's reported checksum against `driveChecksum` computed over the same slice.
 *
 * **The one place this page marks its own homework.** `driveChecksum` was solved against whole
 * small files; that it also holds over an arbitrary 2,048-byte window is an assumption until a real
 * read says so, and a read of any size gives one test per chunk for free.
 *
 * Read-only, and it decides the write question: `writeStoredFile` currently sends the whole file's
 * checksum on every `0x58`, which was a guess from the one single-chunk upload ever captured. The
 * read path has always collected one checksum *per chunk*. If our own algorithm reproduces those,
 * a writer can compute the value for any chunking it likes — and a project stops being special.
 *
 * **Reported as a count of agreements rather than a verdict.** A partial match is the interesting
 * outcome and the one a summary would hide: it would mean the boundaries are not where we think.
 *
 * The pass wording is careful for the same reason. Reads and writes **do not use this field the
 * same way** — a write declaring these same per-chunk values was refused, and so was one declaring
 * the whole file's — so agreement here settles the algorithm and settles nothing about what a
 * write should carry.
 */
export function describeChunkChecksums(file: StoredFile): [string, string][] {
  const sums = file.chunkChecksums;
  if (sums.length === 0) return [];

  /*
   * **Walked with the recorded lengths, never re-derived.** Dividing the total by the chunk count
   * gave 1,800-byte slices for a file the device sent as 2,048s, and every comparison failed for
   * that reason alone — a wrong answer that looked exactly like a wrong algorithm. `chunkLengths`
   * exists because of this, and is the only thing that knows the bytes the device checksummed.
   */
  const mismatches: string[] = [];
  let at = 0;
  for (const [i, reported] of sums.entries()) {
    const length = file.chunkLengths[i] ?? 0;
    const computed = driveChecksum(file.bytes.subarray(at, at + length));
    at += length;
    if (computed !== reported) {
      mismatches.push(`#${i} device ${hex8(reported)} vs ours ${hex8(computed)}`);
    }
  }

  return [
    ["Chunk sizes", file.chunkLengths.join(", ")],
    [
      "Chunk checksums",
      `${sums.length}, ${sums.slice(0, 4).map(hex8).join(" ")}${sums.length > 4 ? " …" : ""}`,
    ],
    [
      "driveChecksum agrees",
      mismatches.length === 0
        ? `all ${sums.length} — the algorithm is right at chunk granularity. Note this says nothing ` +
          `about writing: a write declaring these same per-chunk values was refused, and so was one ` +
          `declaring the whole file's. Reads and writes do not use this field the same way.`
        : `${sums.length - mismatches.length} of ${sums.length}. ${mismatches.slice(0, 3).join("; ")}`,
    ],
  ];
}
