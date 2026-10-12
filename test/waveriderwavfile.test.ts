/**
 * Reading WAV bytes, against files this test assembles byte by byte.
 *
 * **The fixtures are built here, by hand, not produced by a writer in `wavfile.ts`.** There is no
 * writer, and if one is ever added these must not start using it: a reader checked against its own
 * writer agrees with itself about a format both of them may have wrong. The byte layouts below come
 * from the RIFF/WAVE specification, and the sample values are chosen so a sign or endianness
 * mistake changes them visibly.
 *
 * The chunk-walking tests matter more than they look. Real wavetable exports carry `LIST` and `cue `
 * chunks, sometimes before `data` and sometimes with odd sizes, and seeking to a fixed offset works
 * on a file written by the one exporter you tested against.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeWav, mixToMono, readWavFile } from "@noiseandmatter/dnx-core/waverider/wavfile.js";
import { WaveriderError } from "@noiseandmatter/dnx-core/waverider/errors.js";

interface Chunk {
  id: string;
  body: number[];
}

/** Assemble a RIFF/WAVE file from chunks, padding odd-sized ones as the format requires. */
function riff(chunks: readonly Chunk[]): Uint8Array {
  const parts: number[] = [];
  for (const { id, body } of chunks) {
    for (let i = 0; i < 4; i++) parts.push(id.charCodeAt(i));
    const size = body.length;
    parts.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff);
    parts.push(...body);
    if (size % 2) parts.push(0);
  }
  const payload = [0x57, 0x41, 0x56, 0x45, ...parts]; // "WAVE" then the chunks
  const total = payload.length;
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    total & 0xff, (total >> 8) & 0xff, (total >> 16) & 0xff, (total >>> 24) & 0xff,
    ...payload,
  ]);
}

function le16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}
function le32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

/** A `fmt ` body. `extra` appends the extensible tail. */
function fmt(
  tag: number,
  channels: number,
  rate: number,
  bits: number,
  extra: number[] = [],
): Chunk {
  const blockAlign = (bits >> 3) * channels;
  return {
    id: "fmt ",
    body: [
      ...le16(tag),
      ...le16(channels),
      ...le32(rate),
      ...le32(rate * blockAlign),
      ...le16(blockAlign),
      ...le16(bits),
      ...extra,
    ],
  };
}

test("looksLikeWav checks the two magic words and nothing else", () => {
  assert.equal(looksLikeWav(riff([fmt(1, 1, 44_100, 16), { id: "data", body: [0, 0] }])), true);
  assert.equal(looksLikeWav(Uint8Array.from([1, 2, 3])), false);
  // A RIFF container that is not WAVE, such as an AVI, must not be read as one.
  const avi = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]);
  assert.equal(looksLikeWav(avi), false);
});

test("16 bit PCM reads at the file's own rate, little-endian and signed", () => {
  // 0, +32767, -32768, -1 — the four values a sign or byte-order mistake changes visibly.
  const data = [...le16(0), ...le16(32_767), ...le16(0x8000), ...le16(0xffff)];
  const audio = readWavFile(riff([fmt(1, 1, 48_000, 16), { id: "data", body: data }]));

  assert.equal(audio.sampleRate, 48_000, "the file's rate must survive, not the context's");
  assert.equal(audio.frames, 4);
  assert.equal(audio.channels.length, 1);
  assert.equal(audio.format, "16 bit PCM");

  const got = [...audio.channels[0]!];
  assert.ok(Math.abs(got[0]!) < 1e-9);
  assert.ok(Math.abs(got[1]! - 32_767 / 32_768) < 1e-6, `+32767 read as ${got[1]}`);
  assert.ok(Math.abs(got[2]! + 1) < 1e-9, `-32768 read as ${got[2]}`);
  assert.ok(Math.abs(got[3]! + 1 / 32_768) < 1e-9, `-1 read as ${got[3]}`);
});

test("24 bit PCM keeps its sign across the three bytes", () => {
  // +1 (0x000001), -1 (0xFFFFFF), near full negative (0x800000), near full positive (0x7FFFFF).
  const data = [0x01, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x80, 0xff, 0xff, 0x7f];
  const audio = readWavFile(riff([fmt(1, 1, 44_100, 24), { id: "data", body: data }]));
  const got = [...audio.channels[0]!];
  assert.equal(audio.format, "24 bit PCM");
  assert.ok(Math.abs(got[0]! - 1 / 8_388_608) < 1e-12, `0x000001 read as ${got[0]}`);
  assert.ok(Math.abs(got[1]! + 1 / 8_388_608) < 1e-12, `0xFFFFFF read as ${got[1]}`);
  assert.ok(Math.abs(got[2]! + 1) < 1e-12, `0x800000 read as ${got[2]}`);
  assert.ok(Math.abs(got[3]! - 8_388_607 / 8_388_608) < 1e-12, `0x7FFFFF read as ${got[3]}`);
});

test("8 bit PCM is unsigned, alone among the integer widths", () => {
  const audio = readWavFile(riff([fmt(1, 1, 22_050, 8), { id: "data", body: [128, 255, 0, 64] }]));
  const got = [...audio.channels[0]!];
  assert.equal(audio.format, "8 bit PCM");
  assert.ok(Math.abs(got[0]!) < 1e-9, `128 should be silence, read as ${got[0]}`);
  assert.ok(got[1]! > 0.99, `255 should be near full positive, read as ${got[1]}`);
  assert.ok(Math.abs(got[2]! + 1) < 1e-9, `0 should be full negative, read as ${got[2]}`);
  assert.ok(got[3]! < -0.4 && got[3]! > -0.6, `64 should be about -0.5, read as ${got[3]}`);
});

test("32 bit float is read as the floats it is", () => {
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setFloat32(0, 0.5, true);
  new DataView(bytes.buffer).setFloat32(4, -0.25, true);
  // Float WAV may legitimately exceed full scale; it must not be clamped on the way in.
  new DataView(bytes.buffer).setFloat32(8, 1.5, true);

  const audio = readWavFile(riff([fmt(3, 1, 96_000, 32), { id: "data", body: [...bytes] }]));
  assert.equal(audio.format, "32 bit float");
  assert.equal(audio.sampleRate, 96_000);
  assert.deepEqual([...audio.channels[0]!], [0.5, -0.25, 1.5]);
});

test("channels are de-interleaved", () => {
  // L R L R, with the channels clearly different.
  const data = [...le16(10_000), ...le16(-10_000 & 0xffff), ...le16(20_000), ...le16(-20_000 & 0xffff)];
  const audio = readWavFile(riff([fmt(1, 2, 44_100, 16), { id: "data", body: data }]));
  assert.equal(audio.channels.length, 2);
  assert.equal(audio.frames, 2);
  assert.ok(audio.channels[0]![0]! > 0 && audio.channels[1]![0]! < 0, "the channels are swapped or mixed");
  assert.ok(audio.channels[0]![1]! > audio.channels[0]![0]!, "the second frame did not advance");
});

test("chunks are walked, including an odd-sized one before the data", () => {
  /*
   * A 3-byte LIST chunk is followed by one pad byte that its size does not count. Getting that
   * wrong puts the walk one byte out and every chunk after it is garbage, which is why this is
   * here rather than assumed.
   */
  const data = [...le16(1000), ...le16(2000)];
  const audio = readWavFile(
    riff([
      fmt(1, 1, 44_100, 16),
      { id: "LIST", body: [0x49, 0x4e, 0x46] },
      { id: "cue ", body: le32(0) },
      { id: "data", body: data },
    ]),
  );
  assert.equal(audio.frames, 2);
  assert.ok(audio.channels[0]![0]! > 0 && audio.channels[0]![1]! > audio.channels[0]![0]!);
});

test("a fmt chunk after the data chunk is still found", () => {
  const audio = readWavFile(
    riff([{ id: "data", body: [...le16(1000)] }, fmt(1, 1, 8000, 16)]),
  );
  assert.equal(audio.sampleRate, 8000);
  assert.equal(audio.frames, 1);
});

test("WAVE_FORMAT_EXTENSIBLE is read through to its sub-format", () => {
  // cbSize 22, validBits, channelMask, then a GUID whose first two bytes are the real tag.
  const tail = [...le16(22), ...le16(24), ...le32(3), ...le16(1), ...new Array<number>(14).fill(0)];
  const data = [0x00, 0x00, 0x40, 0xff, 0xff, 0xbf];
  const audio = readWavFile(riff([fmt(0xfffe, 1, 48_000, 24, tail), { id: "data", body: data }]));
  assert.equal(audio.format, "24 bit PCM");
  assert.equal(audio.frames, 2);
});

test("a data size that overruns the file is clamped to what is there", () => {
  // Hand-built, because `riff` writes an honest size. Two frames declared, one present.
  const base = riff([fmt(1, 1, 44_100, 16), { id: "data", body: [...le16(4096)] }]);
  const broken = Uint8Array.from(base);
  const view = new DataView(broken.buffer);
  // The data chunk's size field: past RIFF (12) and the fmt chunk (8 + 16), then its own id.
  view.setUint32(12 + 24 + 4, 400, true);
  const audio = readWavFile(broken);
  assert.equal(audio.frames, 1, "a truncated recording should yield the frames it has");
});

test("what cannot be read exactly is refused by name", () => {
  /*
   * Format 6 is A-law, byte-aligned at 8 bits, so it gets past the sample-width check and has to be
   * refused on its format tag. A 4-bit codec such as ADPCM is caught earlier by the width, which
   * tests a different guard than the one meant here.
   */
  assert.throws(
    () => readWavFile(riff([fmt(6, 1, 8000, 8), { id: "data", body: [1, 2, 3, 4] }])),
    (error: unknown) => error instanceof WaveriderError && /not uncompressed PCM/.test(error.message),
  );
  assert.throws(() => readWavFile(riff([fmt(1, 1, 44_100, 16)])), WaveriderError);
  assert.throws(() => readWavFile(riff([{ id: "data", body: [1, 2] }])), WaveriderError);
  assert.throws(() => readWavFile(Uint8Array.from([1, 2, 3])), WaveriderError);
  // A declared rate of zero would divide by zero downstream.
  assert.throws(() => readWavFile(riff([fmt(1, 1, 0, 16), { id: "data", body: [0, 0] }])), WaveriderError);
});

test("mixing to mono averages, and reports a cancellation it cannot prevent", () => {
  const left = Float32Array.from([1, 0.5, -1]);
  const same = mixToMono([left, Float32Array.from([1, 0.5, -1])]);
  assert.deepEqual([...same.samples], [1, 0.5, -1], "identical channels should average to themselves");
  assert.equal(same.peak, 1);
  assert.equal(same.firstChannelPeak, 1);

  // Opposite phase: the average is silence and the first channel is not, which is the signal a
  // caller needs to explain a table that came out empty.
  const opposed = mixToMono([left, Float32Array.from([-1, -0.5, 1])]);
  assert.equal(opposed.peak, 0);
  assert.equal(opposed.firstChannelPeak, 1);

  assert.throws(() => mixToMono([]), WaveriderError);
});
