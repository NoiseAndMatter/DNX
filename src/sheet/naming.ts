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
