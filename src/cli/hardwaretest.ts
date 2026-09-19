/**
 * Build the pattern-rearrangement hardware test: two projects and a check sheet.
 *
 *   npm run hwtest -- --project "MORNING_JAM.dn2prj" --keep A1 A4 --out <folder>
 *
 * Writes three files, all stamped with the build time so the device says which build is
 * loaded — a hardware test that validates the wrong build is worse than no test:
 *
 *   HWTEST_BASE_<hhmm>.dn2prj   the two seed patterns and 126 captured blanks
 *   HWTEST_OPS_<hhmm>.dn2prj    every operation applied, each in its own region
 *   HWTEST_<hhmm>.html          what to check, slot by slot
 *
 * Load the baseline **first**. If a project of captured blanks does not load, nothing in the
 * operations file means anything, and that is itself the most valuable result of the session.
 *
 * The outputs contain the user's music, so they belong in the private corpus — never in this
 * repository. `99_HardwareTest/` is gitignored for exactly this.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { cliArgs, readProjectFile } from "./args.js";
import { join } from "node:path";
import { buildProjectFile, } from "../node/projectfile.js";
import { writeProjectName } from "../project/dn2image.js";
import { hhmm, patternIndex, patternName } from "../project/naming.js";
import { escapeHtml } from "../sheet/html.js";
import {
  type ExportRow,
  type ExportSpec,
  checkItem,
  metaField,
  noteCell,
  observationsField,
  verdictCell,
} from "../sheet/resultsform.js";
import { renderSheetPage } from "../sheet/page.js";
import { deviceFor } from "../librarian/device.js";
import { applyRearrange } from "../librarian/rearrange.js";
import { copyMany, keepOnly } from "../librarian/shuffle.js";
import {
  QUIET_FAILURES,
  SEED_SOURCES,
  type SeedNames,
  type TestStep,
  describeLayout,
  inspectedSlots,
  seedNameProblem,
  seedingFor,
  stepsFor,
} from "../librarian/hardwaretest.js";

const CONFIRM = { confirmOverwrite: true } as const;


/**
 * One row per *slot*, not per operation.
 *
 * The tester reads a slot name off the device and compares one cell. An operation spanning
 * four slots gets four lines under one merged operation cell, so nothing has to be unpacked
 * from a sentence while standing at the hardware.
 */
/** Stable per-row id, shared by the HTML controls and the exported table. */
function rowId(step: TestStep, slot: number): string {
  return `s${step.n}-${patternName(slot)}`;
}

function renderRows(steps: TestStep[]): string {
  return steps
    .map((step) => {
      const note = step.note
        ? `<div class="hint">${escapeHtml(step.note)}</div>`
        : "";
      return step.expected
        .map((e, i) => {
          const first = i === 0;
          const opCell = first
            ? `<td class="n" rowspan="${step.expected.length}">${step.n}</td>
    <td rowspan="${step.expected.length}">${escapeHtml(step.operation)}${note}</td>`
            : "";
          const expect =
            e.name === null
              ? `<span class="empty">empty</span>`
              : `named <span class="mono nm">${escapeHtml(e.name)}</span>`;
          const id = rowId(step, e.slot);
          return `<tr${first ? ' class="grp"' : ""}>
    ${opCell}
    <td class="mono">${escapeHtml(patternName(e.slot))}</td>
    <td>${expect}</td>
    <td class="tick">${verdictCell(id)}</td>
    <td class="note">${noteCell(id)}</td>
  </tr>`;
        })
        .join("\n  ");
    })
    .join("\n  ");
}

/** The metadata the export needs to be worth anything six months later. */
function metaFields(stamp: string, layout: string) {
  return [
    { id: "device", label: "Device", value: layout.split(",")[0] ?? "" },
    { id: "firmware", label: "Firmware / OS", value: "" },
    { id: "date", label: "Date", value: new Date().toISOString().slice(0, 10) },
    { id: "build", label: "Build", value: stamp },
    { id: "tester", label: "Tester", value: "" },
  ];
}

/** What the export writes out, derived from the same steps the table renders. */
function exportSpec(stamp: string, layout: string, steps: TestStep[]): ExportSpec {
  const rows: ExportRow[] = [];
  rows.push({ id: "baseline", cells: ["0", "Baseline loads", `HWTEST_BASE_${stamp}`, "—"] });
  for (const step of steps) {
    for (const e of step.expected) {
      rows.push({
        id: rowId(step, e.slot),
        cells: [
          String(step.n),
          step.operation,
          patternName(e.slot),
          e.name === null ? "empty" : `"${e.name}"`,
        ],
      });
    }
  }
  return {
    title: `DNX hardware test ${stamp} — pattern rearrangement`,
    stamp,
    columns: ["#", "Operation", "Slot", "Should be"],
    rows,
    meta: [
      ...metaFields(stamp, layout).map(({ id, label }) => ({ id, label })),
      { id: "observations", label: "Observations" },
    ],
    checks: QUIET_FAILURES.map((q, i) => ({ id: `q${i}`, label: q })),
  };
}

function renderSheet(
  stamp: string,
  layout: string,
  sourceName: string,
  seeds: string,
  steps: TestStep[],
): string {
  const rows = renderRows(steps);
  const spec = exportSpec(stamp, layout, steps);
  const meta = metaFields(stamp, layout)
    .map((f) => metaField(f.id, f.label, f.value))
    .join("\n  ");

  const quiet = QUIET_FAILURES.map((q, i) => checkItem(`q${i}`, q)).join("\n    ");

  return renderSheetPage({
    documentTitle: `DNX hardware test ${stamp} — pattern rearrangement`,
    heading: "Pattern rearrangement — hardware test",
    lede: `Build <span class="mono">${stamp}</span> &middot; ${escapeHtml(layout)} &middot;
seeded from ${escapeHtml(sourceName)}`,
    spec,
    body: `

<div class="card">
  <strong>Load <span class="mono">HWTEST_BASE_${stamp}</span> first.</strong>
  It is the two seed patterns and 126 captured blank patterns, nothing else. If it does not
  load, or the empty slots misbehave, stop — nothing in the operations file would mean
  anything. That result alone is worth the session.
  <br><br>
  Check: <span class="mono">${patternName(SEED_SOURCES.p1)}</span> and
  <span class="mono">${patternName(SEED_SOURCES.p2)}</span> play; every other slot is empty,
  selectable, and accepts a recorded trig.
  <br><br>
  ${verdictCell("baseline")} &nbsp; ${noteCell("baseline", "how the baseline behaved")}
</div>

<h2>Session</h2>
<div class="card rf-meta">
  ${meta}
</div>

<div class="card">
  Then load <strong><span class="mono">HWTEST_OPS_${stamp}</span></strong> and work the table.
  <span class="mono">${patternName(SEED_SOURCES.p1)}</span> and
  <span class="mono">${patternName(SEED_SOURCES.p2)}</span> are never written after seeding —
  they are the reference everything else is read against.
  <br><br>
  What the seeds exercise: ${escapeHtml(seeds)}
</div>

<h2>Operations</h2>
<p class="lede">Every expectation names the pattern the device should show, so each line can be
read straight off the screen &mdash; and be wrong. A slot that plays is not a pass if it plays
under the wrong name.</p>
<div class="scroll">
<table>
  <thead><tr>
    <th>#</th><th>Operation</th><th>Slot</th><th>Should be</th><th>OK / not</th><th>What happened</th>
  </tr></thead>
  <tbody>
  ${rows}
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
  <strong>Save both projects on the device and export them.</strong> A round-trip is worth more
  than the checklist: the last one came back with <em>zero</em> differing bytes on the
  baseline, which proved our image is what the device itself would produce — and the 198 bytes
  that did change on the operations file identified three header and kit fields. Keep the
  exported files; they are the evidence.
</div>

<div class="card">
  <strong>When you are done, press <em>Export results</em> at the bottom.</strong> It writes a
  Markdown file with every row, including the ones that passed. Hand that file over as it is —
  nothing needs retyping, and the rows nobody would bother mentioning are the ones that make
  the next diff readable.
  <br><br>
  Answers are kept in this browser as you go, so a reload will not lose them.
</div>

<div class="card warn">
  <strong>Do not run this on a project whose songs matter.</strong> The DN1's song table is
  located and guarded; the DN2's has never been found, so a DN2 rearrangement cannot be
  checked against songs. Patterns are referenced by slot, so rearranging them could desync a
  song we cannot see.
</div>
`,
  });
}

function main(): void {
  const { arg, list } = cliArgs();

  const projectPath = arg("project");
  const outDir = arg("out");
  if (!projectPath || !outDir) {
    console.error(
      'usage: npm run hwtest -- --project "<file>" [--keep A1 A4] --out <folder>',
    );
    process.exit(1);
  }

  const keepTokens = list("keep");

  const project = readProjectFile(projectPath);
  const device = deviceFor(project.image);
  const stamp = hhmm();

  const keep = (keepTokens.length > 0 ? keepTokens : ["A1", "A2"]).map((t) => {
    const index = patternIndex(t.toUpperCase()) ?? Number(t);
    if (!Number.isInteger(index) || index < 0 || index >= device.patternCount) {
      console.error(`Not a pattern slot: "${t}"`);
      process.exit(1);
    }
    return index;
  });
  if (keep.length !== 2) {
    console.error("--keep needs exactly two slots: the two reference patterns");
    process.exit(1);
  }

  // 1. The baseline: the two kept patterns at A1 and A2, everything else a captured blank.
  const baseline = applyRearrange(
    project.image,
    keepOnly(keep, device.patternCount),
    CONFIRM,
  );
  if (!baseline.verification.ok) {
    console.error(`baseline failed verification: ${baseline.verification.problems.join("; ")}`);
    process.exit(1);
  }

  // 2. Read the reference names. Every expectation on the sheet is phrased in terms of these,
  //    so two seeds sharing a name would make the swap and batch rows unfalsifiable.
  const seedNames: SeedNames = {
    p1: device.summarise(baseline.image, SEED_SOURCES.p1).name ?? "",
    p2: device.summarise(baseline.image, SEED_SOURCES.p2).name ?? "",
  };
  const problem = seedNameProblem(seedNames);
  if (problem) {
    console.error(`Cannot build a checkable sheet: ${problem}.`);
    process.exit(1);
  }

  // 3. Seed the slots the operations will consume, so a move can empty its source without
  //    destroying a reference.
  let working = baseline.image;
  for (const { slot, from } of seedingFor()) {
    const result = applyRearrange(working, copyMany([from], slot), CONFIRM);
    if (!result.verification.ok) {
      console.error(`seeding slot ${slot} failed: ${result.verification.problems.join("; ")}`);
      process.exit(1);
    }
    working = result.image;
  }

  // 4. Apply each operation in turn, verifying as we go.
  const steps = stepsFor(seedNames);
  for (const step of steps) {
    const result = applyRearrange(working, step.shuffle, CONFIRM);
    if (!result.verification.ok) {
      console.error(
        `step ${step.n} (${step.operation}) failed verification: ` +
          result.verification.problems.join("; "),
      );
      process.exit(1);
    }
    working = result.image;
    console.log(
      `  ${String(step.n).padStart(2)}. ${step.operation.padEnd(26)} ` +
        `-> ${inspectedSlots(step).map(patternName).join(" ")}`,
    );
  }

  // 5. Hold the finished file against every claim the sheet is about to make.
  //
  //    applyRearrange already verified each step against its own shuffle — our code agreeing
  //    with our code. This is a different question: does the file we are shipping actually
  //    show what the printed sheet says it shows? A sheet that is wrong is worse than no
  //    sheet, because the tester reports our mistake as a hardware failure.
  const wrong: string[] = [];
  for (const step of steps) {
    for (const e of step.expected) {
      const actual = device.summarise(working, e.slot);
      const actualName = actual.occupied ? (actual.name ?? "") : null;
      if (actualName !== e.name) {
        wrong.push(
          `step ${step.n} (${step.operation}): ${patternName(e.slot)} should be ` +
            `${e.name === null ? "empty" : `"${e.name}"`} but the file has ` +
            `${actualName === null ? "an empty slot" : `"${actualName}"`}`,
        );
      }
    }
  }
  if (wrong.length > 0) {
    console.error("\nThe sheet would claim things this file does not show:");
    for (const w of wrong) console.error(`  ${w}`);
    process.exit(1);
  }
  console.log(
    `\n  all ${steps.reduce((n, s) => n + s.expected.length, 0)} slot expectations ` +
      `hold against the written file`,
  );

  mkdirSync(outDir, { recursive: true });

  const basePath = join(outDir, `HWTEST_BASE_${stamp}.dn2prj`);
  const opsPath = join(outDir, `HWTEST_OPS_${stamp}.dn2prj`);
  const sheetPath = join(outDir, `HWTEST_${stamp}.html`);

  const baseImage = Uint8Array.from(baseline.image);
  writeProjectName(baseImage, `HWBASE ${stamp}`);
  writeFileSync(basePath, buildProjectFile(project.manifest, project.payload.raw, baseImage));

  writeProjectName(working, `HWOPS ${stamp}`);
  writeFileSync(opsPath, buildProjectFile(project.manifest, project.payload.raw, working));

  // Say what the chosen seeds actually test. A pattern with no sound locks proves nothing
  // about pool references, and the sheet should not imply otherwise.
  const seeds = [SEED_SOURCES.p1, SEED_SOURCES.p2]
    .map((slot) => {
      const s = device.summarise(baseline.image, slot);
      const locks = s.soundLockCount ?? 0;
      return (
        `${patternName(slot)} "${s.name ?? "?"}" ${s.trigCount ?? 0} trigs, ` +
        `${locks === 0 ? "NO sound locks" : `${locks} sound locks`}`
      );
    })
    .join("; ");
  console.log(`\n  seeds: ${seeds}`);

  writeFileSync(
    sheetPath,
    renderSheet(
      stamp,
      describeLayout(device),
      projectPath.split(/[\\/]/).pop() ?? "",
      seeds,
      steps,
    ),
  );

  console.log(`\n  baseline: ${basePath}`);
  console.log(`  operations: ${opsPath}`);
  console.log(`  check sheet: ${sheetPath}`);
  console.log(`\n  Load the baseline first.`);
}

main();
