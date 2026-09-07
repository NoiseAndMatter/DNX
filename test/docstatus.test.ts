/**
 * A byte cannot be unknown in one place and solved in another.
 *
 * ## The failure this exists to stop
 *
 * `dn2-pattern-format.md` opens each section with a summary table of offsets and their confidence,
 * then decodes fields in prose below. **The tables do not get updated when the prose solves
 * something.** Three offsets in the track-record table said INFERRED or UNKNOWN while sections
 * fifty to a hundred and sixty lines lower said SOLVED and VERIFIED about the same bytes, one of
 * them since July.
 *
 * That is not untidiness. It is the exact failure this project keeps paying for: **somebody reads
 * the table, believes the field is open, and re-derives it.** It has already cost a hardware test
 * written for a closed question and a caveat shown to users about a table that had been solved on
 * hardware two months earlier. The §5 settings table and §3.6 disagreed the same way, found by
 * hand two days ago.
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
  src.split("\n").forEach((line, i) => {
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

  for (const file of files) {
    const src = readFileSync(join(DOCS, file), "utf8");
    for (const [section, offsets] of claimsBySection(src)) {
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

  assert.ok(checked > 100, `only ${checked} offset claims found; the scan stopped working`);
  assert.deepEqual(conflicts, [],
    `a reader who lands on the weaker claim will re-derive solved work:\n\n${conflicts.join("\n\n")}`);
});
