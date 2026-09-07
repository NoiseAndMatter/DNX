/**
 * Opening a `.dnx`, which is the half of a restore that decides whether to trust a file.
 *
 * Every test here is about a file somebody hands the application rather than one it wrote itself.
 * The writer's own output round-trips in the first test; everything after it is a file that is
 * wrong in one specific way, because those are the cases where a restore either refuses or writes
 * the wrong bytes to an instrument.
 *
 * The split under test: **refuse what would make a bad write, report what only costs one entry.**
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DNX_VERSION, packBackup, type BackupManifest, type DeviceBackup,
} from "../web/src/dnxfile.js";
import { DnxError, openBackup } from "../web/src/dnxopen.js";
import { buildZip } from "../web/src/zip.js";

const PROJECT = Uint8Array.of(1, 2, 3, 4);
const SOUND = Uint8Array.of(9, 9);

function manifest(over: Partial<BackupManifest> = {}): BackupManifest {
  return {
    dnx: DNX_VERSION,
    taken: "2026-09-07T04:21:09.000Z",
    device: { name: "Elektron Digitone II", productId: 12, firmwareVersion: "1.10E" },
    contents: ["projects", "soundbanks"],
    form: "stored",
    entries: [
      {
        file: "projects/001 PRESETS.dn2prj",
        source: "/projects/1",
        slot: 1,
        name: "PRESETS",
        bytes: PROJECT.length,
      },
      {
        file: "soundbanks/A/012 KLAP FP.dn2snd",
        source: "/soundbanks/A/12",
        slot: 12,
        name: "KLAP FP",
        bytes: SOUND.length,
      },
    ],
    ...over,
  };
}

function backup(over: Partial<BackupManifest> = {}): DeviceBackup {
  return {
    manifest: manifest(over),
    files: [
      { path: "projects/001 PRESETS.dn2prj", bytes: PROJECT },
      { path: "soundbanks/A/012 KLAP FP.dn2snd", bytes: SOUND },
    ],
  };
}

/** A zip whose files and manifest can disagree, which `packBackup` would never produce. */
async function handMade(
  m: unknown, files: readonly { path: string; bytes: Uint8Array }[],
): Promise<Uint8Array> {
  return await buildZip([
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(m)) },
    ...files.map((f) => ({ name: f.path, data: f.bytes })),
  ]);
}

test("what the backup wrote is what the reader gets back", async () => {
  const opened = await openBackup(await packBackup(backup()));

  assert.equal(opened.manifest.device.name, "Elektron Digitone II");
  assert.deepEqual(opened.damaged, []);
  assert.deepEqual(opened.unlisted, []);
  assert.equal(opened.entries.length, 2);

  const [project, sound] = opened.entries;
  assert.deepEqual([...project!.bytes], [...PROJECT], "the bytes are the ones that went in");
  assert.equal(project!.kind, "projects");
  assert.equal(project!.bank, undefined, "a project has no bank");
  assert.equal(project!.entry.source, "/projects/1", "the source is what a restore writes to");

  assert.equal(sound!.kind, "soundbanks");
  assert.equal(sound!.bank, "A", "a sound belongs to a bank, and a restore needs to know which");
});

test("an unfamiliar directory keeps its own name rather than being forced into one of three", async () => {
  /*
   * The +Drive held two directories on a Digitone 1 and three on a Digitone II, and that number
   * was wrong in this codebase's own notes for weeks. A reader that mapped anything unrecognised
   * onto `projects` would put a firmware's new directory somewhere it does not belong.
   */
  const m = manifest({
    contents: ["arrangements"],
    entries: [{
      file: "arrangements/001 SET.dn2arr",
      source: "/arrangements/1",
      slot: 1,
      name: "SET",
      bytes: 1,
    }],
  });
  const opened = await openBackup(
    await handMade(m, [{ path: "arrangements/001 SET.dn2arr", bytes: Uint8Array.of(7) }]),
  );

  assert.equal(opened.entries[0]!.kind, "arrangements");
});

test("a listed entry the zip does not hold costs that entry and nothing else", async () => {
  /*
   * **The rule this file exists for.** A backup of 1,869 items with one bad slot is worth 1,868
   * items, and a reader that threw the whole thing away over one would be the reason somebody
   * loses music.
   */
  const opened = await openBackup(await handMade(manifest(), [
    { path: "projects/001 PRESETS.dn2prj", bytes: PROJECT },
  ]));

  assert.equal(opened.entries.length, 1, "the project survives");
  assert.equal(opened.damaged.length, 1);
  assert.equal(opened.damaged[0]!.fault, "missing");
  assert.equal(opened.damaged[0]!.entry.name, "KLAP FP", "and the reader is told which one is gone");
});

test("a file that is not the length the manifest recorded is damaged, not restorable", async () => {
  /*
   * A truncated file written to a slot is a corrupt project, not a failed write — the instrument
   * accepts it and the music is gone. Length is the only check the manifest can support, so it
   * cannot prove a file is intact; it catches one that plainly is not.
   */
  const opened = await openBackup(await handMade(manifest(), [
    { path: "projects/001 PRESETS.dn2prj", bytes: Uint8Array.of(1, 2) },
    { path: "soundbanks/A/012 KLAP FP.dn2snd", bytes: SOUND },
  ]));

  assert.equal(opened.entries.length, 1, "the sound is still fine");
  assert.deepEqual(
    opened.damaged.map((d) => [d.fault, d.entry.bytes, d.found]),
    [["length", 4, 2]],
    "and the reader is told what was expected and what was there",
  );
});

test("a file nobody listed is reported rather than restored", async () => {
  /*
   * Without a manifest row there is no `source`, so nothing knows where such a file would go.
   * Somebody who added it by hand should be told it is being ignored rather than left assuming it
   * will be written.
   */
  const opened = await openBackup(await handMade(manifest(), [
    { path: "projects/001 PRESETS.dn2prj", bytes: PROJECT },
    { path: "soundbanks/A/012 KLAP FP.dn2snd", bytes: SOUND },
    { path: "notes.txt", bytes: new TextEncoder().encode("mine") },
  ]));

  assert.deepEqual(opened.unlisted, ["notes.txt"]);
  assert.equal(opened.entries.length, 2, "the backup itself is untouched by it");
});

test("a backup from a newer DNX is refused rather than guessed at", async () => {
  const packed = await packBackup(backup({ dnx: DNX_VERSION + 1 }));
  await assert.rejects(() => openBackup(packed), (error: Error) => {
    assert.ok(error instanceof DnxError);
    assert.match(error.message, new RegExp(`version ${DNX_VERSION + 1}`));
    return true;
  });
});

test("a raw-form backup is refused at the door, not at the write", async () => {
  /*
   * **Only the stored form can be written back.** A raw project is 12,889,647 bytes with no
   * container, and `refuseRawForm` rejects it at the instrument. Saying so when the file is opened
   * is the difference between a sentence and a failed restore.
   */
  const packed = await packBackup(backup({ form: "raw" as BackupManifest["form"] }));
  await assert.rejects(() => openBackup(packed), (error: Error) => {
    assert.ok(error instanceof DnxError);
    assert.match(error.message, /raw form/);
    assert.match(error.message, /restored/);
    return true;
  });
});

test("a zip with no manifest is not a backup, and the message says why that matters", async () => {
  const zip = await buildZip([{ name: "001 PRESETS.dn2prj", data: PROJECT }]);
  await assert.rejects(() => openBackup(zip), (error: Error) => {
    assert.ok(error instanceof DnxError);
    assert.match(error.message, /manifest\.json/);
    return true;
  });
});

test("something that is not a zip is refused as not a backup", async () => {
  await assert.rejects(() => openBackup(new TextEncoder().encode("not a zip at all")),
    (error: Error) => {
      assert.ok(error instanceof DnxError, "a ZipError must not reach the caller as itself");
      assert.match(error.message, /not a \.dnx/);
      return true;
    });
});

test("a manifest missing a field a restore reads names that field", async () => {
  /*
   * "Invalid manifest" tells somebody holding a file nothing they can act on. Every refusal here
   * names the field, because the person reading it is the person who has to decide whether their
   * backup is worth anything.
   */
  const cases: [string, unknown][] = [
    ["`dnx`", { ...manifest(), dnx: "1" }],
    ["`device.productId`", { ...manifest(), device: { name: "x" } }],
    ["`entries`", { ...manifest(), entries: "none" }],
    ["`slot`", {
      ...manifest(),
      entries: [{ file: "a", source: "/projects/1", name: "A", bytes: 1 }],
    }],
  ];

  for (const [field, broken] of cases) {
    const zip = await handMade(broken, []);
    await assert.rejects(() => openBackup(zip), (error: Error) => {
      assert.ok(error instanceof DnxError);
      assert.ok(error.message.includes(field), `expected ${field} in: ${error.message}`);
      return true;
    });
  }
});
