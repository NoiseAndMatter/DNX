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

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseProject } from "../project/projectfile.js";
import { decodeProjectImage } from "../project/dn2codec.js";
import { buildProjectFile } from "../project/projectfile.js";
import { readProjectName } from "../project/dn1.js";
import { applyPatternCopy, freePoolSlots, planPatternCopy } from "../librarian/copy.js";

function load(path: string) {
  const { manifest, payload } = parseProject(new Uint8Array(readFileSync(path)));
  return { manifest, payload, image: decodeProjectImage(payload.raw).image };
}

/** Bank letter and 1-based position, the way the device labels patterns. */
function label(index: number): string {
  return `${String.fromCharCode(65 + Math.floor(index / 16))}${(index % 16) + 1}`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const fromPath = arg("from");
  const toPath = arg("to");
  const pattern = Number(arg("pattern"));
  const slot = Number(arg("slot"));
  const apply = argv.includes("--apply");
  const force = argv.includes("--force");
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

  const src = load(fromPath);
  const dst = load(toPath);
  const plan = planPatternCopy(src.image, pattern, dst.image, slot);

  console.log(
    `\n${basename(fromPath)} "${readProjectName(src.image)}" pattern ${label(pattern)} ` +
      `"${plan.sourceName}"`,
  );
  console.log(
    `  -> ${basename(toPath)} "${readProjectName(dst.image)}" slot ${label(slot)} ` +
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
