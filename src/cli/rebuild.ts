/**
 * Turn a capture read off a device back into a project file. Dry run by default.
 *
 *   npm run rebuild -- --capture DigitoneII_Project_257msg.syx
 *   npm run rebuild -- --capture c.syx --donor EMPTY.dn2prj
 *   npm run rebuild -- --capture c.syx --donor EMPTY.dn2prj --apply --out RECOVERED.dn2prj
 *
 * Same shape as `rearrange`, `rename` and `track`: look first, `--apply --out` to commit, never
 * overwrite an input. Here that rule matters twice over, because both inputs are irreplaceable —
 * the capture took a minute of the device's time and the donor is somebody's project.
 *
 * ## The donor is not optional, and the report says why
 *
 * A capture is 99.5% of a project. The rest — the image header, the tail before the pool, the song
 * table and the slot array — is never sent, so it has to come from an existing project file. That
 * makes this a **restore onto a donor** rather than a reconstruction from nothing, and the
 * difference shows up the first time somebody expects their songs back.
 *
 * With no `--donor` the template is used (`DN_TEMPLATE`, `DN_CORPUS` or a sibling checkout), which
 * is the right default: a device-authored blank contributes an empty song table and an empty slot
 * array rather than another project's.
 */

import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseFile } from "../sysex/container.js";
import { PRODUCT_NAMES } from "../sysex/devices.js";
import { buildProjectFile } from "../project/projectfile.js";
import { projectName, writeProjectName } from "../project/dn2image.js";
import { OpenError, findTemplate, openProject } from "../librarian/open.js";
import {
  type Dn1Sounds,
  RebuildError,
  applyRebuild,
  coverage,
  planRebuild,
  verifyRebuild,
} from "../project/rebuild.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const capturePath = arg("capture");
  const apply = argv.includes("--apply");
  const outPath = arg("out");

  if (!capturePath) {
    fail(
      "usage: npm run rebuild -- --capture <file.syx> [--donor <file.dn2prj>]\n" +
        "       [--pool <pool.syx>] [--dn1-sounds pool|kit]\n" +
        "       [--name <project name>] [--apply --out <file>]",
    );
  }
  if (apply && !outPath) fail("--apply requires --out. This tool never overwrites its inputs.");

  let messages;
  try {
    messages = parseFile(new Uint8Array(readFileSync(capturePath)));
  } catch (e) {
    fail(`\nCould not read ${basename(capturePath)} as a SysEx capture:\n  ${String(e)}\n`);
  }

  // The one thing the bytes cannot tell us. A Digitone 1 sends kit track sounds and pool sounds
  // under the same dump type, and placing the former as the latter would overwrite sound-lock
  // targets 0..3 without a word.
  const given = arg("dn1-sounds");
  if (given !== undefined && given !== "pool" && given !== "kit") {
    fail("--dn1-sounds takes 'pool' (a front-panel pool send) or 'kit' (a request's four sounds)");
  }
  let dn1Sounds: Dn1Sounds | undefined = given;

  // A complete Digitone 1 restore is **two captures**: the project read, which has no pool in it,
  // plus a front-panel `SETTINGS > SYSEX DUMP` pool send, which is 0x53 records numbered by pool
  // slot. Verified on hardware — 93 messages, objNr 0..92, covering every slot the project's
  // sound locks reference.
  const poolPath = arg("pool");
  if (poolPath) {
    let poolMessages;
    try {
      poolMessages = parseFile(new Uint8Array(readFileSync(poolPath)));
    } catch (e) {
      fail(`\nCould not read ${basename(poolPath)} as a SysEx capture:\n  ${String(e)}\n`);
    }
    // The project capture's own 0x53 records are dropped rather than merged: on a DN1 they are the
    // active kit's track sounds, which already sit inside their patternKit, and three of the four
    // observed were not in the pool at all. Keeping them would put sounds in the pool that the
    // device never had there.
    messages = [...messages.filter((m) => m.dumpType !== 0x53), ...poolMessages];
    dn1Sounds = "pool";
  }

  let plan;
  try {
    plan = planRebuild(messages, dn1Sounds === undefined ? {} : { dn1Sounds });
  } catch (e) {
    if (e instanceof RebuildError) fail(`\n${e.message}\n`);
    throw e;
  }

  const donorPath = arg("donor") ?? findTemplate();
  if (!donorPath) {
    fail(
      "\nNo donor project. A capture carries 99.5% of a project; the header, the song table and\n" +
        "the slot array are never sent and have to come from an existing file.\n\n" +
        "  --donor <file>   an existing project of the same family\n\n" +
        "A blank exported from your own device is the cleanest choice: it contributes an empty\n" +
        "song table rather than another project's.\n",
    );
  }

  let donor;
  try {
    donor = openProject(donorPath);
  } catch (e) {
    if (e instanceof OpenError) fail(`\n${e.message}\n`);
    throw e;
  }

  report(plan, capturePath, donorPath, donor.image);

  if (!apply) {
    console.log(`\n  Dry run. Add --apply --out <file> to write it.\n`);
    return;
  }

  const image = applyRebuild(donor.image, plan);

  // Renamed here rather than in the library: the image is authored at this point, and the library
  // has no business deciding what a restored project should be called. Without it the project
  // carries the donor's name, which for a template means every restore is called EMPTY.
  const name = arg("name");
  if (name !== undefined) writeProjectName(image, name);

  const problems = verifyRebuild(image, plan);
  if (problems.length > 0) {
    fail(
      `\nRefusing to write: the image does not hold what the plan said it would.\n` +
        problems.slice(0, 10).map((p) => `  ${p}`).join("\n") +
        (problems.length > 10 ? `\n  ...and ${problems.length - 10} more` : "") +
        "\n",
    );
  }

  writeFileSync(outPath!, buildProjectFile(donor.manifest, donor.payload.raw, image));
  console.log(`\n  Wrote ${outPath} — verified, ${plan.patterns.length} pattern(s) restored.\n`);
}

function report(
  plan: ReturnType<typeof planRebuild>,
  capturePath: string,
  donorPath: string,
  donorImage: Uint8Array,
): void {
  const product = PRODUCT_NAMES[plan.productId] ?? `product ${plan.productId}`;
  const { supplied, total } = coverage(plan);
  const percent = ((supplied / total) * 100).toFixed(2);

  console.log(`\n${basename(capturePath)}  ${product}`);
  console.log(`  donor: ${basename(donorPath)}  "${projectName(donorImage)}"`);
  console.log(`\n  from the capture`);
  console.log(`    patterns   ${String(plan.patterns.length).padStart(4)}`);
  console.log(`    kits       ${String(plan.kits.length).padStart(4)}`);
  console.log(`    sounds     ${String(plan.sounds.length).padStart(4)}  (project pool)`);
  console.log(`    settings   ${String(plan.settings.length).padStart(4)}`);
  console.log(`    ${supplied.toLocaleString()} of ${total.toLocaleString()} bytes — ${percent}%`);

  // Named, not counted. "63,620 bytes came from elsewhere" tells nobody anything; "the song table
  // came from elsewhere" tells them whether it matters to them.
  console.log(`\n  from the donor`);
  for (const region of plan.fromDonor) console.log(`    ${region.replace(/\*\*/g, "")}`);

  if (plan.superseded > 0) {
    console.log(`\n  ${plan.superseded} record(s) appeared twice; the later copy was used.`);
  }

  if (plan.rejected.length > 0) {
    console.log(`\n  refused — ${plan.rejected.length} record(s), the donor's bytes remain:`);
    for (const r of plan.rejected.slice(0, 12)) console.log(`    ${r.label}  ${r.reason}`);
    if (plan.rejected.length > 12) console.log(`    ...and ${plan.rejected.length - 12} more`);

    // Only when a checksum is actually the reason. Printed unconditionally it told someone whose
    // DN1 sounds were merely ambiguous to go and re-read a perfectly good capture.
    if (plan.rejected.some((r) => r.reason.includes("checksum"))) {
      console.log(
        `\n  A bad checksum is corruption in transit, not a format problem. Read those objects\n` +
          `  again — on the one occasion this has happened, the second read was clean.`,
      );
    }
  }

  for (const problem of plan.problems) console.log(`\n  note: ${problem}`);
}

main();
