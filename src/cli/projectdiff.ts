/**
 * Diff two readings of the same project, to find where a feature lives.
 *
 * ```
 * npm run projectdiff -- baseline.dn2prj withsong.dn2prj
 * npm run projectdiff -- baseline.dn2prj withsong.dn2prj --noise nullsave.dn2prj
 * ```
 *
 * ## The method
 *
 * Save a project. Change **one thing** on the instrument. Save again. Whatever moved is that thing.
 * No inference, no statistics, no ranked candidates — the bytes either changed or they did not.
 *
 * This exists because the Digitone II's song table has never been located, and the alternative was a
 * statistical scanner that kept failing its own examination against the Digitone 1.
 *
 * ## Take the null save
 *
 * `--noise` is the part it is easy to skip and expensive to skip. A project re-saved with **no
 * changes** is not guaranteed to be byte-identical: counters and timestamps move on their own. Diff
 * original against null-save first, pass it here as `--noise`, and those regions stop being
 * attributed to the thing under investigation.
 *
 * Without it, the first run of any hunt reports save bookkeeping as a discovery.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseProject } from "../node/projectfile.js";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { layoutFor } from "@noiseandmatter/dnx-core/project/dn2image.js";
import { changedRuns, diffImages, summarise } from "@noiseandmatter/dnx-core/project/imagediff.js";

const args = process.argv.slice(2);
const noiseAt = args.indexOf("--noise");
const noisePath = noiseAt >= 0 ? args[noiseAt + 1] : undefined;
const files = args.filter((a, i) => a !== "--noise" && i !== noiseAt + 1 && !a.startsWith("--"));

if (files.length !== 2) {
  console.error("usage: npm run projectdiff -- <baseline> <changed> [--noise <nullsave>]");
  process.exit(2);
}

function imageOf(path: string): Uint8Array {
  const { payload } = parseProject(new Uint8Array(readFileSync(path)));
  return decodeProjectImage(payload.raw).image;
}

const before = imageOf(files[0]!);
const after = imageOf(files[1]!);
const layout = layoutFor(before);

const noise = noisePath ? changedRuns(before, imageOf(noisePath)) : undefined;
if (noisePath) {
  const bytes = noise!.reduce((n, r) => n + r.length, 0);
  console.log(
    `noise floor from ${basename(noisePath)}: ${noise!.length} region(s), ` +
      `${bytes.toLocaleString()} bytes — discounted below\n`,
  );
} else {
  // Said every time, because the absence of a control is not visible in the output otherwise.
  console.log(
    "no --noise given: whatever a plain re-save changes will appear below as though it were the " +
      "thing you are looking for\n",
  );
}

const runs = diffImages(before, after, { ...(noise ? { noise } : {}) });

console.log(`${basename(files[0]!)} -> ${basename(files[1]!)}`);
for (const line of summarise(runs, layout)) console.log(`  ${line}`);
console.log();

// The tail first and in full: it is where an unlocated table would be. Everything else is capped,
// because a hundred changed patterns is a fact about the experiment rather than about the format.
const tail = runs.filter((r) => r.from >= layout.tailBase);
const rest = runs.filter((r) => r.from < layout.tailBase);

if (tail.length > 0) {
  console.log(`TAIL — ${tail.length} region(s)`);
  for (const r of tail) {
    console.log(
      `  +0x${(r.from - layout.tailBase).toString(16).padStart(6, "0")}  ` +
        `${r.length.toString().padStart(7)} bytes  ${r.where}`,
    );
  }
  console.log();
}

if (rest.length > 0) {
  console.log(`OUTSIDE THE TAIL — ${rest.length} region(s), first 20`);
  for (const r of rest.slice(0, 20)) {
    console.log(`  0x${r.from.toString(16).padStart(8, "0")}  ${r.length.toString().padStart(7)} bytes  ${r.where}+${r.offsetInRegion}`);
  }
}
