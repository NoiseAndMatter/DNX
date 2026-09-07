/**
 * What a reader is told about a backup they just opened.
 *
 * `dnxopen.ts` decides whether a file can be trusted; this decides what to say about it. The tests
 * that matter here are the ones about **damage being spoken rather than counted** — a backup
 * reports its own faults precisely so somebody can be told, and a number on its own is not being
 * told.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DNX_VERSION, type BackupEntry, type BackupManifest } from "../web/src/dnxfile.js";
import type { OpenedBackup, OpenedEntry } from "../web/src/dnxopen.js";
import { summariseBackup } from "../web/src/backupsummary.js";

function entry(over: Partial<BackupEntry> = {}): BackupEntry {
  return {
    file: "projects/001 PRESETS.dn2prj",
    source: "/projects/1",
    slot: 1,
    name: "PRESETS",
    bytes: 4,
    ...over,
  };
}

function opened(over: Partial<OpenedBackup> = {}): OpenedBackup {
  const manifest: BackupManifest = {
    dnx: DNX_VERSION,
    taken: "2026-09-07T04:21:09.000Z",
    device: { name: "Digitone II", productId: 12, firmwareVersion: "1.10E" },
    contents: ["projects"],
    form: "stored",
    entries: [],
  };
  return { manifest, entries: [], damaged: [], unlisted: [], ...over };
}

function project(slot: number, name: string): OpenedEntry {
  return {
    entry: entry({ slot, name, source: `/projects/${slot}` }),
    bytes: Uint8Array.of(1),
    kind: "projects",
  };
}

function sound(bank: string, slot: number): OpenedEntry {
  return {
    entry: entry({ slot, name: `S${slot}`, source: `/soundbanks/${bank}/${slot}` }),
    bytes: Uint8Array.of(1),
    kind: "soundbanks",
    bank,
  };
}

test("a kind the caller cannot act on is counted and named, never listed", () => {
  /*
   * **1,835 rows to choose one project is a thousand rows nobody asked for.** Counting them is
   * still necessary: a reader deciding whether this is the right backup needs to see the sounds
   * are in it.
   */
  const summary = summariseBackup(opened({
    entries: [
      project(1, "PRESETS"),
      ...["A", "B", "C"].flatMap((bank) => [sound(bank, 1), sound(bank, 2)]),
    ],
  }), ["projects"]);

  const [projects, sounds] = summary.groups;
  assert.equal(projects!.label, "Projects");
  assert.equal(projects!.entries.length, 1, "the actionable kind carries its entries");

  assert.equal(sounds!.label, "Sounds");
  assert.equal(sounds!.count, 6, "the rest are counted");
  assert.deepEqual(sounds!.entries, [], "and not carried");
  assert.deepEqual(sounds!.banks, ["A", "B", "C"], "the banks they are in are worth knowing");
});

test("a directory this application has never heard of is shown under its own name", () => {
  const summary = summariseBackup(opened({
    entries: [{
      entry: entry({ source: "/arrangements/1", name: "SET" }),
      bytes: Uint8Array.of(1),
      kind: "arrangements",
    }],
  }));

  assert.equal(summary.groups[0]!.label, "Arrangements");
  assert.equal(summary.groups[0]!.count, 1);
});

test("the time is the manifest's own, in UTC, because a shifted clock invents a second backup", () => {
  /*
   * The manifest stores UTC. A backup taken at 04:21 displayed as 05:21 invites somebody to
   * conclude they have two backups, or that they took one they do not remember taking.
   */
  assert.equal(summariseBackup(opened()).taken, "2026-09-07 04:21 UTC");
});

test("a device that never answered its firmware is not given one", () => {
  const withFirmware = summariseBackup(opened());
  assert.equal(withFirmware.device, "Digitone II · firmware 1.10E");

  const without = summariseBackup(opened({
    manifest: { ...opened().manifest, device: { name: "Digitone", productId: 13 } },
  }));
  assert.equal(without.device, "Digitone", "absent means absent, here as everywhere else");
});

test("a missing entry is named, and the reader is told the rest survived", () => {
  const summary = summariseBackup(opened({
    entries: [project(1, "PRESETS")],
    damaged: [{ entry: entry({ slot: 2, name: "COREVAULT" }), fault: "missing" }],
  }), ["projects"]);

  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0]!, /COREVAULT/, "which slot was lost");
  assert.match(summary.warnings[0]!, /Everything else here is intact/, "and that the rest is fine");
});

test("a wrong-length file says what cannot be restored, separately from what is missing", () => {
  const summary = summariseBackup(opened({
    damaged: [
      { entry: entry({ name: "GONE" }), fault: "missing" },
      { entry: entry({ name: "SHORT" }), fault: "length", found: 2 },
    ],
  }));

  assert.equal(summary.warnings.length, 2, "two different faults are two different sentences");
  assert.match(summary.warnings.join(" "), /GONE/);
  assert.match(summary.warnings.join(" "), /SHORT/);
  assert.match(summary.warnings[1]!, /cannot be restored/);
});

test("many damaged entries give a number rather than a wall of names", () => {
  /*
   * Somebody with three bad slots wants to know which three. Somebody with three hundred wants the
   * number and a reason to stop reading.
   */
  const damaged = Array.from({ length: 12 }, (_, i) => ({
    entry: entry({ slot: i + 1, name: `P${i + 1}` }), fault: "missing" as const,
  }));
  const summary = summariseBackup(opened({ damaged }));

  assert.match(summary.warnings[0]!, /and 9 more/);
  assert.doesNotMatch(summary.warnings[0]!, /P12/, "the twelfth name is not in the sentence");
});

test("a file nobody listed is called out as ignored, not as an error", () => {
  const summary = summariseBackup(opened({ unlisted: ["notes.txt"] }));

  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0]!, /1 file/);
  assert.match(summary.warnings[0]!, /ignored/);
});

test("a clean backup says nothing, because a warning nobody needs is noise", () => {
  const summary = summariseBackup(opened({ entries: [project(1, "PRESETS")] }), ["projects"]);
  assert.deepEqual(summary.warnings, []);
  assert.equal(summary.empty, false);
});

test("a backup holding nothing the caller can act on says so", () => {
  /*
   * A sounds-only backup opened by something that can only place projects is not an error and is
   * not usable either. Saying "nothing here you can open yet" is the difference between a working
   * feature and a dialog that appears to have failed.
   */
  const summary = summariseBackup(opened({ entries: [sound("A", 1)] }), ["projects"]);
  assert.equal(summary.empty, true);
  assert.equal(summary.groups[0]!.count, 1, "while still saying what is in there");
});
