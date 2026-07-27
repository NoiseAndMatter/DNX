/**
 * Rearrange patterns inside one project. Dry run by default.
 *
 *   npm run rearrange -- --project <a.dn2prj>
 *   npm run rearrange -- --project <a.dn2prj> --swap A1 B12
 *   npm run rearrange -- --project <a.dn2prj> --move A1 B12
 *   npm run rearrange -- --project <a.dn2prj> --clear B12
 *   npm run rearrange -- --project <a.dn2prj> --swap A1 B12 --apply --out <new.dn2prj>
 *
 * `--swap` exchanges two slots and loses nothing. `--move` leaves the source empty, and
 * `--clear` empties a slot outright; both write a blank patternKit captured from a
 * device-initialised project, never bytes we made up.
 *
 * Works on both families — a `.dnprj` and a `.dn2prj` are the same command. Slots are named
 * the way the device names them, `A1` to `H16`, via `sheet/naming.ts` so the CLI, the
 * hardware sheets and the eventual UI cannot drift apart.
 *
 * ## Opening a Digitone 1 sketch as a Digitone II project
 *
 *   npm run rearrange -- --project sketch.dnprj --as-dn2 --expand
 *   npm run rearrange -- --project sketch.dnprj --as-dn2 --expand --move A3 --to B1 --apply --out done.dn2prj
 *
 * This is the workflow the project exists for: sketch on the DN1, finish on the DN2 with more
 * tracks and better arrangement tools. `--as-dn2` converts and optionally expands **on the way
 * in**, so conversion stops being a separate command producing an intermediate file you then
 * feed to this one. Without it a `.dnprj` is opened as what it is and rearranged as a DN1
 * project, which is a real workflow and must not be taken away.
 *
 * Without `--apply` nothing is written. With `--apply`, `--out` is required: this tool never
 * overwrites its input, because for most people the +Drive is the only copy of that work.
 */

import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { buildProjectFile } from "../project/projectfile.js";
import { patternIndex, patternName } from "../sheet/naming.js";
import { type Device } from "../librarian/device.js";
import {
  OpenError,
  type Provenance,
  describeProvenance,
  openProject,
} from "../librarian/open.js";
import { applyRearrange, planRearrange } from "../librarian/rearrange.js";
import { clear, copyMany, keepOnly, moveMany, swap } from "../librarian/shuffle.js";

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
function printGrid(project: { image: Uint8Array; device: Device; provenance: Provenance }): void {
  const { image, device } = project;
  console.log(`\n  ${device.name}  ${describeProvenance(project.provenance)}`);

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
  const confirm = argv.includes("--confirm");
  const outPath = arg("out");

  if (!projectPath) {
    console.error(
      "usage: npm run rearrange -- --project <file> [--as-dn2 [--expand]] [--swap A1 B12]\n" +
        "       [--apply --out <file>]",
    );
    process.exit(1);
  }
  if (apply && !outPath) {
    console.error("--apply requires --out. This tool never overwrites its input.");
    process.exit(1);
  }

  let project;
  try {
    project = openProject(projectPath, {
      asDn2: argv.includes("--as-dn2"),
      expand: argv.includes("--expand"),
      compact: argv.includes("--compact"),
      aggregateByName: argv.includes("--aggregate"),
      rules: argv.includes("--rules"),
      freeMidi: argv.includes("--free-midi"),
      ...(arg("template") === undefined ? {} : { template: arg("template")! }),
    });
  } catch (e) {
    if (e instanceof OpenError) {
      console.error(`\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  const device = project.device;

  if (argv.includes("--expand") && !argv.includes("--as-dn2")) {
    console.error("--expand only means something with --as-dn2, which does the conversion.");
    process.exit(1);
  }
  for (const w of project.provenance.warnings.slice(0, 5)) {
    console.log(`  warning: ${w}`);
  }

  const swapAt = argv.indexOf("--swap");
  const moveAt = argv.indexOf("--move");
  const copyAt = argv.indexOf("--copy");
  const clearAt = argv.indexOf("--clear");
  const keepAt = argv.indexOf("--keep");

  if (swapAt === -1 && moveAt === -1 && copyAt === -1 && clearAt === -1 && keepAt === -1) {
    printGrid(project);
    console.log(
      "\n  --swap <a> <b>   exchange two slots" +
        "\n  --move <a> <b>   move, leaving <a> empty" +
        "\n  --copy <a> <b>   copy, leaving <a> as it was" +
        "\n  --clear <a>      empty a slot" +
        "\n  --keep <a>...    empty every slot except these, packed to the front",
    );
    return;
  }

  const pair = (at: number): [number, number] => [
    resolveSlot(argv[at + 1] ?? "", device.patternCount),
    resolveSlot(argv[at + 2] ?? "", device.patternCount),
  ];

  /** Every token after a flag, up to the next flag. */
  const tokensAfter = (at: number): string[] => {
    const out: string[] = [];
    for (let i = at + 1; i < argv.length && !argv[i]!.startsWith("--"); i++) out.push(argv[i]!);
    return out;
  };

  /** `--move A1 A2 A3 --to C5` — many sources landing at consecutive slots. */
  const batch = (at: number, verb: string): { froms: number[]; to: number } => {
    const toArg = arg("to");
    const tokens = tokensAfter(at);
    if (toArg === undefined) {
      // Two bare slots still means "this one, there" — the single-item form.
      if (tokens.length === 2) {
        const [a, b] = pair(at);
        return { froms: [a], to: b };
      }
      console.error(`--${verb} with more than one source needs --to <slot>`);
      process.exit(1);
    }
    if (tokens.length === 0) {
      console.error(`--${verb} needs at least one source slot`);
      process.exit(1);
    }
    return {
      froms: tokens.map((t) => resolveSlot(t, device.patternCount)),
      to: resolveSlot(toArg, device.patternCount),
    };
  };

  let shuffle;
  let headline: string;
  if (swapAt !== -1) {
    const [a, b] = pair(swapAt);
    shuffle = swap(a, b);
    headline = `swap ${patternName(a)} <-> ${patternName(b)}`;
  } else if (moveAt !== -1) {
    const { froms, to } = batch(moveAt, "move");
    shuffle = moveMany(froms, to);
    headline = `move ${froms.map(patternName).join(", ")} -> from ${patternName(to)}, leaving the source(s) empty`;
  } else if (copyAt !== -1) {
    const { froms, to } = batch(copyAt, "copy");
    shuffle = copyMany(froms, to);
    headline = `copy ${froms.map(patternName).join(", ")} -> from ${patternName(to)}, leaving the source(s) in place`;
  } else if (clearAt !== -1) {
    const slots = tokensAfter(clearAt).map((t) => resolveSlot(t, device.patternCount));
    if (slots.length === 0) {
      console.error("--clear needs at least one slot");
      process.exit(1);
    }
    shuffle = clear(...slots);
    headline = `clear ${slots.map(patternName).join(", ")}`;
  } else {
    // Everything after --keep, up to the next flag, is a slot to preserve.
    const tokens: string[] = [];
    for (let i = keepAt + 1; i < argv.length && !argv[i]!.startsWith("--"); i++) {
      tokens.push(argv[i]!);
    }
    if (tokens.length === 0) {
      console.error("--keep needs at least one slot");
      process.exit(1);
    }
    const keep = tokens.map((t) => resolveSlot(t, device.patternCount));
    shuffle = keepOnly(keep, device.patternCount);
    headline =
      `keep ${keep.map(patternName).join(", ")} at ` +
      `${keep.map((_, i) => patternName(i)).join(", ")}, empty the other ` +
      `${device.patternCount - keep.length}`;
  }

  const plan = planRearrange(project.image, shuffle);

  console.log(
    `\n${basename(projectPath)}  ${plan.deviceName}  "${device.projectName(project.image)}"`,
  );
  console.log(`\n  ${headline}`);

  if (plan.emptied.length > 0) {
    const shown = plan.emptied.slice(0, 12).map(patternName).join(", ");
    const more = plan.emptied.length > 12 ? ` and ${plan.emptied.length - 12} more` : "";
    console.log(
      `    emptied: ${shown}${more}  (blank captured from ${plan.blankSource})`,
    );
  }

  for (const change of plan.changes) {
    const target = change.destinationOccupied
      ? `${patternName(change.to)} "${change.destinationName ?? "?"}" (${change.destinationTrigCount} trigs)`
      : `${patternName(change.to)} (empty)`;
    console.log(
      `    ${patternName(change.from)} "${change.sourceName ?? "?"}"`.padEnd(30) +
        ` -> ${target}`,
    );
  }

  if (plan.destructive.length > 0) {
    const total = plan.destructive.reduce((n, c) => n + c.trigCount, 0);
    console.log(`\n  DESTRUCTIVE — ${plan.destructive.length} slot(s), ${total} trigs:`);
    for (const c of plan.destructive) {
      console.log(
        `    ${patternName(c.slot)} "${c.name ?? "?"}" (${c.trigCount} trigs) ` +
          (c.replacedBy === undefined
            ? "will be emptied"
            : `will be overwritten by ${patternName(c.replacedBy)}`),
      );
    }
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

  if (plan.destructive.length > 0 && !confirm) {
    console.error(
      "\n  Refusing to destroy the slots listed above without --confirm." +
        "\n  Re-run with --confirm once you have read them.",
    );
    process.exit(1);
  }

  const { image, verification } = applyRearrange(project.image, shuffle, {
    confirmOverwrite: confirm,
  });
  if (!verification.ok) {
    console.error(`\n  VERIFICATION FAILED, nothing written:`);
    for (const problem of verification.problems) console.error(`    - ${problem}`);
    process.exit(1);
  }

  writeFileSync(outPath!, buildProjectFile(project.manifest, project.payload.raw, image));
  console.log(`\n  verified and written: ${outPath}`);
}

main();
