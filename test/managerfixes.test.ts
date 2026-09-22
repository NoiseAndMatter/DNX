/**
 * Three manager findings from the first release test run.
 *
 * The planner's wording is tested on a real version-2 project from the corpus. The rest lives in the
 * manager page, which this suite does not run, so it is checked where it is written.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseProject } from "../src/node/projectfile.js";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { deviceFor } from "@noiseandmatter/dnx-core/librarian/device.js";
import { planRename } from "@noiseandmatter/dnx-core/librarian/rename.js";
import { CORPUS } from "./corpus.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(join(ROOT, "web", "src", "manager", "main.ts"), "utf8");

function body(name: string): string {
  const start = page.indexOf(`async function ${name}(`);
  assert.ok(start > 0, `${name} has been renamed; this fence no longer guards anything`);
  const end = /\r?\n\}\r?\n/.exec(page.slice(start));
  assert.ok(end, `${name} has no closing brace at column 0`);
  return page.slice(start, start + end.index);
}

const PRESETS = CORPUS && join(CORPUS, "02_DN2", "01_Projects", "PRESETS.dn2prj");
const skip = !(PRESETS && existsSync(PRESETS)) && "needs PRESETS.dn2prj, whose patterns are all storage version 2";

test("a version-2 pattern's rename is refused as not editable, not as unreadable", { skip }, () => {
  const image = decodeProjectImage(parseProject(new Uint8Array(readFileSync(PRESETS!))).payload.raw).image;
  const plan = planRename(image, deviceFor(image), new Map([[0, "ANYTHING"]]));
  assert.equal(plan.ok, false);
  assert.match(plan.findings[0]!.message, /reads but does not edit/);
});

test("the manager refuses a rename it cannot write before asking for a name", () => {
  const run = body("runRename");
  const guard = run.indexOf("summary.supported");
  const ask = run.indexOf("askText(");
  assert.ok(guard > 0 && ask > 0 && guard < ask, "the support check must come before the name dialog");
});

test("the save picker clears its old list and respects write protection", () => {
  const targets = body("browseDriveTargets");
  assert.ok(targets.indexOf('stale.textContent = ""') < targets.indexOf("await projectSlotEntries("),
    "the old choices must be gone before the listing is read");
  assert.match(targets, /originEntry\?\.writable === false/);
});

test("a slot opened with no listed name takes the project's own name", () => {
  assert.match(body("openFromDrive"), /project\.name \|\| projectName\(opened\.image\)/);
  assert.match(body("saveToDrive"), /listed\.name = savedAs/);
});
