/**
 * Audio into a Waverider table: peak-normalise, quantise, pack.
 *
 * ## The seam, and why it is here
 *
 * **This takes samples that have already been decoded, and never touches an audio file.** Format
 * decoding — WAV, FLAC, MP3, whatever — belongs to the browser, through `decodeAudioData`, which
 * is the same route elk-herd takes through its own port. That way DNX reads every format Chrome
 * does without carrying a decoder, and everything below this line stays a pure function that runs
 * in a test with no DOM.
 *
 * The device's side of the seam is equally firm: it receives a table ready to play. Nothing is
 * converted on the instrument, exactly as elk-herd sends the Digitakt II ready-made PCM rather
 * than a file.
 *
 * ## What the format says, and what each clause costs if you get it wrong
 *
 * From `waverider-store.md`, sample format 1:
 *
 * - **int16 big-endian**, wave after wave, sample after sample. Big-endian because the ColdFire
 *   sends 16-bit words that way and the DSP pairs them into its 32-bit word. **That chain is still
 *   a hypothesis** — it comes from the DSP gate's frame layout, not from an instrument — so the
 *   acceptance test for the first written table is that it *sounds* right, not that it round-trips.
 *   A wrong guess costs a new value of the sample format field, not a format revision.
 * - **Peak-normalised to ±32767, symmetric, rounded half away from zero**, matching
 *   `dnfw.waverider.reduce`.
 * - **The applied gain is stored**, 16.16 fixed point, at entry +96. Normalising throws away the
 *   source's own level and nothing else records it; two tables made from material at different
 *   levels are otherwise indistinguishable afterwards.
 *
 * ## Symmetric, which is a decision and not an accident
 *
 * elk-herd packs its samples as `floor(f * 32767.5)`, which reaches both −32768 and +32767 — the
 * full two's-complement range. This normalises to **±32767** instead, leaving −32768 unused, which
 * is what `reduce` does and therefore what the DSP has been fed so far.
 *
 * The difference is one code at the bottom of the range and it is inaudible. It is written down
 * because the two Elektron-adjacent conventions differ, and somebody comparing this to elk-herd
 * one day should find the discrepancy already explained rather than treat it as a bug.
 */

import { WaveriderError } from "./store.js";

/** What a converted table is, before it is given a slot. */
export interface ConvertedTable {
  /** int16 big-endian, `waves * points * 2` bytes. */
  payload: Uint8Array;
  waves: number;
  points: number;
  /**
   * The **level** change the conversion applied: `1 / peak`. 1 when the source already peaked.
   *
   * Not the float-to-int16 scale. That is a fixed part of the format and recording it would say
   * nothing; what is worth recording is how much louder this table was made, because that is what
   * is otherwise unrecoverable.
   */
  gain: number;
  /** The largest absolute sample in the source, before normalising. 0 for silence. */
  peak: number;
}

/** Full scale, positive and negative alike. */
export const FULL_SCALE = 32_767;

/**
 * The largest gain the index can store, since the field is 16.16 fixed point.
 *
 * A source would have to peak below `1 / 65536` — about 96 dB down — to need more, and normalising
 * that by 65,536 brings its noise floor to full scale. **Refused rather than clamped**: a clamped
 * gain is a lie about what was applied, and the stored gain's whole job is to be the record of it.
 */
export const MAX_GAIN = 0xffff + 0xffff / 0x10000;

/**
 * Round half away from zero, which `Math.round` does not do.
 *
 * `Math.round(-0.5)` is `-0`, because it rounds half *up* toward positive infinity. For a signed
 * waveform that biases every negative half-step one code toward zero, and the asymmetry is exactly
 * the kind that shows up as a tiny DC offset rather than as an error.
 */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Convert decoded samples into one table.
 *
 * `samples` is the whole wavetable laid end to end: `waves * points` values, nominally in −1..1
 * but not required to be — the peak is measured, not assumed, so material that already clips or
 * that sits far below full scale both come out right and the gain says which happened.
 */
export function convertTable(
  samples: Float32Array | readonly number[],
  waves: number,
  points: number,
): ConvertedTable {
  if (!Number.isInteger(waves) || waves <= 0) {
    throw new WaveriderError(`waves must be a positive integer, got ${waves}`);
  }
  if (!Number.isInteger(points) || points <= 0) {
    throw new WaveriderError(`points per wave must be a positive integer, got ${points}`);
  }

  const wanted = waves * points;
  if (samples.length !== wanted) {
    throw new WaveriderError(
      `${waves} waves x ${points} points needs ${wanted} samples and ${samples.length} were given. ` +
        `A wavetable is cut into equal waves, so a source that does not divide exactly has to be ` +
        `trimmed or resampled before it gets here — silently padding it would shift every wave ` +
        `after the first.`,
    );
  }

  let peak = 0;
  for (let i = 0; i < wanted; i++) {
    const value = samples[i]!;
    if (!Number.isFinite(value)) {
      throw new WaveriderError(`sample ${i} is ${value}, which cannot be converted`);
    }
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }

  /*
   * **Silence converts to silence rather than failing.** A gain of 1 is the honest record: nothing
   * was scaled, because there was nothing to scale. Dividing by a zero peak would give every
   * sample NaN and a table of 0x8000s, which is a loud noise where silence was asked for.
   */
  const gain = peak === 0 ? 1 : 1 / peak;
  if (gain > MAX_GAIN) {
    throw new WaveriderError(
      `this source peaks at ${peak.toPrecision(3)}, so normalising it needs a gain of ` +
        `${gain.toPrecision(5)} and the index stores at most ${MAX_GAIN.toFixed(2)}. A source that ` +
        `quiet is almost certainly wrong, and amplifying it brings its noise floor to full scale.`,
    );
  }

  const payload = new Uint8Array(wanted * 2);
  for (let i = 0; i < wanted; i++) {
    // The exact factor, not the quantised one the index stores. The stored gain is a record of
    // what was done to within 1/65536, not the number the conversion ran on.
    let value = roundHalfAwayFromZero(samples[i]! * gain * FULL_SCALE);
    // Guards the edge where floating point lands a hair past full scale. Clamping symmetrically
    // keeps −32768 out of the payload, which is the convention the DSP has been fed.
    if (value > FULL_SCALE) value = FULL_SCALE;
    if (value < -FULL_SCALE) value = -FULL_SCALE;
    const word = value < 0 ? value + 0x10000 : value;
    // **Big-endian**, high byte first.
    payload[i * 2] = (word >>> 8) & 0xff;
    payload[i * 2 + 1] = word & 0xff;
  }

  return { payload, waves, points, gain, peak };
}

/**
 * Read a table's samples back, as the device would see them.
 *
 * For verification rather than for playback: a table read off the +Drive can be decoded here and
 * compared with what the conversion produced. **Undoing the gain is deliberately not done** — that
 * would compare the source against itself through two roundings and hide a quantisation bug. What
 * is comparable is the stored int16s.
 */
export function readTableSamples(payload: Uint8Array): Int16Array {
  if (payload.length % 2 !== 0) {
    throw new WaveriderError(`a table of int16 cannot be ${payload.length} bytes, which is odd`);
  }
  const out = new Int16Array(payload.length / 2);
  for (let i = 0; i < out.length; i++) {
    const word = (payload[i * 2]! << 8) | payload[i * 2 + 1]!;
    out[i] = word >= 0x8000 ? word - 0x10000 : word;
  }
  return out;
}

/**
 * The name a table is given on the device, carrying Tonverk's convention for people to read.
 *
 * `_wt<points>` gives the wave size and a trailing `r` means no interpolation. **Nothing reads
 * this back** — the geometry lives in the index, and `store.ts` decodes the name as a label only.
 * It is written because a person looking at a +Drive listing on the instrument's screen has
 * nothing else to go on.
 *
 * Truncated to fit the entry's 64 bytes with the suffix intact, because the suffix is the part
 * that carries information and the stem is the part somebody can still recognise shortened.
 */
export function tableName(stem: string, points: number, interpolate: boolean): string {
  const suffix = `_wt${points}${interpolate ? "" : "r"}`;
  const room = 64 - suffix.length;
  const trimmed = stem.length > room ? stem.slice(0, room) : stem;
  return `${trimmed}${suffix}`;
}
