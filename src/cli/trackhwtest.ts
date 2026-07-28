/**
 * Build the track-operation hardware test: one project and a check sheet.
 *
 *   npm run trackhwtest -- --project "JAM.dn2prj"                 # which patterns can seed it
 *   npm run trackhwtest -- --project "JAM.dn2prj" --pattern A1 --out <folder>
 *   npm run trackhwtest -- --project "JAM.dn2prj" --pattern A1 --only 4 --out <folder>
 *
 * Writes two files, stamped with the build time so the device says which build is loaded — a
 * hardware test that validates the wrong build is worse than no test:
 *
 *   HWTRACK_<hhmm>.dn2prj   A1 the untouched reference, A2 upward one operation each
 *   HWTRACK_<hhmm>.html     what to check, track by track
 *
 * One file, not two, and deliberately unlike the pattern test. That one kept a separate
 * baseline because everything depended on whether our captured blanks load at all, and the
 * pattern session answered that. Here the reference has to be *in the same project*: the
 * tester compares a preset name against A1 constantly, and flipping between two projects to do
 * it would make the session unbearable.
 *
 * If the project will not load at all, `--only <n>` rebuilds with a single operation, so
 * "it bricks the load" is diagnosable rather than a dead end.
 *
 * The outputs contain the user's music, so they belong in the private corpus — never in this
 * repository. `99_HardwareTest/` is gitignored for exactly this.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildProjectFile } from "../project/projectfile.js";
import { DN2_LAYOUT, writeProjectName } from "../project/dn2image.js";
import { readDn2Pattern } from "../project/dn2pattern.js";
import { describePlock } from "../project/plockparams.js";
import { patternIndex, patternName } from "../sheet/naming.js";
import {
  type ExportRow,
  type ExportSpec,
  RESULTS_FORM_CSS,
  checkItem,
  exportBar,
  metaField,
  noteCell,
  observationsField,
  resultsFormScript,
  verdictCell,
} from "../sheet/resultsform.js";
import { type Device } from "../librarian/device.js";
import { OpenError, openProject } from "../librarian/open.js";
import { applyRearrange } from "../librarian/rearrange.js";
import { copyMany, keepOnly } from "../librarian/shuffle.js";
import { applyTrackMove, verifyTrackMove } from "../librarian/trackmove.js";
import { type TrackSummary, summariseTracks, trackName } from "../librarian/tracksummary.js";
import {
  FIRST_STEP,
  QUIET_FAILURES,
  REFERENCE,
  type TrackExpectation,
  type TrackSeeds,
  type TrackTestStep,
  chooseSeeds,
  expectationsFor,
  stepsFor,
} from "../librarian/trackhardwaretest.js";

const CONFIRM = { confirmOverwrite: true } as const;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function hhmm(when = new Date()): string {
  return `${String(when.getHours()).padStart(2, "0")}${String(when.getMinutes()).padStart(2, "0")}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The individual trigs worth looking at, named by step.
 *
 * Straight out of the 2026-07-28 session. The sheet asked the tester to check microtiming, trig
 * conditions and sound locks and never said **where**, so the honest answer that came back was
 * *"give me a few key steps and params to check"*. It was a fair complaint: `T1` carries
 * microtiming on exactly two of its 36 steps, and finding them by ear is not a check, it is a
 * search.
 *
 * Scoped to the tracks the test actually moves — a distinctive trig on a track no operation
 * touches proves nothing and would only pad the list.
 */
interface Distinctive {
  track: number;
  step: number;
  what: string;
  /** Higher is rarer, and rarer is what a tester's attention should be spent on. */
  rank: number;
}

function distinctiveTrigs(
  image: Uint8Array,
  pattern: number,
  tracks: readonly number[],
): Distinctive[] {
  const parsed = readDn2Pattern(image, pattern, DN2_LAYOUT);
  const out: Distinctive[] = [];

  for (const track of tracks) {
    for (const trig of parsed.tracks[track]?.trigs ?? []) {
      const what: string[] = [];
      let rank = 0;

      // Ranked by scarcity, because attention is the scarce thing. A pattern can carry forty
      // sound locks and two microtimed trigs; listing them in step order buries the two.
      if (trig.microTiming !== 0) {
        what.push(`microtiming ${trig.microTiming > 0 ? "+" : ""}${trig.microTiming}`);
        rank += 4;
      }
      if (trig.locks && trig.locks.length > 0) {
        what.push(
          `p-locks on ${trig.locks.map((l) => describePlock(l.parameter) ?? `id ${l.parameter}`).join(", ")}`,
        );
        rank += 3;
      }
      if (trig.probability !== undefined) {
        what.push(`probability ${trig.probability}%`);
        rank += 2;
      }
      if (trig.soundLock !== undefined) what.push(`sound lock ${trig.soundLock}`);

      if (what.length > 0) out.push({ track, step: trig.step + 1, what: what.join("; "), rank });
    }
  }

  return out.sort((a, b) => b.rank - a.rank || a.track - b.track || a.step - b.step);
}

/** Stable per-row id, shared by the HTML controls and the exported table. */
function rowId(step: TrackTestStep, track: number): string {
  return `s${step.n}-${trackName(track)}`;
}

/** How one expectation reads, in the sheet and in the export. */
function describeExpectation(e: TrackExpectation): string {
  const preset = `"${e.presetName}"${e.initialised ? " (initialised)" : ""}`;
  const kind = e.midi ? "MIDI" : "synth";
  const locks = e.lockCount === 1 ? "1 lock" : `${e.lockCount} locks`;
  return `${preset}, ${kind}, ${e.trigCount} trigs, ${locks}, level ${e.level}`;
}

function renderRows(rows: { step: TrackTestStep; expected: TrackExpectation[] }[]): string {
  return rows
    .map(({ step, expected }) => {
      const note = step.note ? `<div class="hint">${escapeHtml(step.note)}</div>` : "";
      return expected
        .map((e, i) => {
          const first = i === 0;
          const opCell = first
            ? `<td class="n" rowspan="${expected.length}">${step.n}</td>
    <td class="mono" rowspan="${expected.length}">${patternName(step.pattern)}</td>
    <td rowspan="${expected.length}">${escapeHtml(step.operation)}
      <div class="scope">scope: <span class="mono">${step.scope}</span></div>${note}</td>`
            : "";
          const id = rowId(step, e.track);
          // An emptied track still has a name — the blank's `PRESET n` — so it is shown rather
          // than described as blank. The tester reads a name either way; only the tag differs.
          const preset =
            `<span class="mono nm">${escapeHtml(e.presetName)}</span>` +
            (e.initialised ? ` <span class="empty">initialised</span>` : "");
          return `<tr${first ? ' class="grp"' : ""}>
    ${opCell}
    <td class="mono">${trackName(e.track)}</td>
    <td>${preset}</td>
    <td class="mono num">${e.midi ? "MIDI" : "synth"}</td>
    <td class="mono num">${e.trigCount}</td>
    <td class="mono num">${e.lockCount}</td>
    <td class="mono num">${e.level}</td>
    <td class="tick">${verdictCell(id)}</td>
    <td class="note">${noteCell(id)}</td>
  </tr>`;
        })
        .join("\n  ");
    })
    .join("\n  ");
}

function metaFields(stamp: string) {
  return [
    { id: "device", label: "Device", value: "Digitone II" },
    { id: "firmware", label: "Firmware / OS", value: "" },
    { id: "date", label: "Date", value: new Date().toISOString().slice(0, 10) },
    { id: "build", label: "Build", value: stamp },
    { id: "tester", label: "Tester", value: "" },
  ];
}

function exportSpec(
  stamp: string,
  rows: { step: TrackTestStep; expected: TrackExpectation[] }[],
): ExportSpec {
  const out: ExportRow[] = [];
  for (const { step, expected } of rows) {
    for (const e of expected) {
      out.push({
        id: rowId(step, e.track),
        cells: [
          String(step.n),
          patternName(step.pattern),
          `${step.operation} (${step.scope})`,
          trackName(e.track),
          describeExpectation(e),
        ],
      });
    }
  }
  return {
    title: `DNX hardware test ${stamp} — track operations`,
    stamp,
    columns: ["#", "Pattern", "Operation", "Track", "Should be"],
    rows: out,
    meta: [
      ...metaFields(stamp).map(({ id, label }) => ({ id, label })),
      { id: "observations", label: "Observations" },
    ],
    checks: QUIET_FAILURES.map((q, i) => ({ id: `q${i}`, label: q })),
  };
}

/**
 * The individual steps worth checking, named.
 *
 * Added after the 2026-07-28 session, whose tester fairly answered *"give me a few key steps and
 * params to check"* — the sheet had asked for microtiming, trig conditions and sound locks
 * without saying where any of them were. Two of `T1`'s 36 steps carry microtiming; finding those
 * by ear is a search, not a check.
 */
const SHOW_AT_MOST = 12;

function renderDistinctive(distinctive: Distinctive[]): string {
  if (distinctive.length === 0) return "";
  const shown = distinctive.slice(0, SHOW_AT_MOST);
  const rest = distinctive.length - shown.length;

  const rows = shown
    .map(
      (d) =>
        `<tr><td class="mono">${trackName(d.track)}</td>` +
        `<td class="mono num">${d.step}</td><td>${escapeHtml(d.what)}</td></tr>`,
    )
    .join("\n  ");

  const more =
    rest === 0
      ? ""
      : `<p class="hint">${rest} further trig(s) carry only a sound lock. Those are the least
likely to fail on their own &mdash; the pool is per project and these operations stay inside one
pattern &mdash; so they are summarised rather than listed.</p>`;

  return `<h2>Where to look</h2>
<p class="lede">The trigs on the moved tracks carrying anything beyond a plain note, rarest
first. These are the steps the quiet-failure checks are really about: each should survive an
operation that carries the sequence, and travel with it when the sequence moves.</p>
${more}
<div class="scroll">
<table>
  <thead><tr><th>Track</th><th class="num">Step</th><th>Carries</th></tr></thead>
  <tbody>
  ${rows}
  </tbody>
</table>
</div>`;
}

/** What the reference pattern holds, printed on the sheet so every row can be read against it. */
function renderReference(before: readonly TrackSummary[], seeds: TrackSeeds): string {
  const role = new Map<number, string>([
    [seeds.locked, "the locked track — the lock regression rides on this one"],
    [seeds.other, "the second named track — swaps and batches read against it"],
    [seeds.spare[0], "spare, landed on"],
    [seeds.spare[1], "spare, landed on"],
  ]);
  if (seeds.midi !== undefined) role.set(seeds.midi, "the MIDI track — the mask regression");

  return before
    .filter((t) => role.has(t.index) || !t.empty)
    .map(
      (t) => `<tr>
    <td class="mono">${trackName(t.index)}</td>
    <td>${t.presetName ? `<span class="mono nm">${escapeHtml(t.presetName)}</span>` : `<span class="empty">initialised</span>`}</td>
    <td class="mono num">${t.midi ? "MIDI" : (t.machine ?? "?")}</td>
    <td class="mono num">${t.trigCount}</td>
    <td class="mono num">${t.lockCount}</td>
    <td class="mono num">${t.level}</td>
    <td>${escapeHtml(role.get(t.index) ?? "")}</td>
  </tr>`,
    )
    .join("\n  ");
}

function renderSheet(
  stamp: string,
  sourceName: string,
  sourcePattern: string,
  before: readonly TrackSummary[],
  seeds: TrackSeeds,
  rows: { step: TrackTestStep; expected: TrackExpectation[] }[],
  caveats: string[],
  distinctive: Distinctive[],
): string {
  const spec = exportSpec(stamp, rows);
  const meta = metaFields(stamp)
    .map((f) => metaField(f.id, f.label, f.value))
    .join("\n  ");
  const quiet = QUIET_FAILURES.map((q, i) => checkItem(`q${i}`, q)).join("\n    ");
  const caveatBlock =
    caveats.length === 0
      ? ""
      : `<div class="card warn">
  <strong>What this run does not check.</strong>
  <ul>${caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DNX hardware test ${stamp} — track operations</title>
<style>
  :root { color-scheme: light dark;
    --bg:#fff; --fg:#16181d; --muted:#6b7280; --line:#e4e6ea; --accent:#6d4aff;
    --card:#f8f9fb; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#131519; --fg:#e7e9ed; --muted:#98a0ac; --line:#2a2e35; --accent:#b5a2ff;
    --card:#191c21; --bad:#ff8a80; } }
  * { box-sizing: border-box; }
  body { background:var(--bg); color:var(--fg); margin:0 auto; padding:2rem 1.25rem 4rem;
    max-width:72rem; font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size:1.5rem; margin:0 0 .2rem; letter-spacing:-.02em; }
  h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted);
    margin:2.2rem 0 .6rem; }
  .lede { color:var(--muted); margin:0 0 1.2rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:.9rem 1.1rem; margin:.8rem 0; }
  .card strong { color:var(--accent); }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.88rem; min-width:52rem; }
  th, td { text-align:left; padding:.45rem .55rem; border-bottom:1px solid var(--line);
    vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:.72rem; text-transform:uppercase;
    letter-spacing:.05em; }
  td.n { font-weight:700; width:2rem; }
  td.num { text-align:right; }
  th.num { text-align:right; }
  .mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.85rem; }
  td.tick { width:3.5rem; }
  td.tick::before { content:"\\2610 \\2610"; letter-spacing:.4rem; color:var(--muted); }
  td.note { width:11rem; }
  tr.grp td { border-top:2px solid var(--line); }
  .nm { background:var(--card); border:1px solid var(--line); border-radius:4px;
    padding:.05rem .3rem; font-weight:600; }
  .empty { color:var(--muted); font-style:italic; }
  .hint { color:var(--muted); font-size:.8rem; margin-top:.3rem; }
  .scope { color:var(--accent); font-size:.78rem; margin-top:.2rem; }
  ul { padding-left:1.1rem; }
  li { margin:.35rem 0; }
  .warn { border-left:3px solid var(--bad); padding-left:.9rem; }
  .warn strong { color:var(--bad); }
  @media print { body { max-width:none; padding:0; } .card { break-inside:avoid; } }
${RESULTS_FORM_CSS}</style>
</head>
<body>

<h1>Track operations — hardware test</h1>
<p class="lede">Build <span class="mono">${stamp}</span> &middot; Digitone II &middot;
seeded from ${escapeHtml(sourceName)} ${escapeHtml(sourcePattern)}</p>

<div class="card">
  <strong>Nothing at track level has ever been near a device.</strong> Two of the operations
  below exercise bugs that were found and fixed by reading the manual, and our code agreeing
  with our own reader is all the evidence there is that they are gone: <em>parameter lock ids</em>
  (a lock on CUTOFF became a lock on parameter 3) and the <em>MIDI mask</em> (a moved MIDI track
  arrived as a synth track). Rows 1&ndash;5 are those. If the session runs out of time, they are
  the ones that mattered.
</div>

<h2>Session</h2>
<div class="card rf-meta">
  ${meta}
</div>

<h2>A1 — the reference, never written to</h2>
<p class="lede">Every operation below runs on its own copy of this pattern, in its own slot. Flip
back to <span class="mono">A1</span> whenever a row is ambiguous: the <em>before</em> is on the
device, not just on this page.</p>
<div class="scroll">
<table>
  <thead><tr>
    <th>Track</th><th>Preset</th><th class="num">Machine</th><th class="num">Trigs</th>
    <th class="num">Locks</th><th class="num">Level</th><th>Role</th>
  </tr></thead>
  <tbody>
  ${renderReference(before, seeds)}
  </tbody>
</table>
</div>

${renderDistinctive(distinctive)}

${caveatBlock}

<h2>Operations</h2>
<p class="lede">One operation per pattern, so nothing can corrupt the evidence for anything
else. Every cell names what the device should show, so each line can be read straight off the
screen &mdash; and be wrong. A track that makes a sound is not a pass if it makes the wrong one
under the wrong name.</p>
<div class="scroll">
<table>
  <thead><tr>
    <th>#</th><th>Pattern</th><th>Operation</th><th>Track</th><th>Preset</th>
    <th class="num">Kind</th><th class="num">Trigs</th><th class="num">Locks</th>
    <th class="num">Level</th><th>OK / not</th><th>What happened</th>
  </tr></thead>
  <tbody>
  ${renderRows(rows)}
  </tbody>
</table>
</div>

<h2>For each row, beyond &ldquo;it plays&rdquo;</h2>
<div class="card">
    ${quiet}
</div>

<h2>Anything else</h2>
<div class="card">
  ${observationsField()}
</div>

<h2>Last, and only if the rest passed</h2>
<div class="card">
  <strong>Save the project on the device and export it.</strong> A round-trip is worth more than
  the checklist: the pattern-level one came back with zero differing bytes on the baseline, which
  proved our image is what the device itself would produce, and the bytes that did change
  identified three header and kit fields we had not found any other way. Track operations touch
  the kit far more than pattern ones do, so this diff is where
  <span class="mono">kit +10,264</span> &mdash; the apparent 16&times;5-byte per-track array of
  unknown meaning, which we disclose rather than move &mdash; is most likely to give itself up.
  Keep the exported file; it is the evidence.
</div>

<div class="card">
  <strong>When you are done, press <em>Export results</em> at the bottom.</strong> It writes a
  Markdown file with every row, including the ones that passed. Hand that file over as it is &mdash;
  nothing needs retyping, and the rows nobody would bother mentioning are the ones that make the
  next diff readable.
  <br><br>
  Answers are kept in this browser as you go, so a reload will not lose them.
</div>

<div class="card warn">
  <strong>If the project will not load at all, that is a result — say so and stop.</strong>
  Rebuild with <span class="mono">--only &lt;n&gt;</span> to get a project carrying one
  operation, and work down the list until the one that breaks the load is identified.
</div>

${exportBar()}
${resultsFormScript(spec)}

</body>
</html>
`;
}

/**
 * Which patterns in this project could seed the test, and why the others could not.
 *
 * Worth its own mode because the requirements are specific — locks, two named tracks, room to
 * land — and guessing a slot only to be refused is a bad way to find that out.
 */
function survey(image: Uint8Array, device: Device): void {
  interface Candidate {
    pattern: number;
    tracks: TrackSummary[];
    locked: number;
    other: number;
    midi: number | undefined;
    /** Distinct track levels — more than one is what makes the LEVEL column falsifiable. */
    levels: number;
  }

  const candidates: Candidate[] = [];
  const refused = new Map<string, number>();

  for (let pattern = 0; pattern < device.patternCount; pattern++) {
    if (!device.summarise(image, pattern).occupied) continue;
    const tracks = summariseTracks(image, pattern);
    const choice = chooseSeeds(tracks);
    if ("problem" in choice) {
      refused.set(choice.problem, (refused.get(choice.problem) ?? 0) + 1);
      continue;
    }
    const { locked, other, midi } = choice.seeds;
    candidates.push({
      pattern,
      tracks,
      locked,
      other,
      midi,
      levels: new Set(tracks.map((t) => t.level)).size,
    });
  }

  if (candidates.length === 0) {
    console.log(
      "\n  No pattern in this project can seed a track test. It needs two differently named\n" +
        "  synth tracks carrying trigs, parameter locks on one of them, and two empty tracks\n" +
        "  to land on.\n",
    );
    for (const [problem, count] of refused) console.log(`  ${String(count).padStart(3)} × ${problem}`);
    console.log();
    return;
  }

  // Rank by how much of the test the pattern can actually exercise, not by slot order. A
  // pattern with no MIDI track silently drops the mask regression, which is half the point.
  const score = (c: Candidate): number =>
    (c.midi === undefined ? 0 : 100) + (c.levels > 1 ? 50 : 0) + c.tracks[c.locked]!.lockCount;
  candidates.sort((a, b) => score(b) - score(a) || a.pattern - b.pattern);

  console.log(`\n  ${candidates.length} pattern(s) can seed a track test, best first:\n`);
  for (const c of candidates.slice(0, 12)) {
    const gaps = [
      c.midi === undefined ? "no MIDI track, mask regression dropped" : "",
      c.levels > 1 ? "" : "all levels equal, LEVEL column proves nothing",
    ].filter(Boolean);
    console.log(
      `  ${patternName(c.pattern).padEnd(4)} ` +
        `locks ${trackName(c.locked)} (${c.tracks[c.locked]!.lockCount})`.padEnd(16) +
        `pair ${trackName(c.other)}`.padEnd(9) +
        (c.midi === undefined ? "—".padEnd(9) : `MIDI ${trackName(c.midi)}`.padEnd(9)) +
        (gaps.length === 0 ? "covers everything" : gaps.join("; ")),
    );
  }
  if (candidates.length > 12) console.log(`  … and ${candidates.length - 12} more`);

  if (refused.size > 0) {
    console.log(`\n  Not usable:`);
    for (const [problem, count] of refused) console.log(`  ${String(count).padStart(3)} × ${problem}`);
  }
  console.log(`\n  Re-run with --pattern ${patternName(candidates[0]!.pattern)} --out <folder>.\n`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const projectPath = arg("project");
  if (!projectPath) {
    fail(
      'usage: npm run trackhwtest -- --project "<file>" [--pattern A1] [--only <n>] --out <folder>\n' +
        "       without --pattern, lists the patterns that could seed the test",
    );
  }

  let project;
  try {
    project = openProject(projectPath, { asDn2: argv.includes("--as-dn2") });
  } catch (e) {
    if (e instanceof OpenError) fail(`\n${e.message}\n`);
    throw e;
  }
  const device = project.device;
  if (device.kind !== "dn2") {
    fail(
      `\nTrack operations are Digitone II only. ${basename(projectPath)} is a ${device.name} project.\n`,
    );
  }

  const patternArg = arg("pattern");
  if (patternArg === undefined) {
    survey(project.image, device);
    return;
  }

  const outDir = arg("out");
  if (!outDir) fail("--out <folder> is required once --pattern is given.");

  const source = patternIndex(patternArg.toUpperCase()) ?? Number(patternArg);
  if (!Number.isInteger(source) || source < 0 || source >= device.patternCount) {
    fail(`Not a pattern slot: "${patternArg}". Use A1..H16, or 0..${device.patternCount - 1}.`);
  }

  const stamp = hhmm();

  // 1. The reference alone at A1, every other slot a captured blank. Packing it to A1 means the
  //    tester never has to remember where the original was.
  const baseline = applyRearrange(project.image, keepOnly([source], device.patternCount), CONFIRM);
  if (!baseline.verification.ok) {
    fail(`baseline failed verification: ${baseline.verification.problems.join("; ")}`);
  }

  // 2. Read the reference, and read a blank — from the far end of the bank, where nothing this
  //    tool writes can reach it. Every "what should an emptied track hold" answer comes from
  //    captured bytes rather than from an assumption about what empty looks like.
  const before = summariseTracks(baseline.image, REFERENCE);
  const blank = summariseTracks(baseline.image, device.patternCount - 1);

  const choice = chooseSeeds(before);
  if ("problem" in choice) {
    fail(
      `\n  ${patternName(source)} cannot seed this test:\n  ${choice.problem}.\n\n` +
        `  Run without --pattern to see which patterns can.\n`,
    );
  }
  const seeds = choice.seeds;

  const caveats: string[] = [];
  if (seeds.midi === undefined) {
    caveats.push(
      `${patternName(source)} has no MIDI track carrying trigs, so the two rows that check the ` +
        `MIDI mask at kit +10,260 were dropped. That regression is unchecked by this run — ` +
        `seed from a pattern with a MIDI track to cover it.`,
    );
  }
  const levels = new Set(before.map((t) => t.level));
  if (levels.size === 1) {
    caveats.push(
      `every track in ${patternName(source)} is at level ${before[0]!.level}, so the LEVEL ` +
        `column cannot distinguish a scope that carries the level from one that does not. ` +
        `Set two tracks to different levels and rebuild to make that check bite.`,
    );
  }

  // Added after the 2026-07-28 session, which asked for microtiming and retrigs when the seed had
  // neither. The tester spent attention on two rows that could not fail. A sheet asking for what
  // the pattern cannot show is worse than one that admits the gap up front.
  const moved = [seeds.locked, seeds.other, ...(seeds.midi === undefined ? [] : [seeds.midi])];
  const distinctive = distinctiveTrigs(project.image, source, moved);
  if (!distinctive.some((d) => d.what.includes("microtiming"))) {
    caveats.push(
      `no trig on ${moved.map(trackName).join(", ")} has non-zero microtiming, and those are the ` +
        `tracks this sheet moves — so nothing here can show whether microtiming travels. Nudge a ` +
        `trig off the grid on one of them and rebuild to cover it.`,
    );
  }

  let steps = stepsFor(seeds, before);
  const only = arg("only");
  if (only !== undefined) {
    const n = Number(only);
    const chosen = steps.find((s) => s.n === n);
    if (!chosen) fail(`--only ${only}: there is no step ${only}. Steps run 1..${steps.length}.`);
    steps = [chosen];
  }

  // 3. Give each step its own copy of the reference, then run its operation on that copy.
  let working = baseline.image;
  for (const step of steps) {
    const seeded = applyRearrange(working, copyMany([REFERENCE], step.pattern), CONFIRM);
    if (!seeded.verification.ok) {
      fail(
        `seeding ${patternName(step.pattern)} for step ${step.n} failed: ` +
          seeded.verification.problems.join("; "),
      );
    }
    const moved = applyTrackMove(seeded.image, device, step.pattern, step.shuffle, {
      confirmOverwrite: true,
      scope: step.scope,
    });
    const verification = verifyTrackMove(
      seeded.image,
      moved.image,
      step.pattern,
      step.shuffle,
      step.scope,
    );
    if (!verification.ok) {
      fail(
        `step ${step.n} (${step.operation}) failed verification: ` +
          verification.problems.join("; "),
      );
    }
    working = moved.image;
    console.log(
      `  ${String(step.n).padStart(2)}. ${patternName(step.pattern).padEnd(4)} ` +
        `${step.operation.padEnd(52)} ${step.scope}`,
    );
  }

  // 4. Hold the finished file against every claim the sheet is about to make.
  //
  //    `applyTrackMove` already verified each step against its own shuffle — our code agreeing
  //    with our code. This asks a different question: does the file we are shipping actually
  //    show what the printed sheet says it shows? A sheet that is wrong is worse than no sheet,
  //    because the tester reports our mistake as a hardware failure.
  //
  //    The expectations come from `expectedAfter`, which restates the scope rule from scratch
  //    rather than borrowing it from the mover. That is what makes this a check and not a
  //    tautology.
  const rows = steps.map((step) => ({ step, expected: expectationsFor(step, before, blank) }));
  const wrong: string[] = [];
  for (const { step, expected } of rows) {
    const actual = summariseTracks(working, step.pattern);
    for (const e of expected) {
      const got = actual[e.track]!;
      const mismatch: string[] = [];
      if (got.presetName !== e.presetName) {
        mismatch.push(`preset "${got.presetName}" not "${e.presetName}"`);
      }
      if (got.trigCount !== e.trigCount) mismatch.push(`${got.trigCount} trigs not ${e.trigCount}`);
      if (got.lockCount !== e.lockCount) mismatch.push(`${got.lockCount} locks not ${e.lockCount}`);
      if (got.midi !== e.midi) mismatch.push(got.midi ? "MIDI not synth" : "synth not MIDI");
      if (got.level !== e.level) mismatch.push(`level ${got.level} not ${e.level}`);
      if (mismatch.length > 0) {
        wrong.push(
          `step ${step.n} (${step.operation}, ${step.scope}) ` +
            `${patternName(step.pattern)} ${trackName(e.track)}: ${mismatch.join(", ")}`,
        );
      }
    }
  }
  if (wrong.length > 0) {
    console.error("\nThe sheet would claim things this file does not show:");
    for (const w of wrong) console.error(`  ${w}`);
    process.exit(1);
  }
  const claims = rows.reduce((n, r) => n + r.expected.length, 0);
  console.log(`\n  all ${claims} track expectations hold against the written file`);

  mkdirSync(outDir, { recursive: true });
  const projectOut = join(outDir, `HWTRACK_${stamp}.dn2prj`);
  const sheetOut = join(outDir, `HWTRACK_${stamp}.html`);

  writeProjectName(working, `HWTRK ${stamp}`);
  writeFileSync(projectOut, buildProjectFile(project.manifest, project.payload.raw, working));
  writeFileSync(
    sheetOut,
    renderSheet(
      stamp,
      basename(projectPath),
      patternName(source),
      before,
      seeds,
      rows,
      caveats,
      distinctive,
    ),
  );

  for (const caveat of caveats) console.log(`\n  note: ${caveat}`);
  console.log(`\n  project: ${projectOut}`);
  console.log(`  check sheet: ${sheetOut}`);
  console.log(
    `\n  ${patternName(REFERENCE)} is the reference and is never written to; ` +
      `steps run from ${patternName(FIRST_STEP)}.`,
  );
}

main();
