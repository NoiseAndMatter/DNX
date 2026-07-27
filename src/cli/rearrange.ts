/**
 * Rearrange patterns inside one project. Dry run by default.
 *
 *   npm run rearrange -- --project <a.dn2prj>
 *   npm run rearrange -- --project <a.dn2prj> --swap A1 B12
 *   npm run rearrange -- --project <a.dn2prj> --swap A1 B12 --apply --out <new.dn2prj>
 *
 * Works on both families — a `.dnprj` and a `.dn2prj` are the same command. Slots are named
 * the way the device names them, `A1` to `H16`, via `sheet/naming.ts` so the CLI, the
 * hardware sheets and the eventual UI cannot drift apart.
 *
 * Without `--apply` nothing is written. With `--apply`, `--out` is required: this tool never
 * overwrites its input, because for most people the +Drive is the only copy of that work.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { decodeProjectImage } from "../project/dn2codec.js";
import { buildProjectFile, parseProject } from "../project/projectfile.js";
import { patternIndex, patternName } from "../sheet/naming.js";
import { deviceFor } from "../librarian/device.js";
import { applyRearrange, planRearrange } from "../librarian/rearrange.js";
import { swap } from "../librarian/shuffle.js";

function load(path: string) {
  const { manifest, payload } = parseProject(new Uint8Array(readFileSync(path)));
  return { manifest, payload, image: decodeProjectImage(payload.raw).image };
}

function resolveSlot(token: string, patternCount: number): number {
  const named = patternIndex(token.toUpperCase());
  const index = named ?? Number(token);
  if (!Number.isInteger(index) || index < 0 || index >= patternCount) {
    console.error(`Not a pattern slot: "${token}". Use A1..H16, or 0..${patternCount - 1}.`);
    process.exit(1);
  }
  return index;
}

/** The occupancy grid, so a rearrangement can be aimed without opening the device. */
function printGrid(image: Uint8Array): void {
  const device = deviceFor(image);
  console.log(`\n  ${device.name}  "${device.projectName(image)}"`);

  const rows: string[] = [];
  for (let bank = 0; bank * 16 < device.patternCount; bank++) {
    const cells: string[] = [];
    for (let i = 0; i < 16; i++) {
      const summary = device.summarise(image, bank * 16 + i);
      if (!summary.supported) cells.push("?");
      else cells.push(summary.occupied ? "#" : ".");
    }
    rows.push(`    ${String.fromCharCode(65 + bank)}  ${cells.join(" ")}`);
  }
  const header = Array.from({ length: 16 }, (_, i) => String((i + 1) % 10)).join(" ");
  console.log(`\n       ${header}`);
  for (const row of rows) console.log(row);
  console.log("\n    # holds trigs   . empty   ? storage version we do not read");
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const projectPath = arg("project");
  const apply = argv.includes("--apply");
  const outPath = arg("out");

  if (!projectPath) {
    console.error(
      "usage: npm run rearrange -- --project <file> [--swap A1 B12] [--apply --out <file>]",
    );
    process.exit(1);
  }
  if (apply && !outPath) {
    console.error("--apply requires --out. This tool never overwrites its input.");
    process.exit(1);
  }

  const project = load(projectPath);
  const device = deviceFor(project.image);

  const swapAt = argv.indexOf("--swap");
  if (swapAt === -1) {
    printGrid(project.image);
    console.log("\n  Pass --swap <slot> <slot> to plan a rearrangement.");
    return;
  }

  const a = resolveSlot(argv[swapAt + 1] ?? "", device.patternCount);
  const b = resolveSlot(argv[swapAt + 2] ?? "", device.patternCount);
  const shuffle = swap(a, b);
  const plan = planRearrange(project.image, shuffle);

  console.log(
    `\n${basename(projectPath)}  ${plan.deviceName}  "${device.projectName(project.image)}"`,
  );
  console.log(`\n  swap ${patternName(a)} <-> ${patternName(b)}`);

  for (const change of plan.changes) {
    console.log(
      `    ${patternName(change.from)} "${change.sourceName ?? "?"}"` +
        ` -> ${patternName(change.to)} "${change.destinationName ?? "?"}"` +
        (change.destinationOccupied ? `  (${change.destinationTrigCount} trigs replaced)` : ""),
    );
  }

  for (const finding of plan.findings) {
    console.log(`\n  ${finding.severity === "blocker" ? "BLOCKED" : "WARNING"}: ${finding.message}`);
  }

  if (!plan.ok) {
    console.log("\n  Nothing written.");
    process.exit(1);
  }

  if (!apply) {
    console.log("\n  dry run — nothing written. Add --apply --out <file> to commit.");
    return;
  }

  const { image, verification } = applyRearrange(project.image, shuffle);
  if (!verification.ok) {
    console.error(`\n  VERIFICATION FAILED, nothing written:`);
    for (const problem of verification.problems) console.error(`    - ${problem}`);
    process.exit(1);
  }

  writeFileSync(outPath!, buildProjectFile(project.manifest, project.payload.raw, image));
  console.log(`\n  verified and written: ${outPath}`);
}

main();
