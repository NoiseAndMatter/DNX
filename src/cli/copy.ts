/**
 * Copy a pattern between slots, banks or projects. Dry run by default.
 *
 *   npm run copy -- --from <a.dnprj> --pattern 3 --to <b.dnprj> --slot 17
 *   npm run copy -- --from a.dnprj --pattern 3 --to b.dnprj --slot 17 --apply --out new.dnprj
 *
 * Without --apply nothing is written. With --apply, --out is required: this tool never
 * overwrites its input, because a pattern copy destroys whatever occupied the destination
 * and for most people the +Drive is the only copy of that work.
 */

import { writeFileSync } from "node:fs";
import { cliArgs, readProjectFile } from "./args.js";
import { basename } from "node:path";
import { buildProjectFile } from "../node/projectfile.js";
import { readProjectName } from "../project/dn1.js";
import { applyPatternCopy, freePoolSlots, planPatternCopy } from "../librarian/copy.js";
import { patternName } from "../project/naming.js";

function main(): void {
  const { arg, flag } = cliArgs();

  const fromPath = arg("from");
  const toPath = arg("to");
  const pattern = Number(arg("pattern"));
  const slot = Number(arg("slot"));
  const apply = flag("apply");
  const force = flag("force");
  const outPath = arg("out");

  if (!fromPath || !toPath || Number.isNaN(pattern) || Number.isNaN(slot)) {
    console.error(
      "usage: npm run copy -- --from <a.dnprj> --pattern N --to <b.dnprj> --slot M " +
        "[--apply --out <new.dnprj>] [--force]",
    );
    process.exit(1);
  }
  if (apply && !outPath) {
    console.error("--apply requires --out. This tool never overwrites its input.");
    process.exit(1);
  }

  const src = readProjectFile(fromPath);
  const dst = readProjectFile(toPath);
  const plan = planPatternCopy(src.image, pattern, dst.image, slot);

  console.log(
    `\n${basename(fromPath)} "${readProjectName(src.image)}" pattern ${patternName(pattern)} ` +
      `"${plan.sourceName}"`,
  );
  console.log(
    `  -> ${basename(toPath)} "${readProjectName(dst.image)}" slot ${patternName(slot)} ` +
      `"${plan.destinationName}"`,
  );

  if (plan.destinationOccupied) {
    console.log(
      `\n  WARNING: destination holds ${plan.destinationTrigCount} trigs. They will be lost.`,
    );
  }

  if (plan.soundMoves.length === 0) {
    console.log("\n  no sound locks — the pattern carries no pool dependencies");
  } else {
    console.log(`\n  ${plan.soundMoves.length} sound(s) referenced by sound locks:`);
    for (const m of plan.soundMoves) {
      console.log(
        `    pool ${String(m.from).padStart(3)} -> ${String(m.to).padStart(3)}  ` +
          `${(m.name || "(unnamed)").padEnd(17)} ${String(m.trigCount).padStart(3)} trigs  ` +
          `${m.reused ? "(already present, reused)" : "(copied)"}`,
      );
    }
  }
  for (const u of plan.unresolved) {
    console.log(
      `    pool ${String(u.from).padStart(3)} -> ???  ${(u.name || "(unnamed)").padEnd(17)} ` +
        `${String(u.trigCount).padStart(3)} trigs  NO FREE SLOT`,
    );
  }
  console.log(
    `\n  destination pool: ${freePoolSlots(dst.image).length} free before, ` +
      `${plan.poolSlotsWritten.length} to be written`,
  );

  if (!plan.ok) {
    console.log("\n  PLAN NOT OK — the destination sound pool is full.");
    console.log("  Free some pool slots, or pass --force to copy anyway (locks will be wrong).");
  }

  if (!apply) {
    console.log("\n  dry run — nothing written. Add --apply --out <file> to commit.");
    return;
  }

  const { image } = applyPatternCopy(src.image, pattern, dst.image, slot, { force });
  writeFileSync(outPath!, buildProjectFile(dst.manifest, dst.payload.raw, image));
  console.log(`\n  written: ${outPath}`);
}

main();
