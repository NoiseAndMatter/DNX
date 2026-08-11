/**
 * What changed since the last time you asked.
 *
 * ## One idea, and it was written twice
 *
 * The probe answers two questions the same way: *list a directory, change something on the device,
 * list again, read the diff* — and *ask an information code, change something, ask again, read the
 * diff*. Both had their own `Map` and their own inline comparison a hundred lines apart, and
 * neither was reachable without an instrument.
 *
 * ## The method these exist to serve
 *
 * **The device answers the question itself.** A `/projects` listing carries four bytes per entry
 * that nothing here can explain and that differ between projects — `PRESETS` reads `0012 0101`
 * where `MORNING_JAM` and `AMBZ` read `007e 0101`. If one of them tracks the loaded project, that
 * is a fact the dump protocol cannot supply, because the project name lives at image offset 8 in
 * the one region no dump carries.
 *
 * The way to find out is not to reason about it. It is to change the thing and look. Reasoning is
 * the method that has repeatedly failed on this protocol; asking twice is the method that has not.
 *
 * ## Pure, and that is the point
 *
 * `before` is an argument rather than a lookup, so the comparison can be exercised without a
 * device, a page, or a `Map` that survives between calls. Remembering belongs to the caller —
 * these say only what two observations differ by.
 *
 * **"Nothing changed" is never silence.** A negative result is the whole point of asking twice: an
 * identical answer says the thing you changed is *not* in this field, which narrows the search as
 * much as a difference would. Returning nothing would make that indistinguishable from not having
 * looked.
 */

import { type Entry } from "../../../src/device/storage.js";

/** Two hex digits, as the probe prints every byte. */
const hex2 = (byte: number): string => byte.toString(16).padStart(2, "0");

const trailerOf = (entry: Entry): string =>
  entry.trailer ? [...entry.trailer].map(hex2).join(" ") : "—";

/**
 * How one directory listing differs from the one before it.
 *
 * `undefined` means there is nothing to compare against yet — the first listing of a path is not a
 * result, and saying so is different from saying nothing changed.
 */
export function describeListingChange(
  before: readonly Entry[] | undefined,
  now: readonly Entry[],
): string | undefined {
  if (!before) return undefined;

  const wasByIndex = new Map(before.map((e) => [e.index, e]));
  const nowByIndex = new Map(now.map((e) => [e.index, e]));
  const moved: string[] = [];

  for (const [index, entry] of nowByIndex) {
    const was = wasByIndex.get(index);
    if (!was) {
      moved.push(`${index} ${entry.name} appeared`);
      continue;
    }
    if (was.name !== entry.name) moved.push(`${index} renamed ${was.name} → ${entry.name}`);
    // The trailer is the unexplained part, and therefore the interesting part.
    const from = trailerOf(was);
    const to = trailerOf(entry);
    if (from !== to) moved.push(`${index} ${entry.name}: ${from} → ${to}`);
  }
  for (const index of wasByIndex.keys()) {
    if (!nowByIndex.has(index)) moved.push(`${index} disappeared`);
  }

  return moved.length === 0
    ? "nothing — every entry is byte-identical to the last listing"
    : moved.join(" · ");
}

/**
 * How one answer to an information code differs from the answer before it.
 *
 * The three outcomes are deliberately three sentences rather than two: a first ask is not evidence,
 * an identical answer rules the field out, and a changed one is the find.
 */
export function describeAnswerChange(before: string | undefined, now: string): string {
  if (before === undefined) return "first time — ask again after changing something on the device";
  if (before === now) return "IDENTICAL — whatever changed on the device is not in this answer";
  return `CHANGED — was ${before}`;
}

/** True when an answer is worth saying out loud in the status bar rather than only on the card. */
export function answerIsNews(before: string | undefined, now: string): boolean {
  return before !== undefined && before !== now;
}
