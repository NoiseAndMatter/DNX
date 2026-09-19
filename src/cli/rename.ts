/**
 * Rename patterns. Dry run by default.
 *
 *   npm run rename -- --project a.dn2prj                          # what everything is called
 *   npm run rename -- --project a.dn2prj --pattern A1 --to "INTRO"
 *   npm run rename -- --project a.dn2prj --pattern A1 --to "INTRO" --apply --out new.dn2prj
 *
 * Same shape as `rearrange` and `track`: look first, `--apply --out` to commit, and never
 * overwrite the input, because for most people the +Drive is the only copy of that work.
 *
 * The device has this operation — SETTINGS > PATTERN > RENAME — so the name written here is
 * the name it will show. Both families, since both keep a 16-byte name in the pattern record.
 *
 * Batch renaming by position, by selection order or from a base name is coming; the librarian
 * already takes a `slot -> name` map so a scheme is a naming function and nothing else.
 */

import { writeFileSync } from "node:fs";
import { cliArgs, fail } from "./args.js";
import { basename } from "node:path";
import { buildProjectFile } from "../node/projectfile.js";
import { patternIndex, patternName } from "../project/naming.js";
import { OpenError, openProject } from "../node/open.js";
import {
  NAME_SIZE,
  applyRename,
  normaliseName,
  planRename,
  readPatternName,
  verifyRename,
} from "../librarian/rename.js";


/**
 * Every pattern worth listing, so a rename can be aimed without opening the device.
 *
 * Empty slots left at the factory name are hidden and counted instead. A blank pattern is
 * called `UNTITLED`, so listing them all prints 120-odd identical rows and buries the handful
 * that carry work — which is the opposite of what someone about to rename something needs.
 */
function printNames(image: Uint8Array, device: ReturnType<typeof openProject>["device"]): void {
  const rows: string[] = [];
  let hidden = 0;

  for (let pattern = 0; pattern < device.patternCount; pattern++) {
    const summary = device.summarise(image, pattern);
    if (!summary.supported) {
      rows.push(`  ${patternName(pattern).padEnd(6)}(storage version ${summary.version}, not readable)`);
      continue;
    }
    const name = summary.name ?? "";
    if (!summary.occupied && (name === "" || name === DEFAULT_NAME)) {
      hidden++;
      continue;
    }
    rows.push(
      `  ${patternName(pattern).padEnd(6)}${(name || "—").padEnd(18)}` +
        `${String(summary.trigCount ?? 0).padStart(5)}${summary.occupied ? "" : "   (empty)"}`,
    );
  }

  if (rows.length === 0) {
    console.log(`\n  All ${hidden} slots are empty and still called ${DEFAULT_NAME}.`);
    return;
  }
  console.log(`\n  slot  name              trigs`);
  for (const row of rows) console.log(row);
  if (hidden > 0) console.log(`\n  ${hidden} empty slot(s) still called ${DEFAULT_NAME}, not listed`);
}

/** What an untouched pattern is called. Hidden from the listing unless it holds trigs. */
const DEFAULT_NAME = "UNTITLED";

function main(): void {
  const { arg, flag } = cliArgs();

  const projectPath = arg("project");
  const apply = flag("apply");
  const outPath = arg("out");

  if (!projectPath) {
    fail(
      "usage: npm run rename -- --project <file> [--pattern A1 --to <name>]\n" +
        "       [--apply --out <file>]",
    );
  }
  if (apply && !outPath) fail("--apply requires --out. This tool never overwrites its input.");

  let project;
  try {
    project = openProject(projectPath, {
      asDn2: flag("as-dn2"),
      ...(arg("template") === undefined ? {} : { template: arg("template")! }),
    });
  } catch (e) {
    if (e instanceof OpenError) fail(`\n${e.message}\n`);
    throw e;
  }
  const device = project.device;

  const patternArg = arg("pattern");
  const to = arg("to");

  console.log(
    `\n${basename(projectPath)}  ${device.name}  "${device.projectName(project.image)}"`,
  );

  if (patternArg === undefined || to === undefined) {
    printNames(project.image, device);
    console.log(
      `\n  --pattern <slot> --to <name>   rename one pattern` +
        `\n\n  Names are up to ${NAME_SIZE} characters and are upper-cased: the device has no` +
        `\n  lowercase, and not one of 13,488 corpus names uses one.`,
    );
    return;
  }

  const pattern = patternIndex(patternArg.toUpperCase()) ?? Number(patternArg);
  if (!Number.isInteger(pattern) || pattern < 0 || pattern >= device.patternCount) {
    fail(`Not a pattern slot: "${patternArg}". Use A1..H16, or 0..${device.patternCount - 1}.`);
  }

  const renames = new Map([[pattern, to]]);
  const plan = planRename(project.image, device, renames);

  // What the typed name became, before anything else — a surprise belongs here rather than on
  // the device. The reasons come from the plan's findings below rather than being printed
  // twice; `normaliseName` is called only for the arrow.
  const { name } = normaliseName(to);
  console.log(
    `\n  ${patternName(pattern)}  "${readPatternName(project.image, device, pattern)}"  ->  "${name}"`,
  );

  for (const finding of plan.findings) {
    console.log(`\n  ${finding.severity === "blocker" ? "BLOCKED" : "note"}: ${finding.message}`);
  }

  if (!plan.ok) {
    console.log("\n  Nothing written.");
    process.exit(1);
  }
  if (plan.changes.length === 0) {
    console.log("\n  Nothing to do.");
    return;
  }
  if (!apply) {
    console.log("\n  dry run — nothing written. Add --apply --out <file> to commit.");
    return;
  }

  const { image } = applyRename(project.image, device, renames);
  const verification = verifyRename(project.image, image, device, plan);
  if (!verification.ok) {
    console.error(`\n  VERIFICATION FAILED, nothing written:`);
    for (const problem of verification.problems) console.error(`    - ${problem}`);
    process.exit(1);
  }

  writeFileSync(outPath!, buildProjectFile(project.manifest, project.payload.raw, image));
  console.log(`\n  verified and written: ${outPath}`);
}

main();
