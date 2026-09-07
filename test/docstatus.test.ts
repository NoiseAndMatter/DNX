/**
 * A byte cannot be unknown in one place and solved in another.
 *
 * ## The failure this exists to stop
 *
 * `dn2-pattern-format.md` opens each section with a summary table of offsets and their confidence,
 * then decodes fields in prose below. **The tables do not get updated when the prose solves
 * something.** Three offsets in the track-record table said INFERRED or UNKNOWN while sections
 * fifty to a hundred and sixty lines lower said SOLVED and VERIFIED about the same bytes, one of
 * them since July. The §5 settings table and §3.6 disagreed the same way.
 *
 * That is not untidiness. **Somebody reads the table, believes the field is open, and re-derives
 * it.** It has already bought a hardware test written for a closed question and a caveat shown to
 * users about a table solved on hardware two months earlier.
 *
 * A reviewer will not catch it. The two statements are never on the same screen.
 *
 * ## What it checks
 *
 * Within one top-level section, an offset must not be claimed both established and unestablished.
 * Scoping to the section is what keeps it honest: `+0x10` means one thing in the settings block and
 * another in the pattern metadata, and those live in different sections.
 *
 * INFERRED against UNKNOWN is not a conflict. Both say the field is open, and the difference
 * between them is a judgement about evidence rather than a contradiction.
 *
 * ## This test shipped broken, and the way it broke is the interesting part
 *
 * It was green here and red on a fresh clone. `.` does not match a line terminator in a JavaScript
 * regex and `\r` is one, so on a CRLF checkout `/^##\s+(?!#)(.*)$/` matched **zero** headings:
 * `(.*)` stops before the `\r`, and `$` then wants the end of the string. Every claim collapsed
 * into one section, offsets from different bases were compared, and it reported conflicts that were
 * not there.
 *
 * It failed **open** — no headings meant no scoping, which is the mode that produces noise rather
 * than silence. So `sectioned` is asserted below: a scan that finds no sections is now a named
 * failure rather than a wall of false positives. `.gitattributes` fixes the cause; splitting on
 * either ending fixes the clone that arrived before it.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");

/** Established: somebody measured it. Open: somebody has not. */
const ESTABLISHED = ["VERIFIED", "SOLVED", "DECODED", "LOCATED"];
const OPEN = ["UNKNOWN", "UNDECODED", "SPECULATIVE", "INFERRED"];

interface Claim { line: number; status: string; text: string }

/** Every offset claim in a file, grouped by top-level section and then by offset. */
function claimsBySection(src: string): Map<string, Map<string, Claim[]>> {
  const out = new Map<string, Map<string, Claim[]>>();
  let section = "(preamble)";
  src.split(/\r?\n/).forEach((line, i) => {
    const heading = /^##\s+(?!#)(.*)$/.exec(line);
    if (heading) section = heading[1]!.trim();

    const offsets = new Set(line.match(/\+0x[0-9A-Fa-f]{2,4}/g) ?? []);
    if (offsets.size === 0) return;
    const status = [...ESTABLISHED, ...OPEN]
      .filter((s) => new RegExp(String.raw`\b${s}\b`).test(line));
    if (status.length === 0) return;
    // The strongest claim on the line wins: a row reading "SOLVED — was UNKNOWN" is a solved row.
    const best = ESTABLISHED.find((s) => status.includes(s)) ?? status[0]!;

    const bySection = out.get(section) ?? new Map<string, Claim[]>();
    out.set(section, bySection);
    for (const offset of offsets) {
      const key = offset.toLowerCase();
      const list = bySection.get(key) ?? [];
      list.push({ line: i + 1, status: best, text: line.trim().slice(0, 90) });
      bySection.set(key, list);
    }
  });
  return out;
}

test("no offset is called open in one place and solved in another", () => {
  const files = readdirSync(DOCS).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 20, `only ${files.length} docs found; the scan is in the wrong place`);

  const conflicts: string[] = [];
  let checked = 0;
  let sectioned = 0;

  for (const file of files) {
    const src = readFileSync(join(DOCS, file), "utf8");
    const sections = claimsBySection(src);
    sectioned += [...sections.keys()].filter((k) => k !== "(preamble)").length;

    for (const [section, offsets] of sections) {
      for (const [offset, claims] of offsets) {
        checked++;
        const solved = claims.filter((c) => ESTABLISHED.includes(c.status));
        const open = claims.filter((c) => OPEN.includes(c.status));
        if (solved.length === 0 || open.length === 0) continue;
        conflicts.push(
          `${file} § ${section}\n    ${offset} is ${open[0]!.status} on line ${open[0]!.line} ` +
            `and ${solved[0]!.status} on line ${solved[0]!.line}\n` +
            `      ${open[0]!.text}\n      ${solved[0]!.text}`,
        );
      }
    }
  }

  /*
   * **Tripwires for a scan that stopped matching, not targets.** The first was `> 100` against a
   * measured 104, and the next commit to edit these documents took it to 91 and turned this test
   * red on main. A floor set just under the current value fails the moment somebody does the thing
   * the test exists to encourage, so both sit far below.
   */
  assert.ok(checked > 40, `only ${checked} offset claims found; the scan stopped working`);
  assert.ok(sectioned > 10,
    `only ${sectioned} named sections found, so offsets from different bases are being compared`);

  assert.deepEqual(conflicts, [],
    `a reader who lands on the weaker claim will re-derive solved work:\n\n${conflicts.join("\n\n")}`);
});
