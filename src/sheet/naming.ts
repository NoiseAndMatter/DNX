/**
 * Naming concern: say positions the way the device says them.
 *
 * The machine has no "pattern 21" and no "step 46". It has bank B pattern 5, and page 3
 * step 14. A sheet that counts differently from the hardware is a sheet you cannot follow
 * while standing at the hardware, so every position leaves this module already translated.
 */

const BANKS = "ABCDEFGH";

/** Steps per page on the Digitone II, and therefore the highest step number ever shown. */
export const STEPS_PER_PAGE = 16;

/** Patterns per bank. 8 banks x 16 = the 128-slot array. */
export const PATTERNS_PER_BANK = 16;

/** Pattern index 0..127 as the device labels it: `A1`..`H16`. */
export function patternName(index: number): string {
  const bank = BANKS[Math.floor(index / PATTERNS_PER_BANK)] ?? "?";
  return `${bank}${(index % PATTERNS_PER_BANK) + 1}`;
}

/**
 * Parse a device-style pattern name back to an index: `A1` to 0, `B5` to 20.
 *
 * The inverse of `patternName`, for command lines and anywhere else a person types a
 * position. Returns undefined rather than guessing at anything unparseable.
 */
export function patternIndex(name: string): number | undefined {
  const match = /^([A-Ha-h])\s*(\d{1,2})$/.exec(name.trim());
  if (!match) return undefined;

  const bank = BANKS.indexOf(match[1]!.toUpperCase());
  const position = Number(match[2]);
  if (bank < 0 || position < 1 || position > PATTERNS_PER_BANK) return undefined;

  return bank * PATTERNS_PER_BANK + (position - 1);
}

/** Step index 0..127 as `page·step`, both 1-based and never above 16. */
export function stepName(step: number): string {
  return `p${Math.floor(step / STEPS_PER_PAGE) + 1}·${(step % STEPS_PER_PAGE) + 1}`;
}

/**
 * A set of steps grouped by page: `p1: 1, 5, 13 · p2: 3`.
 *
 * Grouping matters more than it looks: twelve trigs listed as raw indices are unreadable at
 * the machine, and the same twelve grouped by page can be checked page by page against what
 * the device is showing.
 */
export function stepsByPage(steps: readonly number[]): string {
  const pages = new Map<number, number[]>();
  for (const step of [...steps].sort((a, b) => a - b)) {
    const page = Math.floor(step / STEPS_PER_PAGE) + 1;
    const within = (step % STEPS_PER_PAGE) + 1;
    const list = pages.get(page);
    if (list) list.push(within);
    else pages.set(page, [within]);
  }
  return [...pages].map(([page, list]) => `p${page}: ${list.join(", ")}`).join(" · ");
}

/**
 * The build time, `HHMM`, for stamping into a project name.
 *
 * **This is how you know which build is on the instrument.** A project loaded from the +Drive shows
 * only its name, so without the stamp a fix and the bug it fixes are the same fifteen characters —
 * and an hour was once spent testing a build that had never been rebuilt.
 *
 * Five copies of this line existed: both hardware-test CLIs, `cli/convert.ts`, `device/capture.ts`
 * and `web/src/app.ts`. Local time on purpose: the person reading it is standing next to the
 * device, and UTC would make them do arithmetic to answer "is this the one I just made".
 */
export function hhmm(when = new Date()): string {
  return `${String(when.getHours()).padStart(2, "0")}${String(when.getMinutes()).padStart(2, "0")}`;
}

/**
 * How much of a project name is kept when the build time is stamped onto the end.
 *
 * **One character short of `NAME_SIZE`, which is 16.** Both copies of this stamping logic said 15
 * and neither said why; the field really is sixteen wide (`rename.ts` truncates there and calls it
 * "the width of the field"). Preserved rather than corrected, because a name that overruns on
 * hardware is a worse outcome than a name one character shorter than it could be, and nothing here
 * establishes which is right. Worth one look at the device before changing.
 */
export const STAMPED_NAME_SIZE = 15;

/**
 * A project name with the build time on the end, trimmed to fit the device field.
 *
 * `MORNING JAM` becomes `MORNING JA 1640`. Two copies of this existed — one in the converter, one
 * in the expander page — each carrying the width limit separately.
 */
export function stampedProjectName(base: string, when = new Date()): string {
  const stamp = hhmm(when);
  return `${base.slice(0, STAMPED_NAME_SIZE - stamp.length - 1).trimEnd()} ${stamp}`;
}