/**
 * Rename patterns.
 *
 * The device has this: **SETTINGS > PATTERN > RENAME**, "opens the NAMING screen where you can
 * rename the active pattern" (DN2 manual §13.3.1). So this is the device's own operation, not
 * an invention, and the field it writes is the one the pattern-rearrangement hardware session
 * already validated — every expectation on that sheet was *"slot A13 should read `250423`"*,
 * read off the device's screen and checked. The name we write is the name it shows.
 *
 * ## It takes a map, though today only one entry is ever passed
 *
 * Batch renaming — by position, by selection order, from a base name, or by some other rule —
 * is coming. What arrives here is the *result* of such a rule, never the rule itself: a plain
 * `slot -> name` map. That keeps every scheme downstream of one verified writer, and means the
 * first batch scheme is a naming function plus nothing else.
 *
 * A rename is deliberately **not** a `Shuffle`. A shuffle answers "what ends up where", and
 * every one of its operations moves whole records around. A rename moves nothing; it edits
 * sixteen bytes in place. Squeezing it into the shuffle vocabulary would mean inventing a
 * "move that is not a move", and the manager's undo does not need it to be one — it stores
 * images, not operations.
 *
 * ## What the corpus says a name may contain
 *
 * The manual describes the naming screen but not its alphabet, so the alphabet came from the
 * files. Across **13,488** pattern and preset names in the corpus there is **not one lowercase
 * letter**, which is why input is upper-cased rather than refused: the device has no lowercase
 * to show, and a tool that rejected `kick` while the hardware simply types `KICK` would be
 * pedantry about a form with one meaning.
 *
 * Preset names use the full 16 bytes with no terminator, so the field is 16 characters and not
 * 15. (`writeProjectName` truncates to 15 for the *project* name, where nothing in the corpus
 * shows the last byte in use — that difference is real, not an inconsistency to tidy away.)
 *
 * Beyond A-Z and the digits the corpus shows space, `!`, `%`, `&`, `-`, `_` and the accented
 * `Å Æ Ç Ö Ü`. Rather than allow exactly that list — which would only ever prove what nobody
 * happened to type — anything printable in Latin-1 is allowed. The downside is a character the
 * screen renders oddly, which is visible and fixed by renaming again; the downside of being
 * stricter is a tool that refuses `#` for no reason anyone could state.
 */

import { patternRecord } from "../project/dn2image.js";
import { patternName } from "../sheet/naming.js";
import { type Device } from "./device.js";

/** The name field is 16 bytes on both families, and the corpus uses all 16. */
export const NAME_SIZE = 16;

const latin1 = new TextDecoder("latin1");

export interface RenameFinding {
  severity: "blocker" | "warning";
  message: string;
}

/** One slot's rename, as planned. */
export interface RenameChange {
  pattern: number;
  from: string;
  /** After normalisation — what will actually be written. */
  to: string;
}

export interface RenamePlan {
  changes: RenameChange[];
  findings: RenameFinding[];
  ok: boolean;
}

export class RenameError extends Error {}

/**
 * What a typed name becomes, and what had to be done to it.
 *
 * The notes are returned rather than logged so every surface can show the same ones. A silent
 * transformation is the thing to avoid here: someone who types a 20-character name and is given
 * 16 back should be told, not left to notice on the device.
 */
export function normaliseName(raw: string): { name: string; notes: string[] } {
  const notes: string[] = [];

  const trimmed = raw.trim();
  if (trimmed !== raw) notes.push("surrounding spaces removed");

  const upper = trimmed.toUpperCase();
  if (upper !== trimmed) notes.push("upper-cased — the device has no lowercase");

  const kept = [...upper].filter((c) => printable(c.codePointAt(0)!));
  if (kept.length !== [...upper].length) {
    const dropped = [...upper].filter((c) => !printable(c.codePointAt(0)!));
    notes.push(`dropped ${dropped.length} character(s) the device cannot store: ${dropped.join("")}`);
  }

  // Trim again. Dropping a character can expose a space that was in the middle a moment ago —
  // "INTRO 😀" becomes "INTRO " — and truncation can do the same by cutting mid-word. Trimming
  // only at the start would leave the name padded with something the user never typed.
  const name = kept.slice(0, NAME_SIZE).join("").trimEnd();
  if (kept.length > NAME_SIZE) {
    notes.push(`truncated to ${NAME_SIZE} characters, the width of the field`);
  }

  return { name, notes };
}

/** Printable Latin-1: the ASCII range plus the accented block, excluding the C1 controls. */
function printable(code: number): boolean {
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);
}

/** Read one pattern's name, stopping at a NUL or at the end of the field. */
export function readPatternName(image: Uint8Array, device: Device, pattern: number): string {
  const record = patternRecord(image, pattern, device.layout);
  const raw = record.subarray(nameAt(device), nameAt(device) + NAME_SIZE);
  const nul = raw.indexOf(0);
  return latin1.decode(nul === -1 ? raw : raw.subarray(0, nul));
}

function nameAt(device: Device): number {
  return device.patternNameOffset;
}

/**
 * What renaming these slots would do, and anything worth saying before it happens.
 *
 * Blocks on a slot the device cannot parse. Writing a name into a record whose storage version
 * we do not understand puts sixteen bytes at an offset that may well mean something else there
 * — the same reason `PRESETS.dn2prj` gets its MIDI mask read only on version 3.
 */
export function planRename(
  image: Uint8Array,
  device: Device,
  renames: ReadonlyMap<number, string>,
): RenamePlan {
  const changes: RenameChange[] = [];
  const findings: RenameFinding[] = [];

  for (const [pattern, raw] of [...renames].sort((a, b) => a[0] - b[0])) {
    if (!Number.isInteger(pattern) || pattern < 0 || pattern >= device.patternCount) {
      findings.push({
        severity: "blocker",
        message: `slot ${pattern} is outside this ${device.name}'s ${device.patternCount} patterns`,
      });
      continue;
    }

    const summary = device.summarise(image, pattern);
    if (!summary.supported) {
      findings.push({
        severity: "blocker",
        message:
          `${patternName(pattern)} has storage version ${summary.version}, which this build cannot ` +
          `read — the name field may not be where we think it is`,
      });
      continue;
    }

    const { name, notes } = normaliseName(raw);
    if (name === "") {
      findings.push({
        severity: "blocker",
        message: `${patternName(pattern)} was given a name with nothing storable in it`,
      });
      continue;
    }
    for (const note of notes) {
      findings.push({ severity: "warning", message: `${patternName(pattern)}: ${note}` });
    }

    const from = readPatternName(image, device, pattern);
    if (from === name) {
      findings.push({
        severity: "warning",
        message: `${patternName(pattern)} is already called "${name}", so nothing would change`,
      });
      continue;
    }

    if (!summary.occupied) {
      findings.push({
        severity: "warning",
        message: `${patternName(pattern)} is empty, so the name is all it will have`,
      });
    }

    changes.push({ pattern, from, to: name });
  }

  // Duplicates are legal — the device does not stop you — but the pattern hardware session
  // learned what they cost: two slots sharing a name makes a swap unfalsifiable, and by then
  // the evidence is already gone.
  for (const [name, slots] of duplicates(image, device, changes)) {
    findings.push({
      severity: "warning",
      message:
        `${slots.length} slots would be called "${name}" (${slots.map(patternName).join(", ")}) — legal, but ` +
        `two patterns with one name cannot be told apart on the device`,
    });
  }

  return {
    changes,
    findings,
    ok: !findings.some((f) => f.severity === "blocker"),
  };
}

/** Names that would end up on more than one slot, counting the ones already there. */
function duplicates(
  image: Uint8Array,
  device: Device,
  changes: readonly RenameChange[],
): Map<string, number[]> {
  const renamed = new Map(changes.map((c) => [c.pattern, c.to]));
  const byName = new Map<string, number[]>();

  for (let pattern = 0; pattern < device.patternCount; pattern++) {
    const summary = device.summarise(image, pattern);
    if (!summary.supported || !summary.occupied) continue;
    const name = renamed.get(pattern) ?? readPatternName(image, device, pattern);
    byName.set(name, [...(byName.get(name) ?? []), pattern]);
  }

  const wanted = new Set(changes.map((c) => c.to));
  return new Map([...byName].filter(([name, slots]) => slots.length > 1 && wanted.has(name)));
}

/**
 * Write the names, returning a new image.
 *
 * The whole operation is sixteen bytes per slot, NUL-padded to the full field so a shorter name
 * cannot leave the tail of a longer one behind it — `"MY PATTERN"` over `"MY PATTERN LONG"`
 * would otherwise read back as the original.
 */
export function applyRename(
  image: Uint8Array,
  device: Device,
  renames: ReadonlyMap<number, string>,
): { image: Uint8Array; plan: RenamePlan } {
  const plan = planRename(image, device, renames);
  if (!plan.ok) {
    throw new RenameError(
      `Cannot rename:\n${plan.findings
        .filter((f) => f.severity === "blocker")
        .map((f) => `  - ${f.message}`)
        .join("\n")}`,
    );
  }

  const next = Uint8Array.from(image);
  for (const change of plan.changes) {
    const record = patternRecord(next, change.pattern, device.layout);
    const at = nameAt(device);
    record.fill(0, at, at + NAME_SIZE);
    record.set(Uint8Array.from([...change.to].map((c) => c.codePointAt(0)!)), at);
  }

  return { image: next, plan };
}

export interface VerifyRenameResult {
  ok: boolean;
  problems: string[];
}

/**
 * Confirm the rename did what it said, and **only** that.
 *
 * Two questions, and the second is the one worth the code. Re-reading the names checks the
 * writer against the reader, which is our code agreeing with itself. Diffing the two images
 * checks that a rename is genuinely a sixteen-byte edit: any byte that moved outside a name
 * field is a bug in the offset, the layout or the record slicing, and it would be invisible to
 * a name-only check right up until the device refused the project.
 */
export function verifyRename(
  before: Uint8Array,
  after: Uint8Array,
  device: Device,
  plan: RenamePlan,
): VerifyRenameResult {
  const problems: string[] = [];

  if (before.length !== after.length) {
    return { ok: false, problems: [`image length changed: ${before.length} -> ${after.length}`] };
  }

  for (const change of plan.changes) {
    const got = readPatternName(after, device, change.pattern);
    if (got !== change.to) {
      problems.push(`${patternName(change.pattern)} should read "${change.to}" but reads "${got}"`);
    }
  }

  // Every byte the write was allowed to touch.
  const allowed: { start: number; end: number }[] = plan.changes.map((c) => {
    const start = device.layout.headerSize + c.pattern * device.layout.patternSize + nameAt(device);
    return { start, end: start + NAME_SIZE };
  });
  const mayChange = (i: number): boolean => allowed.some((r) => i >= r.start && i < r.end);

  let strayCount = 0;
  let firstStray = -1;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    if (mayChange(i)) continue;
    strayCount++;
    if (firstStray === -1) firstStray = i;
  }
  if (strayCount > 0) {
    problems.push(
      `${strayCount} byte(s) changed outside the name fields, first at ${firstStray} — a rename ` +
        `must be ${NAME_SIZE} bytes per slot and nothing else`,
    );
  }

  return { ok: problems.length === 0, problems };
}
