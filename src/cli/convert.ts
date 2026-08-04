/**
 * Convert a Digitone 1 project to Digitone II, optionally expanding it across 16 tracks.
 *
 *   npm run convert -- --from a.dnprj --expand                    # dry run, says what it would do
 *   npm run convert -- --from a.dnprj --expand --out b.dn2prj --stamp
 *
 * The template supplies every byte of the DN2 image we do not model. Any `.dn2prj` works;
 * a blank project exported from the device is the cleanest choice, since none of its
 * content survives except the parts we leave alone. It is **located rather than named** —
 * `DN_TEMPLATE`, then `DN_CORPUS`, then a sibling checkout — so `--template` is only needed
 * to override that.
 *
 * Without `--expand` the conversion is faithful: it reproduces what the Digitone II's own
 * importer does, byte for byte. With it, sound-locked sounds are promoted onto their own
 * tracks.
 */

import { writeFileSync } from "node:fs";
import { cliArgs, readProjectFile } from "./args.js";
import { basename } from "node:path";
import { buildProjectFile } from "../node/projectfile.js";
import { readProjectName } from "../project/dn1.js";
import { mintProjectId, writeProjectId } from "../project/dn2image.js";
import { findTemplate, templateSearchPaths } from "../node/open.js";
import { convertProject } from "../expand/convert.js";
import { PERCUSSION_LOW_RULES, planExpansion } from "../expand/plan.js";
import { stampedProjectName } from "../sheet/naming.js";


/**
 * Stamp a build time into the project name, so the name shown on the device says which
 * build is loaded.
 *
 * Two files that differ only in a fix are otherwise indistinguishable once they are on the
 * hardware, and a hardware test that validates the wrong build is worse than no test. The
 * name field holds 15 characters, so the base name is truncated to leave room for " HHMM".
 */


function main(): void {
  const { arg, flag } = cliArgs();

  const fromPath = arg("from");
  const templatePath = arg("template");
  const outPath = arg("out");
  const expand = flag("expand");
  const useRules = flag("rules");
  const freeMidi = flag("free-midi");
  const compact = flag("compact");
  const aggregate = flag("aggregate");
  const dryRun = flag("dry-run") || outPath === undefined;
  const nameOverride = arg("name");
  const stamp = flag("stamp");

  if (!fromPath) {
    console.error(
      "usage: npm run convert -- --from <a.dnprj> [--template <t.dn2prj>] [--out <b.dn2prj>]\n" +
        "       [--expand] [--aggregate] [--rules] [--free-midi] [--compact] [--stamp]\n" +
        "       [--name <text>] [--dry-run]",
    );
    process.exit(1);
  }

  // The template is located rather than required, the same way `--as-dn2` does it: this is
  // the project's main workflow, and typing an absolute path to the same blank project on
  // every invocation is friction with no purpose.
  const resolvedTemplate = templatePath ?? findTemplate();
  if (!resolvedTemplate) {
    console.error(
      "\nConversion needs a Digitone II project as a template — it supplies every byte of\n" +
        "the image the conversion does not model.\n" +
        "Pass --template <a.dn2prj>, or set DN_TEMPLATE. Looked in:\n" +
        templateSearchPaths()
          .map((p) => `  ${p}`)
          .join("\n") +
        "\nA blank project exported from the device is the cleanest choice.\n",
    );
    process.exit(1);
  }

  const source = readProjectFile(fromPath);
  const template = readProjectFile(resolvedTemplate);

  const plan = expand
    ? planExpansion(source.image, {
        useFreedMidiTracks: freeMidi,
        compactPerPattern: compact,
        aggregateByName: aggregate,
        ...(useRules ? { rules: PERCUSSION_LOW_RULES } : {}),
      })
    : undefined;

  const base = nameOverride ?? readProjectName(source.image);
  const projectName = stamp ? stampedProjectName(base) : nameOverride;

  const { image, report } = convertProject(source.image, template.image, {
    ...(plan ? { plan } : {}),
    ...(projectName === undefined ? {} : { projectName }),
  });

  // A converted project is a new project, so it gets its own identity rather than the
  // template's. Minted here rather than inside `convertProject` on purpose: that function's
  // contract is to reproduce Elektron's importer byte for byte, and a field that is random
  // by design cannot be part of a byte-identical comparison. Authoring a *file* is what
  // creates an identity, so it belongs at the edge. See `mintProjectId`.
  const id = mintProjectId();
  writeProjectId(image, id);

  console.log(`\n${basename(fromPath)} "${readProjectName(source.image)}"`);
  console.log(`  template: ${basename(resolvedTemplate)}`);
  console.log(`  project id: ${id.toString(16).padStart(8, "0")} (minted, not inherited)`);
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
      const members = a.groupMembers;
      console.log(
        `    T${String(a.dn2Track).padStart(2)} <- ${(a.usage.name || "(unnamed)").padEnd(17)} ` +
          `${String(a.usage.trigCount).padStart(4)} trigs` +
          (members ? `  [${members.length} sounds: ${members.map((m) => m.name).join(", ")}]` : ""),
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
