/**
 * Show the expansion plan for one or more DN1 projects.
 *
 *   npm run plan -- <file.dnprj> [...]
 *   npm run plan -- --summary 00_Examples/01_DN1/01_Projects/*.dnprj
 *   npm run plan -- --free-midi <file.dnprj>    also use DN2 tracks 5-8 when the
 *                                               corresponding DN1 MIDI track is empty
 */

import { readProjectImage } from "./args.js";
import { basename } from "node:path";
import { readProjectName } from "@noiseandmatter/dnx-core/project/dn1.js";
import { PERCUSSION_LOW_RULES, planExpansion } from "@noiseandmatter/dnx-core/expand/plan.js";


function report(path: string, useFreedMidiTracks: boolean, useRules: boolean): void {
  const image = readProjectImage(path);
  const plan = planExpansion(image, {
    useFreedMidiTracks,
    ...(useRules ? { rules: PERCUSSION_LOW_RULES } : {}),
  });
  const name = readProjectName(image);

  console.log(`\n${basename(path)}  "${name}"`);
  console.log(
    `  ${plan.livePatterns.length} live patterns, ` +
      `MIDI tracks in use: ${plan.usedMidiTracks.length ? plan.usedMidiTracks.map((t) => t - 3).join(", ") : "none"}, ` +
      `${plan.freeTracks.length} destination slots`,
  );

  if (plan.assignments.length === 0 && plan.overflow.length === 0) {
    console.log("  no sound locks — nothing to expand");
    return;
  }

  for (const a of plan.assignments) {
    const from = a.usage.sourceTracks.map((t) => `T${t + 1}`).join("+");
    console.log(
      `  T${String(a.dn2Track).padStart(2)} <- pool ${String(a.usage.poolSlot).padStart(3)} ` +
        `${(a.usage.name || "(unnamed)").padEnd(17)} ${String(a.usage.trigCount).padStart(4)} trigs ` +
        `in ${String(a.usage.patterns.length).padStart(3)} patterns, from ${from}` +
        (a.reason === "rule" ? `  [${a.rule?.name}]` : a.reason === "pinned" ? "  [pinned]" : ""),
    );
  }
  for (const u of plan.overflow) {
    console.log(
      `   -- stays locked: pool ${String(u.poolSlot).padStart(3)} ` +
        `${(u.name || "(unnamed)").padEnd(17)} ${String(u.trigCount).padStart(4)} trigs`,
    );
  }
  const total = plan.promotedTrigs + plan.overflowTrigs;
  console.log(
    `  promoted ${plan.assignments.length}/${plan.assignments.length + plan.overflow.length} sounds, ` +
      `${plan.promotedTrigs}/${total} locked trigs` +
      (plan.overflow.length ? `  (${plan.overflow.length} sounds stay put — lossless)` : ""),
  );
}

function summary(paths: string[], useFreedMidiTracks: boolean): void {
  console.log(
    `${"project".padEnd(30)}${"sounds".padStart(7)}${"fits".padStart(6)}${"over".padStart(6)}${"midi".padStart(6)}`,
  );
  let fitting = 0;
  for (const path of paths) {
    const plan = planExpansion(readProjectImage(path), { useFreedMidiTracks });
    const total = plan.assignments.length + plan.overflow.length;
    if (plan.overflow.length === 0) fitting++;
    console.log(
      `${basename(path).slice(0, 30).padEnd(30)}${String(total).padStart(7)}` +
        `${String(plan.assignments.length).padStart(6)}${String(plan.overflow.length).padStart(6)}` +
        `${String(plan.usedMidiTracks.length).padStart(6)}`,
    );
  }
  console.log(`\n${fitting}/${paths.length} projects expand with no overflow`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const useFreedMidiTracks = argv.includes("--free-midi");
  const useRules = argv.includes("--rules");
  const asSummary = argv.includes("--summary");
  const paths = argv.filter((a) => !a.startsWith("--"));

  if (paths.length === 0) {
    console.error("usage: npm run plan -- [--summary] [--free-midi] [--rules] <file.dnprj> [...]");
    process.exit(1);
  }
  if (asSummary) summary(paths, useFreedMidiTracks);
  else for (const path of paths) report(path, useFreedMidiTracks, useRules);
}

main();
