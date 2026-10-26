/**
 * Reading AIFF and AIFF-C, against files this test assembles byte by byte, and the one-call
 * import that goes from file bytes to a stored sample.
 *
 * The layouts come from Apple's AIFF 1.3 and AIFF-C specifications. The 80-bit rate for 44,100
 * is the standard encoding `40 0E AC 44 00 00 00 00 00 00`, written out rather than computed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeAiff, readAiffFile, readExtended } from "@noiseandmatter/dnx-core/audio/aifffile.js";
import { AudioError } from "@noiseandmatter/dnx-core/audio/errors.js";
import { readAudioFile } from "@noiseandmatter/dnx-core/audio/readaudio.js";
import { importAudioFile } from "@noiseandmatter/dnx-core/sample/importfile.js";

const RATE_44100 = [0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0];
const RATE_48000 = [0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0];

const u16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function chunk(id: string, body: number[]): number[] {
  return [...ascii(id), ...u32(body.length), ...body, ...(body.length % 2 ? [0] : [])];
}

function form(kind: "AIFF" | "AIFC", chunks: number[][]): Uint8Array {
  const body = [...ascii(kind), ...chunks.flat()];
  return Uint8Array.from([...ascii("FORM"), ...u32(body.length), ...body]);
}

function comm(channels: number, frames: number, bits: number, rate: number[], compression?: string): number[] {
  const body = [...u16(channels), ...u32(frames), ...u16(bits), ...rate];
  if (compression) body.push(...ascii(compression), 0);
  return chunk("COMM", body);
}

const ssnd = (data: number[]): number[] => chunk("SSND", [...u32(0), ...u32(0), ...data]);

test("the 80-bit rate reads as 44,100 and 48,000", () => {
  assert.equal(readExtended(new DataView(Uint8Array.from(RATE_44100).buffer), 0), 44_100);
  assert.equal(readExtended(new DataView(Uint8Array.from(RATE_48000).buffer), 0), 48_000);
});

test("16-bit AIFF is big-endian and signed", () => {
  const file = form("AIFF", [comm(1, 3, 16, RATE_44100), ssnd([0x40, 0x00, 0xc0, 0x00, 0x00, 0x01])]);
  assert.ok(looksLikeAiff(file));
  const audio = readAiffFile(file);
  assert.equal(audio.sampleRate, 44_100);
  assert.equal(audio.frames, 3);
  assert.deepEqual([...audio.channels[0]!], [0.5, -0.5, 1 / 32_768]);
});

test("24-bit stereo keeps its sign and its channel order", () => {
  const file = form("AIFF", [comm(2, 1, 24, RATE_48000), ssnd([0x40, 0x00, 0x00, 0xc0, 0x00, 0x00])]);
  const audio = readAiffFile(file);
  assert.deepEqual([audio.channels[0]![0], audio.channels[1]![0]], [0.5, -0.5]);
});

test("AIFF-C sowt is little-endian, and fl32 is float", () => {
  const sowt = form("AIFC", [comm(1, 1, 16, RATE_48000, "sowt"), ssnd([0x00, 0x40])]);
  assert.deepEqual([...readAiffFile(sowt).channels[0]!], [0.5]);
  const float = form("AIFC", [comm(1, 1, 32, RATE_48000, "fl32"), ssnd([0x3f, 0x00, 0x00, 0x00])]);
  assert.deepEqual([...readAiffFile(float).channels[0]!], [0.5]);
});

test("chunks are walked, so one before COMM does not matter", () => {
  const file = form("AIFF", [chunk("NAME", ascii("odd")), comm(1, 1, 16, RATE_48000), ssnd([0x40, 0x00])]);
  assert.deepEqual([...readAiffFile(file).channels[0]!], [0.5]);
});

test("a compressed AIFF-C, a missing SSND and a non-AIFF are refused", () => {
  assert.throws(() => readAiffFile(form("AIFC", [comm(1, 1, 16, RATE_48000, "ima4"), ssnd([0, 0])])), /ima4/);
  assert.throws(() => readAiffFile(form("AIFF", [comm(1, 1, 16, RATE_48000)])), AudioError);
  assert.throws(() => readAiffFile(Uint8Array.from(ascii("RIFF0000WAVE"))), AudioError);
});

test("readAudioFile chooses the reader by the bytes, and importAudioFile goes on to a sample", () => {
  const file = form("AIFF", [comm(1, 2, 16, RATE_48000), ssnd([0x40, 0x00, 0xc0, 0x00])]);
  assert.equal(readAudioFile(file).frames, 2);
  const imported = importAudioFile(file);
  assert.deepEqual([...imported.sample.pcm], [16_384, -16_384]);
  assert.equal(imported.report.dithered, false);
  assert.deepEqual(imported.object, { id: imported.id, channels: 1, frames: 2 });
  assert.equal(imported.id.size, 4);
  assert.throws(() => readAudioFile(Uint8Array.from(ascii("OggS00000000"))), AudioError);
});
