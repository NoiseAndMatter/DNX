/**
 * An import into digikit's sample store: the plan made before anything is sent, and the audio a
 * preview reads from a converted file.
 *
 * The converted files come from digikit's own converter (`web/vendor/dksample.wasm`), not from DNX,
 * so `readNative` is checked against a file it did not write.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fitProblem, planImport } from "@noiseandmatter/dnx-core/sample/importplan.js";
import { readNative } from "@noiseandmatter/dnx-core/sample/nativepcm.js";
import { loadConverter, prepareWav } from "@noiseandmatter/dnx-core/sample/digikitstore.js";
import { SAMPLE_PATH_MAX, sampleNameProblem } from "@noiseandmatter/dnx-core/sample/storelisting.js";

const ZERO = "0".repeat(64);
const SHA = "ab".repeat(32);
const ENTRIES = [
  { path: "samples/drums", size: 0, sha256: ZERO },
  { path: "samples/drums/kick", size: 96_080, sha256: SHA },
  { path: "samples/pads/warm", size: 50_000, sha256: SHA },
];
const file = (name: string, size: number, folder = "") => ({ name, stored: new Uint8Array(size), folder });

test("each file goes to its own folder, and one with a listed path replaces it", () => {
  const plan = planImport(ENTRIES, [file("kick", 1000, "drums"), file("snare", 2000, "drums")], 10_000);
  assert.deepEqual(plan.files.map((f) => [f.path, f.size, f.replaces, f.problem]), [
    ["samples/drums/kick", 1000, true, undefined],
    ["samples/drums/snare", 2000, false, undefined],
  ]);
  assert.equal(plan.sent, 2);
  assert.equal(plan.bytes, 3000);
  assert.equal(plan.problem, undefined);
});

test("one batch can fill several folders, and a name is taken only within its folder", () => {
  const plan = planImport(ENTRIES, [file("hit", 10, "drums"), file("hit", 10, "pads"), file("hit", 10, "drums")], 1e9);
  assert.deepEqual(plan.files.map((f) => f.path), ["samples/drums/hit", "samples/pads/hit", "samples/drums/hit"]);
  assert.equal(plan.files[0]!.problem, undefined);
  assert.equal(plan.files[1]!.problem, undefined);
  assert.match(plan.files[2]!.problem!, /also called hit/);
  assert.equal(plan.sent, 2);
});

test("a file is refused for its name, a second file of that name, or a folder in its way", () => {
  const plan = planImport(ENTRIES, [file("café", 10), file("drums", 10), file("pads", 10), file("a", 10), file("a", 10)], 1e9);
  assert.match(plan.files[0]!.problem!, /ASCII/);
  assert.match(plan.files[1]!.problem!, /is a folder here/);
  assert.match(plan.files[2]!.problem!, /is a folder here/);
  assert.equal(plan.files[3]!.problem, undefined);
  assert.match(plan.files[4]!.problem!, /also called a/);
  assert.equal(plan.sent, 1);
  assert.equal(plan.bytes, 10);
});

test("a batch larger than the free space is not sent, and a batch with nothing to send says so", () => {
  assert.match(planImport(ENTRIES, [file("a", 600), file("b", 500)], 1000).problem!, /need 0\.0 MiB/);
  assert.equal(fitProblem(1000, 1000), undefined);
  assert.match(planImport(ENTRIES, [file("a/b", 1)], 1000).problem!, /No file can be sent/);
});

test("a sample name may use the whole path, a folder name must leave room", () => {
  const full = "x".repeat(SAMPLE_PATH_MAX);
  assert.equal(sampleNameProblem("", full), undefined);
  assert.match(sampleNameProblem("", `${full}x`)!, /too long/);
  assert.match(sampleNameProblem("", " kick")!, /A sample name cannot start or end/);
});

/** A 48 kHz 16-bit WAV with `channels` channels and the given interleaved samples. */
function wav(channels: number, samples: number[]): Uint8Array {
  const data = samples.length * 2;
  const b = new Uint8Array(44 + data);
  const v = new DataView(b.buffer);
  const ascii = (s: string, at: number) => b.set([...s].map((c) => c.charCodeAt(0)), at);
  ascii("RIFF", 0); v.setUint32(4, 36 + data, true); ascii("WAVEfmt ", 8);
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, 48_000, true); v.setUint32(28, 48_000 * 2 * channels, true);
  v.setUint16(32, 2 * channels, true); v.setUint16(34, 16, true);
  ascii("data", 36); v.setUint32(40, data, true);
  samples.forEach((s, i) => v.setInt16(44 + 2 * i, s, true));
  return b;
}

test("a preview reads both channels of a converted stereo file, apart", async () => {
  const converter = await loadConverter(readFileSync("web/vendor/dksample.wasm"));
  const left = [1000, 2000, 3000, 4000];
  const stereo = prepareWav(converter, "s.wav", wav(2, left.flatMap((l) => [l, -7])));
  const audio = readNative(stereo.stored);
  assert.equal(audio.channels, 2);
  assert.equal(audio.rate, 48_000);
  assert.equal(audio.frames, 4);
  assert.deepEqual([...audio.channelData[0]!].map((x) => Math.round(x * 32768)), left);
  assert.deepEqual([...audio.channelData[1]!].map((x) => Math.round(x * 32768)), [-7, -7, -7, -7]);

  const mono = readNative(prepareWav(converter, "m.wav", wav(1, [5, -5, 5])).stored);
  assert.equal(mono.channels, 1);
  assert.equal(mono.frames, 3);
  assert.throws(() => readNative(new Uint8Array(100)), /not a native sample file/);
});

test("an upload into the top folder is looked up as samples/<name>, not samples//<name>", async () => {
  const { putAndVerify } = await import("@noiseandmatter/dnx-core/sample/digikitstore.js");
  const stored = new Uint8Array([1, 2, 3]);
  const sha = "cd".repeat(32);
  const asked: string[] = [];
  const store = {
    samples: { put: async () => {}, verify: async () => ({ ok: true, host: sha }) },
    session: {
      list: async (prefix: string) => {
        asked.push(prefix);
        return [{ path: "samples/Tone", size: 3, sha256: sha }];
      },
    },
  } as unknown as Parameters<typeof putAndVerify>[0];
  const record = await putAndVerify(store, "", { name: "Tone", bytes: stored, stored, kind: "converted" });
  assert.equal(record.path, "samples/Tone");
  assert.deepEqual(asked, ["samples/Tone"]);
  assert.equal((await putAndVerify(store, "/", { name: "Tone", bytes: stored, stored, kind: "converted" })).path, "samples/Tone");
});
