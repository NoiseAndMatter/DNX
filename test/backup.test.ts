/**
 * The `.dnx` format, and the decisions inside it that a later restore depends on.
 *
 * `backupDevice` needs an instrument, so it is not exercised here. What is exercised is everything
 * a restore will read: the manifest, the naming, and the zip a `.dnx` actually is.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DNX_VERSION, backupFileName, packBackup, type BackupManifest,
} from "../web/src/dnxfile.js";
import { readZip } from "../web/src/zip.js";
import { projectExtensionFor, projectFile } from "../web/src/dnxfile.js";
import { parseProject } from "../src/node/projectfile.js";
import { DN1_PROJECTS, DN2_PROJECTS, NO_CORPUS, requireCorpusFile } from "./corpus.js";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function manifest(over: Partial<BackupManifest> = {}): BackupManifest {
  return {
    dnx: DNX_VERSION,
    taken: "2026-09-07T04:21:09.000Z",
    device: { name: "Elektron Digitone II", productId: 12, firmwareVersion: "1.10E" },
    contents: ["projects"],
    form: "stored",
    entries: [
      { file: "projects/001 PRESETS.dn2prj", source: "/projects/1", slot: 1, name: "PRESETS", bytes: 3 },
    ],
    ...over,
  };
}

test("a .dnx is a zip, and the manifest is the first thing in it", async () => {
  /*
   * **Rename it and it opens anywhere.** A backup format only its author can read is a way of
   * losing music slowly. The manifest leads so a reader meets the description before the data.
   */
  const packed = await packBackup({
    manifest: manifest(),
    files: [{ path: "projects/001 PRESETS.dn2prj", bytes: Uint8Array.of(1, 2, 3) }],
  });

  assert.deepEqual([...packed.subarray(0, 2)], [0x50, 0x4b], "a zip starts PK");

  const read = await readZip(packed);
  assert.deepEqual([...read.keys()], ["manifest.json", "projects/001 PRESETS.dn2prj"]);
  assert.deepEqual([...read.get("projects/001 PRESETS.dn2prj")!], [1, 2, 3]);

  const back = JSON.parse(new TextDecoder().decode(read.get("manifest.json")!)) as BackupManifest;
  assert.equal(back.dnx, DNX_VERSION);
  assert.equal(back.entries[0]!.slot, 1, "the slot is what a restore writes back to");
  assert.equal(back.entries[0]!.source, "/projects/1");
});

test("the manifest records the form, because a raw backup cannot be restored", () => {
  /*
   * The device answers one path two ways, and **only the stored form can be written back**;
   * `refuseRawForm` rejects the other at the write. A backup taken raw is unrestorable, and that
   * has happened on hardware: 2026-08-15, a slot backed up as 12.9 MB of raw image, saved under a
   * `.dn2prj` name it had no right to, rejected by the very function that produced it.
   *
   * Recorded in the manifest so a restore can refuse early and say why, rather than failing at the
   * last step of a long operation.
   */
  assert.equal(manifest().form, "stored");

  const source = readFileSync(join(ROOT, "src", "device", "backup.ts"), "utf8");
  assert.match(source, /form:\s*STORED_FORM/,
    "every read must ask for the stored form; a raw one produces a backup nobody can restore");
  assert.doesNotMatch(source.slice(source.indexOf("backupDevice")), /form:\s*undefined/);
});

test("firmware is absent rather than invented when the instrument did not answer", () => {
  // A manifest claiming a firmware nobody read is the plausible-looking wrong field this codebase
  // keeps paying for. A restore checking for a mismatch has to tell "different" from "unknown".
  const unknown = manifest({ device: { name: "Elektron Digitone II", productId: 12 } });
  assert.equal("firmwareVersion" in unknown.device, false);
  assert.equal(JSON.stringify(unknown).includes("firmwareVersion"), false);
});

test("a file name leads with the slot, and survives a file system", async () => {
  /*
   * Two projects on one +Drive may share a name; two cannot share a slot. The slot is also what
   * `/projects/<index>` addresses, so it is the identifying part rather than decoration.
   */
  const packed = await packBackup({
    manifest: manifest(),
    files: [
      { path: "projects/003 GUACAMOLE FM.dn2prj", bytes: Uint8Array.of(0) },
      { path: "projects/017 PRESETS.dn2prj", bytes: Uint8Array.of(0) },
    ],
  });
  const names = [...(await readZip(packed)).keys()];
  assert.ok(names.every((n) => !/[\\:*?"<>|]/.test(n.replace(/\//g, ""))),
    "no name may carry a character a file system refuses");
  assert.deepEqual(names.slice(1).map((n) => n.slice(9, 12)), ["003", "017"]);
});

test("the backup names itself after the instrument and the moment", () => {
  const name = backupFileName(manifest());
  assert.match(name, /\.dnx$/);
  assert.ok(name.startsWith("Elektron Digitone II "), name);
  // Sorts by date in a folder listing, which is the whole reason the stamp is not local-format.
  assert.match(name, /2026-09-07-04-21-09/);
  assert.doesNotMatch(name, /[\\/:*?"<>|]/);
});

test("empty slots are skipped, which is what makes this minutes rather than an hour", () => {
  /*
   * A +Drive has 128 project slots and the instrument this was built against uses 18. The filter is
   * on the name, because that is what a listing gives for an unoccupied slot.
   */
  const source = readFileSync(join(ROOT, "src", "device", "backup.ts"), "utf8");
  assert.match(source, /listed\.filter\(\(p\) => p\.name\.trim\(\)\.length > 0\)/);
});

test("an item that fails is reported, not dropped", () => {
  /*
   * A backup missing one project is worth having. One that quietly lost it is not, and nothing
   * downstream can tell those apart unless the reader says which happened.
   *
   * **This test named a loop variable and broke on a rename while the behaviour held.** It now
   * asserts the shape it cares about: a catch that records rather than swallows, and a caller that
   * receives the record. `backupDevice` needs an instrument, so the property is read out of the
   * source; naming as little of that source as possible is what keeps it about the behaviour.
   */
  const source = readFileSync(join(ROOT, "src", "device", "backup.ts"), "utf8");
  assert.match(source, /catch \(error\) \{\s*failed\.push\(/,
    "a failed read must be recorded in the catch, never swallowed");
  assert.match(source, /^\s*failed,\s*$/m, "and handed back to the caller");
  assert.doesNotMatch(source, /catch \{\s*\}/, "an empty catch would lose an item silently");
});

test("a project inside a .dnx parses as a real project file", { skip: NO_CORPUS }, async () => {
  /*
   * **The test that was missing, and the bug it would have caught.**
   *
   * The first backup taken off hardware produced a structurally perfect `.dnx`: 19 files, 18
   * manifest entries, every size agreeing. **Not one of the eighteen projects parsed.** The +Drive
   * sends a *payload*; a `.dn2prj` is that payload inside a container with its own manifest, and
   * the payload had been saved under a name it had no right to.
   *
   * Every assertion up to that point passed, because they all checked the zip and none of them
   * opened what was in it. `safewrite.ts` records the same mistake from 2026-08-15 in the other
   * direction.
   */
  const payload = readFileSync(requireCorpusFile(DN2_PROJECTS, "MORNING_JAM.dn2prj"));
  const source = parseProject(new Uint8Array(payload));

  const wrapped = await projectFile("MORNING_JAM", "1.10E", source.payload.raw);
  const reparsed = parseProject(wrapped);

  assert.equal(reparsed.manifest.FileType, "Project");
  assert.equal(reparsed.manifest.FirmwareVersion, "1.10E");
  assert.equal(reparsed.manifest.Payload, "MORNING_JAM");
  assert.deepEqual(reparsed.manifest.ProductType, []);
  assert.deepEqual([...reparsed.payload.raw], [...source.payload.raw],
    "the payload must survive the wrap byte for byte");
});

test("no manifest field is invented", () => {
  /*
   * `FormatVersion`, `ProductType` and `FileType` are constants, and they are constants because all
   * 26 DN2 projects in the corpus agree. The other two come off the instrument. A manifest carrying
   * a value nobody read is the plausible-looking wrong field this project keeps paying for, so
   * `projectFile` takes the firmware rather than defaulting it.
   */
  const source = readFileSync(join(WEB, "src", "dnxfile.ts"), "utf8");
  const fn = source.slice(source.indexOf("export function projectFile"));
  assert.match(fn, /firmwareVersion: string/, "firmware must be supplied, never defaulted");
  assert.doesNotMatch(fn, /FirmwareVersion:\s*"/, "a literal firmware would be a guess");

  // And the caller must have somewhere to go when the instrument did not answer.
  const backup = readFileSync(join(ROOT, "src", "device", "backup.ts"), "utf8");
  assert.match(backup, /\.payload/,
    "with no firmware there is nothing honest to wrap with, so the bare payload is kept");
});

test("a Digitone 1 project is wrapped as a Digitone 1 file", { skip: NO_CORPUS }, async () => {
  /*
   * **Found on hardware, 2026-09-15.** The copy the manager takes before saving over a Digitone 1
   * project came out as `RELTEST PRESETS-before-….dn2prj` with `ProductType: []`: the wrap assumed a
   * Digitone II. The same `projectFile` wraps every project in a backup, so a Digitone 1 backup's
   * projects carried the Digitone II manifest too.
   */
  const dn1 = parseProject(new Uint8Array(readFileSync(requireCorpusFile(DN1_PROJECTS, "002 MORNING_JAM.dnprj"))));
  const wrapped = parseProject(await projectFile("MORNING_JAM", "1.42A", dn1.payload.raw));
  assert.deepEqual(wrapped.manifest.ProductType, ["24", "30"]);
  assert.equal(projectExtensionFor(dn1.payload.raw), ".dnprj");

  const dn2 = parseProject(new Uint8Array(readFileSync(requireCorpusFile(DN2_PROJECTS, "MORNING_JAM.dn2prj"))));
  assert.equal(projectExtensionFor(dn2.payload.raw), ".dn2prj");
});

test("the copy taken before a write is not named for one family", () => {
  const source = readFileSync(join(WEB, "src", "safewriteui.ts"), "utf8");
  assert.doesNotMatch(source, /replace\(\/\\\.payload\$\/, "\.dn2prj"\)/,
    "the extension must come from the payload, not a literal");
  assert.match(source, /projectExtensionFor\(backup\.bytes\)/);
});

test("a +Drive directory DNX cannot read is named, not passed over", () => {
  /*
   * **The gap this closes.** `driveKinds` asks the instrument what is on its drive rather than
   * deciding from the product id, which is right — it is what stopped a Digitone 1 backup dying
   * on `/kits`. But the reader handles three names, so a firmware adding a fourth would have been
   * discovered and then quietly skipped: the run would finish, report success, and be missing
   * something nobody could name until they tried to restore.
   *
   * The source is checked rather than a run mocked, because the failure being guarded against is
   * an omission, and a mock that does not know about the fourth directory cannot demonstrate one.
   */
  const source = readFileSync(join(ROOT, "src/device/backup.ts"), "utf8");
  assert.match(source, /const HANDLED = new Set\(\[/, "the handled set is explicit");
  assert.match(source, /!HANDLED\.has\(name\)/, "and everything else is collected as skipped");
  assert.match(source, /skipped: rest\.skipped/, "and reaches the manifest");

  const manifest = readFileSync(join(ROOT, "src/project/dnxfile.ts"), "utf8");
  assert.match(manifest, /skipped\?: string\[\]/, "optional, because older files predate it");

  const ui = readFileSync(join(ROOT, "web/src/manager/main.ts"), "utf8");
  assert.match(ui, /manifest\.skipped/, "and the page says so rather than leaving it to the file");
  assert.match(ui, /cannot read/, "in words, not a field name");
});

test("the README does not claim the whole instrument is backed up", () => {
  /*
   * It copies the +Drive. The instrument's global settings — MIDI configuration, sync, audio
   * routing, brightness — live in the machine, and **two independent routes both fail to reach
   * them**: the +Drive root holds only projects, soundbanks and kits, and Elektron's SysEx SEND
   * menu offers only PROJECT, PATTERN and PRESETS. A backup tool quiet about that is making a
   * promise it cannot keep, and the person finds out when they restore onto a replacement unit.
   */
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.doesNotMatch(readme, /Back the whole instrument up/);
  assert.match(readme, /It copies the \*\*\+Drive\*\*, not the instrument/);
  assert.match(readme, /no tool can put them there/,
    "and says the limit is the instrument's, not DNX's");
});
