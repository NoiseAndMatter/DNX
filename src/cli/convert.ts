/**
 * Convert a Digitone 1 project to Digitone II, optionally expanding it across 16 tracks.
 *
 *   npm run convert -- --from a.dnprj --template EMPTY.dn2prj --out b.dn2prj
 *   npm run convert -- --from a.dnprj --template EMPTY.dn2prj --out b.dn2prj --expand
 *   npm run convert -- --from a.dnprj --template EMPTY.dn2prj --dry-run --expand
 *
 * The template supplies every byte of the DN2 image we do not model. Any `.dn2prj` works;
 * a blank project exported from the device is the cleanest choice, since none of its
 * content survives except the parts we leave alone.
 *
 * Without `--expand` the conversion is faithful: it reproduces what the Digitone II's own
 * importer does, byte for byte. With it, sound-locked sounds are promoted onto their own
 * tracks.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseProject } from "../project/container.js";
import { decodeProjectImage } from "../project/dn2codec.js";
import { buildProjectFile } from "../project/write.js";
import { readProjectName } from "../project/dn1.js";
import { convertProject } from "../expand/convert.js";
import { PERCUSSION_LOW_RULES, planExpansion } from "../expand/plan.js";

function load(path: string) {
  const { manifest, payload } = parseProject(new Uint8Array(readFileSync(path)));
  return { manifest, payload, image: decodeProjectImage(payload.raw).image };
}

/**
 * Stamp a build time into the project name, so the name shown on the device says which
 * build is loaded.
 *
 * Two files that differ only in a fix are otherwise indistinguishable once they are on the
 * hardware, and a hardware test that validates the wrong build is worse than no test. The
 * name field holds 15 characters, so the base name is truncated to leave room for " HHMM".
 */
function stampName(name: string, when = new Date()): string {
  const hhmm = `${String(when.getHours()).padStart(2, "0")}${String(when.getMinutes()).padStart(2, "0")}`;
  const room = 15 - (hhmm.length + 1);
  return `${name.slice(0, room).trimEnd()} ${hhmm}`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const fromPath = arg("from");
  const templatePath = arg("template");
  const outPath = arg("out");
  const expand = argv.includes("--expand");
  const useRules = argv.includes("--rules");
  const freeMidi = argv.includes("--free-midi");
  const compact = argv.includes("--compact");
  const dryRun = argv.includes("--dry-run") || outPath === undefined;
  const nameOverride = arg("name");
  const stamp = argv.includes("--stamp");

  if (!fromPath || !templatePath) {
    console.error(
      "usage: npm run convert -- --from <a.dnprj> --template <t.dn2prj> [--out <b.dn2prj>]\n" +
        "       [--expand] [--rules] [--free-midi] [--compact] [--stamp] [--name <text>] [--dry-run]",
    );
    process.exit(1);
  }

  const source = load(fromPath);
  const template = load(templatePath);

  const plan = expand
    ? planExpansion(source.image, {
        useFreedMidiTracks: freeMidi,
        compactPerPattern: compact,
        ...(useRules ? { rules: PERCUSSION_LOW_RULES } : {}),
      })
    : undefined;

  const base = nameOverride ?? readProjectName(source.image);
  const projectName = stamp ? stampName(base) : nameOverride;

  const { image, report } = convertProject(source.image, template.image, {
    ...(plan ? { plan } : {}),
    ...(projectName === undefined ? {} : { projectName }),
  });

  console.log(`\n${basename(fromPath)} "${readProjectName(source.image)}"`);
  console.log(`  template: ${basename(templatePath)}`);
  if (projectName !== undefined) console.log(`  project name: "${projectName}"`);
  console.log(
    `  ${report.patternsWritten} patterns, ${report.trigsWritten} trigs, ` +
      `${report.soundLocksWritten} sound locks, ${report.soundsConverted} sounds`,
  );

  if (plan) {
    console.log(
      `\n  expanded: ${report.trigsPromoted} trigs promoted onto tracks ` +
        `{${[...report.tracksUsed].sort((a, b) => a - b).join(", ")}}`,
    );
    console.log(
      `  ${plan.assignments.length} sounds promoted, ${plan.overflow.length} stay sound-locked` +
        (plan.overflow.length ? " (lossless)" : ""),
    );
    if (plan.perPattern) {
      const holes = [...plan.perPattern.values()].reduce((n, a) => n + a.overflow.length, 0);
      console.log(
        `  compact: destinations allocated per pattern, ` +
          `${plan.perPattern.size} live patterns, ${holes} per-pattern overflow(s)`,
      );
    }
    for (const a of plan.assignments) {
      console.log(
        `    T${String(a.dn2Track).padStart(2)} <- ${(a.usage.name || "(unnamed)").padEnd(17)} ` +
          `${String(a.usage.trigCount).padStart(4)} trigs`,
      );
    }
  } else {
    console.log("  faithful conversion — no expansion (add --expand)");
  }

  const unmapped = report.warnings.filter((w) => !w.message.includes("interpolated"));
  const capacity = report.warnings.filter((w) => w.kind === "capacity");
  if (unmapped.length) {
    console.log(`\n  ${unmapped.length} field(s) could not be mapped and were dropped:`);
    for (const w of unmapped.slice(0, 5)) console.log(`    ${w.message}`);
    if (unmapped.length > 5) console.log(`    ... and ${unmapped.length - 5} more`);
  }
  if (capacity.length) {
    console.log(`\n  ${capacity.length} capacity problem(s):`);
    for (const w of capacity.slice(0, 5)) console.log(`    ${w.message}`);
  }

  if (dryRun) {
    console.log("\n  dry run — nothing written. Add --out <file> to commit.");
    return;
  }

  // The manifest and container header come from the template, since the output is a DN2
  // file: its firmware version, payload entry name and device signature must be the DN2's.
  writeFileSync(outPath!, buildProjectFile(template.manifest, template.payload.raw, image));
  console.log(`\n  written: ${outPath}`);
}

main();
