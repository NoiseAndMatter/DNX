/**
 * The outline of the sample store, and a drop of files and folders.
 *
 * The expected rows are written by hand from the listing below. No code under test made them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planImport } from "@noiseandmatter/dnx-core/sample/importplan.js";
import { storeOutline, storeSearch } from "@noiseandmatter/dnx-core/sample/storeoutline.js";
import { type DropEntry, readDropped } from "../web/src/library/droppedfiles.js";

const ZERO = "0".repeat(64);
const SHA = "ab".repeat(32);
const ENTRIES = [
  { path: "samples/top", size: 100, sha256: SHA },
  { path: "samples/drums/kicks/kick_b", size: 200, sha256: SHA },
  { path: "samples/drums/kicks/kick_a", size: 300, sha256: SHA },
  { path: "samples/drums/snare", size: 400, sha256: SHA },
  { path: "samples/empty", size: 0, sha256: ZERO },
  { path: "samples/drums", size: 0, sha256: ZERO },
  { path: "other/ignored", size: 1, sha256: SHA },
];
const shape = (rows: ReturnType<typeof storeOutline>): string[] =>
  rows.map((row) => `${"  ".repeat(row.depth)}${row.kind === "folder" ? `${row.name}/ ${row.files}` : row.name}`);

test("a closed store shows its top folders, then its top samples", () => {
  assert.deepEqual(shape(storeOutline(ENTRIES, new Set())), ["drums/ 3", "empty/ 0", "top"]);
});

test("an open folder shows its folders, then its samples, sorted, at the next depth", () => {
  assert.deepEqual(shape(storeOutline(ENTRIES, new Set(["drums", "drums/kicks"]))), [
    "drums/ 3",
    "  kicks/ 2",
    "    kick_a",
    "    kick_b",
    "  snare",
    "empty/ 0",
    "top",
  ]);
});

test("a row knows its paths, and a folder knows whether it has an entry of its own", () => {
  const rows = storeOutline(ENTRIES, new Set(["drums"]));
  const kicks = rows.find((row) => row.name === "kicks")!;
  assert.equal(kicks.path, "samples/drums/kicks");
  assert.equal(kicks.kind === "folder" && kicks.entry, false);
  const drums = rows.find((row) => row.name === "drums")!;
  assert.equal(drums.kind === "folder" && drums.entry, true);
  assert.equal(drums.kind === "folder" && drums.folders, 1);
  const snare = rows.find((row) => row.name === "snare")!;
  assert.equal(snare.path, "samples/drums/snare");
  assert.equal(snare.folder, "drums");
  const top = rows.find((row) => row.name === "top")!;
  assert.equal(top.path, "samples/top");
  assert.equal(top.folder, "");
});

test("a search finds samples and folders anywhere, in any case, and names them by path", () => {
  assert.deepEqual(storeSearch(ENTRIES, "KICK").map((row) => row.name), [
    "drums/kicks",
    "drums/kicks/kick_a",
    "drums/kicks/kick_b",
  ]);
  assert.deepEqual(storeSearch(ENTRIES, "   "), []);
  assert.deepEqual(storeSearch(ENTRIES, "nothing"), []);
});

const stored = (name: string, folder: string) => ({ name, stored: new Uint8Array(10), folder });

test("a file is refused when a folder on its path has a bad name", () => {
  const plan = planImport([], [stored("a", "ok/café"), stored("b", "ok/fine")], 1e9);
  assert.match(plan.files[0]!.problem!, /café.*ASCII/);
  assert.equal(plan.files[1]!.problem, undefined);
  assert.equal(plan.files[1]!.path, "samples/ok/fine/b");
});

const fileEntry = (name: string): DropEntry => ({
  name,
  isFile: true,
  isDirectory: false,
  file: (done) => done(new File([], name)),
});
/** A folder whose reader gives two batches and then an empty one, as a browser's does. */
const dirEntry = (name: string, children: DropEntry[]): DropEntry => ({
  name,
  isFile: false,
  isDirectory: true,
  createReader() {
    const batches = [children.slice(0, 1), children.slice(1), []];
    return { readEntries: (done) => done(batches.shift() ?? []) };
  },
});

test("a drop keeps its folders, takes WAV files in any case, and counts what it skips", async () => {
  const dropped = await readDropped([
    fileEntry("loose.WAV"),
    fileEntry("notes.txt"),
    dirEntry("kit", [fileEntry("a.wav"), dirEntry("hats", [fileEntry("b.wav"), fileEntry(".DS_Store")])]),
  ]);
  assert.deepEqual(dropped.wavs.map((w) => [w.folder, w.file.name]), [
    ["", "loose.WAV"],
    ["kit", "a.wav"],
    ["kit/hats", "b.wav"],
  ]);
  assert.equal(dropped.skipped, 2);
});
