/**
 * One folder of digikit's sample store, out of a LIST.
 *
 * The entries are written by hand in the form LIST gives them (path, size, sha256), with folder
 * entries as digikit marks them: size 0 and a zero hash.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SAMPLE_PATH_MAX,
  folderNameProblem,
  folderPath,
  listFolder,
  verifyTimeoutMs,
} from "@noiseandmatter/dnx-core/sample/storelisting.js";

const ZERO = "0".repeat(64);
const file = (path: string, size: number, sha = "ab".repeat(32)) => ({ path, size, sha256: sha });
const dir = (path: string) => ({ path, size: 0, sha256: ZERO });

const ENTRIES = [
  file("modules/a.dkm", 6),
  dir("samples/empty"),
  file("samples/drums/kick", 96_080),
  file("samples/drums/909/snare", 76_880),
  dir("samples/drums"),
  file("samples/Pad", 288_080),
  file("samples/bass", 50_000),
];

test("the top holds its own files and folders, sorted in byte order", () => {
  const top = listFolder(ENTRIES, "");
  assert.deepEqual(top.folders.map((f) => [f.name, f.entry, f.files]), [
    ["drums", true, 2],
    ["empty", true, 0],
  ]);
  assert.deepEqual(top.files.map((f) => [f.name, f.size]), [["Pad", 288_080], ["bass", 50_000]]);
  assert.equal(top.files[0]!.path, "samples/Pad");
});

test("a folder that only a path runs through is listed, and cannot be deleted on its own", () => {
  const drums = listFolder(ENTRIES, "/drums/");
  assert.equal(drums.folder, "drums");
  assert.deepEqual(drums.folders, [{ name: "909", path: "samples/drums/909", entry: false, files: 1 }]);
  assert.deepEqual(drums.files.map((f) => f.path), ["samples/drums/kick"]);
});

test("entries outside samples/ are not samples", () => {
  const top = listFolder(ENTRIES, "");
  assert.ok(![...top.folders, ...top.files].some((e) => e.path.startsWith("modules/")));
  assert.equal(folderPath(""), "samples");
  assert.equal(folderPath("a/b/"), "samples/a/b");
});

test("a folder name is one printable part that leaves room for a file", () => {
  assert.equal(folderNameProblem("", "Kicks 01"), undefined);
  assert.match(folderNameProblem("", "")!, /Type a name/);
  assert.match(folderNameProblem("", "a/b")!, /slash/);
  assert.match(folderNameProblem("", "..")!, /\.\./);
  assert.match(folderNameProblem("", " pad")!, /space/);
  assert.match(folderNameProblem("", "café")!, /ASCII/);
  const long = "x".repeat(SAMPLE_PATH_MAX - 2);
  assert.equal(folderNameProblem("", long), undefined);
  assert.match(folderNameProblem("", `${long}x`)!, /too long/);
  assert.match(folderNameProblem("drums", long)!, /too long/);
});

test("a VERIFY of a big file gets longer than the session's 6 s", () => {
  assert.equal(verifyTimeoutMs(0), 6_000);
  assert.equal(verifyTimeoutMs(7_680_080), 6_000 + 15_361);
});
