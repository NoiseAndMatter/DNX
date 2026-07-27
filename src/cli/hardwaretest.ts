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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeProjectImage } from "../project/dn2codec.js";
import { buildProjectFile, parseProject } from "../project/projectfile.js";
import { writeProjectName } from "../project/dn2image.js";
import { patternIndex, patternName } from "../sheet/naming.js";
import { deviceFor } from "../librarian/device.js";
import { applyRearrange } from "../librarian/rearrange.js";
import { copyMany, keepOnly } from "../librarian/shuffle.js";
import {
  QUIET_FAILURES,
  SEED_SOURCES,
  describeLayout,
  seedingFor,
  stepsFor,
} from "../librarian/hardwaretest.js";

const CONFIRM = { confirmOverwrite: true } as const;

function hhmm(when = new Date()): string {
  return `${String(when.getHours()).padStart(2, "0")}${String(when.getMinutes()).padStart(2, "0")}`;
}

function load(path: string) {
  const { manifest, payload } = parseProject(new Uint8Array(readFileSync(path)));
  return { manifest, payload, image: decodeProjectImage(payload.raw).image };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSheet(
  stamp: string,
  layout: string,
  sourceName: string,
  seeds: string,
  rows: { n: number; operation: string; expect: string; inspect: string }[],
): string {
  const steps = rows
    .map(
      (r) => `<tr>
    <td class="n">${r.n}</td>
    <td>${escapeHtml(r.operation)}</td>
    <td class="mono">${escapeHtml(r.inspect)}</td>
    <td>${escapeHtml(r.expect)}</td>
    <td class="tick"></td>
    <td class="note"></td>
  </tr>`,
    )
    .join("\n  ");

  const quiet = QUIET_FAILURES.map((q) => `<li>${escapeHtml(q)}</li>`).join("\n    ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DNX hardware test ${stamp} — pattern rearrangement</title>
<style>
  :root { color-scheme: light dark;
    --bg:#fff; --fg:#16181d; --muted:#6b7280; --line:#e4e6ea; --accent:#6d4aff;
    --card:#f8f9fb; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#131519; --fg:#e7e9ed; --muted:#98a0ac; --line:#2a2e35; --accent:#b5a2ff;
    --card:#191c21; --bad:#ff8a80; } }
  * { box-sizing: border-box; }
  body { background:var(--bg); color:var(--fg); margin:0 auto; padding:2rem 1.25rem 4rem;
    max-width:62rem; font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size:1.5rem; margin:0 0 .2rem; letter-spacing:-.02em; }
  h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted);
    margin:2.2rem 0 .6rem; }
  .lede { color:var(--muted); margin:0 0 1.2rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:.9rem 1.1rem; margin:.8rem 0; }
  .card strong { color:var(--accent); }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.88rem; min-width:44rem; }
  th, td { text-align:left; padding:.45rem .55rem; border-bottom:1px solid var(--line);
    vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:.72rem; text-transform:uppercase;
    letter-spacing:.05em; }
  td.n { font-weight:700; width:2rem; }
  .mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.85rem; }
  td.tick { width:3.5rem; }
  td.tick::before { content:"☐ ☐"; letter-spacing:.4rem; color:var(--muted); }
  td.note { width:12rem; border-bottom:1px solid var(--line); }
  ul { padding-left:1.1rem; }
  li { margin:.35rem 0; }
  .warn { border-left:3px solid var(--bad); padding-left:.9rem; }
  .warn strong { color:var(--bad); }
  @media print { body { max-width:none; padding:0; } .card { break-inside:avoid; } }
</style>
</head>
<body>

<h1>Pattern rearrangement — hardware test</h1>
<p class="lede">Build <span class="mono">${stamp}</span> &middot; ${escapeHtml(layout)} &middot;
seeded from ${escapeHtml(sourceName)}</p>

<div class="card">
  <strong>Load <span class="mono">HWTEST_BASE_${stamp}</span> first.</strong>
  It is the two seed patterns and 126 captured blank patterns, nothing else. If it does not
  load, or the empty slots misbehave, stop — nothing in the operations file would mean
  anything. That result alone is worth the session.
  <br><br>
  Check: <span class="mono">${patternName(SEED_SOURCES.p1)}</span> and
  <span class="mono">${patternName(SEED_SOURCES.p2)}</span> play; every other slot is empty,
  selectable, and accepts a recorded trig.
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
<div class="scroll">
<table>
  <thead><tr>
    <th>#</th><th>Operation</th><th>Look at</th><th>Expect</th><th>OK / not</th><th>What happened</th>
  </tr></thead>
  <tbody>
  ${steps}
  </tbody>
</table>
</div>

<h2>For each row, beyond &ldquo;it plays&rdquo;</h2>
<ul>
  ${quiet}
</ul>

<h2>Last, and only if the rest passed</h2>
<div class="card">
  Save the project on the device, export it, and diff it against what we wrote:
  <span class="mono">npm run diff</span>. Any byte the device changed on load is either a
  field we got wrong or one it normalises. Both are worth knowing and this is the only way
  to see them.
</div>

<div class="card warn">
  <strong>Do not run this on a project whose songs matter.</strong> The DN1's song table is
  located and guarded; the DN2's has never been found, so a DN2 rearrangement cannot be
  checked against songs. Patterns are referenced by slot, so rearranging them could desync a
  song we cannot see.
</div>

</body>
</html>
`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const projectPath = arg("project");
  const outDir = arg("out");
  if (!projectPath || !outDir) {
    console.error(
      'usage: npm run hwtest -- --project "<file>" [--keep A1 A4] --out <folder>',
    );
    process.exit(1);
  }

  const keepAt = argv.indexOf("--keep");
  const keepTokens: string[] = [];
  if (keepAt !== -1) {
    for (let i = keepAt + 1; i < argv.length && !argv[i]!.startsWith("--"); i++) {
      keepTokens.push(argv[i]!);
    }
  }

  const project = load(projectPath);
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

  // 2. Seed the slots the operations will consume, so a move can empty its source without
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

  // 3. Apply each operation in turn, verifying as we go.
  const rows: { n: number; operation: string; expect: string; inspect: string }[] = [];
  for (const step of stepsFor()) {
    const result = applyRearrange(working, step.shuffle, CONFIRM);
    if (!result.verification.ok) {
      console.error(
        `step ${step.n} (${step.operation}) failed verification: ` +
          result.verification.problems.join("; "),
      );
      process.exit(1);
    }
    working = result.image;
    rows.push({
      n: step.n,
      operation: step.operation,
      expect: step.expect,
      inspect: step.inspect.map(patternName).join(" "),
    });
    console.log(`  ${String(step.n).padStart(2)}. ${step.operation.padEnd(26)} verified`);
  }

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
      rows,
    ),
  );

  console.log(`\n  baseline: ${basePath}`);
  console.log(`  operations: ${opsPath}`);
  console.log(`  check sheet: ${sheetPath}`);
  console.log(`\n  Load the baseline first.`);
}

main();
