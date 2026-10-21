/**
 * The sample library's bookkeeping: objects, the catalog, and project uses.
 *
 * The rule every test leans on: **a move or a rename edits the catalog only.** So each one checks
 * that the objects and the uses are unchanged afterwards, not only that the name moved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { folderPath, SampleLibrary, type SampleObject } from "@noiseandmatter/dnx-core/sample/library.js";
import { sampleKey } from "@noiseandmatter/dnx-core/sample/identity.js";
import { SampleError } from "@noiseandmatter/dnx-core/sample/errors.js";

function object(hash: string, frames: number, channels: 1 | 2 = 1): SampleObject {
  return { id: { hash: hash.padStart(16, "0"), size: frames * channels * 2 }, channels, frames };
}

const KICK = object("a1", 1000);
const PAD = object("b2", 4000, 2);

function library(): { lib: SampleLibrary; kick: string; pad: string } {
  const lib = new SampleLibrary();
  const kick = lib.addObject(KICK).key;
  const pad = lib.addObject(PAD).key;
  lib.addFolder("/drums/kicks");
  lib.addFolder("/pads");
  return { lib, kick, pad };
}

test("folder paths are normalised, and a path with an empty name is refused", () => {
  assert.equal(folderPath("/"), "/");
  assert.equal(folderPath("/ drums / kicks "), "/drums/kicks");
  assert.throws(() => folderPath("drums"), SampleError);
  assert.throws(() => folderPath("/drums//kicks"), SampleError);
  assert.throws(() => folderPath("/drums/"), SampleError);
});

test("the same object twice is one object, and a hash clash with other contents is refused", () => {
  const { lib, kick } = library();
  assert.deepEqual(lib.addObject(KICK), { key: kick, added: false });
  assert.equal(lib.allObjects().length, 2);
  assert.throws(() => lib.addObject({ ...KICK, channels: 2, frames: 500 }), /different channels or length/);
  assert.throws(() => lib.addObject({ ...object("c3", 10), frames: 11 }), /is not 20 bytes/);
});

test("addFolder creates the parents too", () => {
  const { lib } = library();
  assert.deepEqual(lib.allFolders(), ["/", "/drums", "/drums/kicks", "/pads"]);
});

test("an entry needs its folder and its object, and a free name", () => {
  const { lib, kick } = library();
  lib.addEntry("/drums/kicks", "Kick 1", kick);
  assert.throws(() => lib.addEntry("/drums/kicks", "Kick 1", kick), /already exists/);
  assert.throws(() => lib.addEntry("/nowhere", "Kick", kick), /does not exist/);
  assert.throws(() => lib.addEntry("/", "Kick", "00000000000000ff:2"), /not in the library/);
  assert.throws(() => lib.addEntry("/", "a/b", kick), /separates folders/);
  // The same object under a second name is fine: names are catalog, not identity.
  lib.addEntry("/", "Kick 1", kick);
  assert.equal(lib.entriesFor(kick).length, 2);
});

test("moving and renaming an entry keep its id, its object and every project use", () => {
  const { lib, kick } = library();
  const entry = lib.addEntry("/drums/kicks", "Kick 1", kick);
  lib.setProjectSamples("song-a", [kick]);
  const before = JSON.stringify({ objects: lib.allObjects(), uses: lib.usersOf(kick) });

  const moved = lib.moveEntry(entry.entryId, "/pads", "Big Kick");
  assert.deepEqual(moved, { entryId: entry.entryId, folder: "/pads", name: "Big Kick", sample: kick });
  lib.renameEntry(entry.entryId, "Bigger Kick");
  assert.equal(lib.entry(entry.entryId)?.name, "Bigger Kick");
  assert.deepEqual(lib.entriesIn("/drums/kicks"), []);

  assert.equal(JSON.stringify({ objects: lib.allObjects(), uses: lib.usersOf(kick) }), before);
});

test("a move onto a taken name is refused and changes nothing", () => {
  const { lib, kick, pad } = library();
  const a = lib.addEntry("/pads", "Same", pad);
  const b = lib.addEntry("/drums/kicks", "Same", kick);
  assert.throws(() => lib.moveEntry(b.entryId, "/pads"), /already exists/);
  assert.equal(lib.entry(b.entryId)?.folder, "/drums/kicks");
  // Renaming to its own name is not a clash.
  assert.equal(lib.renameEntry(a.entryId, "Same").name, "Same");
});

test("moving a folder moves everything inside it, catalog only", () => {
  const { lib, kick } = library();
  const entry = lib.addEntry("/drums/kicks", "Kick 1", kick);
  lib.setProjectSamples("song-a", [kick]);
  lib.moveFolder("/drums", "/library/old drums");
  assert.deepEqual(lib.allFolders(), ["/", "/library", "/library/old drums", "/library/old drums/kicks", "/pads"]);
  assert.equal(lib.entry(entry.entryId)?.folder, "/library/old drums/kicks");
  assert.deepEqual(lib.usersOf(kick), ["song-a"]);
  assert.throws(() => lib.moveFolder("/library", "/library/inner"), /into itself/);
  assert.throws(() => lib.moveFolder("/pads", "/library"), /already exists/);
  assert.throws(() => lib.moveFolder("/", "/x"), SampleError);
});

test("only an empty folder can be removed", () => {
  const { lib, kick } = library();
  assert.throws(() => lib.removeFolder("/drums"), /has folders in it/);
  const entry = lib.addEntry("/drums/kicks", "Kick", kick);
  assert.throws(() => lib.removeFolder("/drums/kicks"), /has samples in it/);
  lib.removeEntry(entry.entryId);
  lib.removeFolder("/drums/kicks");
  lib.removeFolder("/drums");
  assert.throws(() => lib.removeFolder("/"), SampleError);
});

test("deleting an object a project uses is refused with the projects named, unless forced", () => {
  const { lib, kick } = library();
  lib.addEntry("/drums/kicks", "Kick", kick);
  lib.setProjectSamples("song-b", [kick]);
  lib.setProjectSamples("song-a", [kick]);
  assert.throws(() => lib.deleteObject(kick), /used by 2 projects: song-a, song-b/);
  assert.ok(lib.object(kick));

  assert.deepEqual(lib.deleteObject(kick, { force: true }), { removedEntries: 1, brokenProjects: ["song-a", "song-b"] });
  assert.equal(lib.object(kick), undefined);
  assert.deepEqual(lib.entriesIn("/drums/kicks"), []);
});

test("project uses replace per project, refuse unknown objects, and can be forgotten", () => {
  const { lib, kick, pad } = library();
  lib.setProjectSamples("song-a", [kick, pad]);
  lib.setProjectSamples("song-a", [pad]);
  assert.deepEqual(lib.samplesOf("song-a"), [pad]);
  assert.deepEqual(lib.usersOf(kick), []);
  assert.throws(() => lib.setProjectSamples("song-a", ["00000000000000ff:2"]), /not in the library/);
  assert.deepEqual(lib.samplesOf("song-a"), [pad], "a refused update changes nothing");
  lib.forgetProject("song-a");
  assert.deepEqual(lib.usersOf(pad), []);
});

test("an object with no name and no use is an orphan", () => {
  const { lib, kick, pad } = library();
  lib.addEntry("/", "Kick", kick);
  assert.deepEqual(lib.orphans(), [pad]);
  lib.setProjectSamples("song", [pad]);
  assert.deepEqual(lib.orphans(), []);
});

test("the library round-trips through JSON, and a damaged file is refused", () => {
  const { lib, kick, pad } = library();
  const e = lib.addEntry("/drums/kicks", "Kick", kick);
  lib.addEntry("/pads", "Pad", pad);
  lib.setProjectSamples("song-a", [kick, pad]);
  lib.setProjectSamples("song-b", [pad]);

  const json = JSON.parse(JSON.stringify(lib.toJSON()));
  const back = SampleLibrary.fromJSON(json);
  assert.deepEqual(back.toJSON(), lib.toJSON());
  assert.equal(back.addEntry("/", "Next", kick).entryId, "e3", "entry ids continue, never reused");
  assert.equal(back.entry(e.entryId)?.name, "Kick");

  assert.throws(() => SampleLibrary.fromJSON({ ...json, kind: "other" }), SampleError);
  assert.throws(() => SampleLibrary.fromJSON({ ...json, version: 2 }), /version 2/);
  const missing = { ...json, entries: [{ ...json.entries[0], sample: sampleKey({ hash: "f".repeat(16), size: 2 }) }] };
  assert.throws(() => SampleLibrary.fromJSON(missing), /not listed/);
  const clash = { ...json, entries: [json.entries[0], { ...json.entries[0], entryId: "e9" }] };
  assert.throws(() => SampleLibrary.fromJSON(clash), /already exists/);
});
