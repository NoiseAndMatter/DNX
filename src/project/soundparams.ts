/**
 * What the bytes of a sound object mean.
 *
 * `soundmap.ts` maps the sound object **structurally** — which DN1 byte becomes which DN2 byte,
 * accurately enough that conversion is 99.99966% byte-exact. It says nothing about *meaning*.
 * This module supplies the meaning, so an editor can show `CUTOFF` rather than `byte 176`.
 *
 * Measured on 2026-07-26 from pattern H4 of `MORNING_JA 1640(5).dn2prj`. Six tracks were set to
 * FM TONE + MULTI-MODE; track 1 was left untouched as a baseline and tracks 2-6 each had a group
 * of controls set to distinct values. Diffing each sound object against the baseline names a byte
 * by the value it received. **No parameter locks were involved** — a sound object holds the
 * track's live values, so turning a knob moves a byte directly.
 *
 * ## Encodings, and they match the lock table
 *
 * - **Unipolar** controls store their value as-is.
 * - **Bipolar** controls store `value + 64`, the same offset the lock slots use.
 * - **Fine-resolution** controls store `value / 2 + 64` in the coarse byte, with a fine byte
 *   beside it — the same coarse/fine pair as a lock slot. Verified on all three LFO depths:
 *   32 stored 80, 56 stored 92.
 *
 * ## It is parameter-addressed, not slot-addressed
 *
 * `AMP HOLD` has **its own byte at +204**, sitting in the gap between `ATK` (+202) and `DEC`
 * (+206), and holding 127 when the envelope is in ADSR where `HOLD` does not exist. So the sound
 * object agrees with the lock table, which gives `HOLD` id 88 distinct from `DEC`'s 89.
 *
 * That answers a question that would have shaped an editor: **reading an envelope does not
 * require knowing the AMP `MODE`.** Had the byte been shared, every read would have needed the
 * mode first.
 */

/** How to read a control's stored byte. */
export type SoundEncoding = "unipolar" | "bipolar" | "fine" | "enum";

export interface SoundParameter {
  /** Offset of the value byte, relative to the start of the 359-byte sound object. */
  offset: number;
  page: string;
  name: string;
  encoding: SoundEncoding;
  /** True where the offset is inferred from a rule rather than observed directly. */
  inferred?: boolean;
}

/**
 * The three LFOs are a regular grid: `offset = 30 + 8 * parameter + 2 * lfo`.
 *
 * Eight parameters in page order, three LFOs interleaved at stride 2, with the fourth slot of
 * each group of 8 unused. Every byte that changed in the LFO tracks of the capture lands on this
 * rule and nothing lands off it.
 *
 * Compare the lock table, where the same three LFOs interleave as `4 * slot + lfo`. Both layers
 * interleave rather than blocking, but with different strides — so neither can be derived from
 * the other.
 */
export const LFO_BASE = 30;
export const LFO_PARAMETER_STRIDE = 8;
export const LFO_STRIDE = 2;
const LFO_PARAMETERS = ["SPD", "MULT", "FADE", "DEST", "WAVE", "SPH", "MODE", "DEP"] as const;
/** `SPD`, `FADE` and `DEP` are the ones observed carrying a sign or a fine byte. */
const LFO_ENCODING: Record<string, SoundEncoding> = {
  SPD: "bipolar", MULT: "enum", FADE: "bipolar", DEST: "enum",
  WAVE: "enum", SPH: "unipolar", MODE: "enum", DEP: "fine",
};

function lfoParameters(): SoundParameter[] {
  const out: SoundParameter[] = [];
  for (let p = 0; p < LFO_PARAMETERS.length; p++) {
    for (let lfo = 0; lfo < 3; lfo++) {
      const name = LFO_PARAMETERS[p]!;
      out.push({
        offset: LFO_BASE + LFO_PARAMETER_STRIDE * p + LFO_STRIDE * lfo,
        page: `MOD ${lfo + 1}`,
        name,
        encoding: LFO_ENCODING[name]!,
      });
    }
  }
  return out;
}

export const SOUND_PARAMETERS: readonly SoundParameter[] = [
  ...lfoParameters(),

  // SYN page 1. HARM is the odd one: its baseline is 63 and it stored 86 for +23, so its centre
  // is 63 rather than the 64 every other bipolar control uses. Recorded as measured.
  { offset: 102, page: "SYN 1", name: "HARM", encoding: "bipolar" },
  { offset: 104, page: "SYN 1", name: "DTUN", encoding: "unipolar" },
  { offset: 106, page: "SYN 1", name: "FDBK", encoding: "unipolar" },
  { offset: 108, page: "SYN 1", name: "MIX", encoding: "bipolar" },

  // SYN page 2: the two operator envelopes, four bytes each at stride 2.
  { offset: 114, page: "SYN 2", name: "A ATK", encoding: "unipolar" },
  { offset: 116, page: "SYN 2", name: "A DEC", encoding: "unipolar" },
  { offset: 118, page: "SYN 2", name: "A END", encoding: "unipolar" },
  { offset: 120, page: "SYN 2", name: "A LEV", encoding: "unipolar" },
  { offset: 122, page: "SYN 2", name: "B ATK", encoding: "unipolar" },
  { offset: 124, page: "SYN 2", name: "B DEC", encoding: "unipolar" },
  { offset: 126, page: "SYN 2", name: "B END", encoding: "unipolar" },
  { offset: 128, page: "SYN 2", name: "B LEV", encoding: "unipolar" },

  { offset: 130, page: "SYN 3", name: "ADEL", encoding: "unipolar" },
  { offset: 136, page: "SYN 3", name: "BDEL", encoding: "unipolar" },

  { offset: 168, page: "SYN 4", name: "KTRK A", encoding: "unipolar" },
  { offset: 170, page: "SYN 4", name: "KTRK B1", encoding: "unipolar" },
  { offset: 172, page: "SYN 4", name: "KTRK B2", encoding: "unipolar" },

  { offset: 176, page: "FLTR 1", name: "FREQ", encoding: "unipolar" },
  { offset: 178, page: "FLTR 1", name: "RESO", encoding: "unipolar" },
  { offset: 180, page: "FLTR 1", name: "ENV", encoding: "bipolar" },
  { offset: 184, page: "FLTR 1", name: "ATK", encoding: "unipolar" },
  { offset: 186, page: "FLTR 1", name: "DEC", encoding: "unipolar" },
  { offset: 188, page: "FLTR 1", name: "SUS", encoding: "unipolar" },
  { offset: 190, page: "FLTR 1", name: "REL", encoding: "unipolar" },

  { offset: 182, page: "FLTR 2", name: "DEL", encoding: "unipolar" },
  { offset: 192, page: "FLTR 2", name: "KEY.T", encoding: "unipolar" },
  { offset: 194, page: "FLTR 2", name: "BASE", encoding: "unipolar" },
  { offset: 196, page: "FLTR 2", name: "WDTH", encoding: "unipolar" },

  // The AMP envelope, stride 4 rather than 2, with HOLD occupying the gap.
  { offset: 202, page: "AMP", name: "ATK", encoding: "unipolar" },
  { offset: 204, page: "AMP", name: "HOLD", encoding: "unipolar" },
  { offset: 206, page: "AMP", name: "DEC", encoding: "unipolar" },
  { offset: 208, page: "AMP", name: "SUS", encoding: "unipolar" },
  { offset: 210, page: "AMP", name: "REL", encoding: "unipolar" },
  { offset: 218, page: "AMP", name: "PAN", encoding: "bipolar" },
  { offset: 220, page: "AMP", name: "VOL", encoding: "unipolar" },

  // The per-sound FX sends. These are distinct from the kit-level FX block in kitfx.ts: these
  // say how much of *this sound* is sent, those configure the effect itself.
  { offset: 212, page: "FX", name: "CHR", encoding: "unipolar" },
  { offset: 214, page: "FX", name: "DEL", encoding: "unipolar" },
  { offset: 216, page: "FX", name: "REV", encoding: "unipolar" },
  { offset: 232, page: "FX", name: "SRR", encoding: "unipolar" },
  { offset: 236, page: "FX", name: "OVER", encoding: "unipolar" },
];

/**
 * Controls that were set during the capture but whose byte was not identified.
 *
 * `FX BR` was set to 11 and no byte took that value; `+230` moved to 19, which is the nearest
 * candidate but does not match, so it is left unclaimed rather than guessed. The selector
 * controls were deliberately not given numbers, so their bytes are located but unnamed — see the
 * capture notes in `docs/dn2-capture-plan.md`.
 */
export const UNRESOLVED_SOUND_CONTROLS: readonly string[] = ["FX BR"];

const BY_OFFSET = new Map(SOUND_PARAMETERS.map((p) => [p.offset, p]));

/** Name the byte at a sound-object offset, or `undefined` if it is not a named parameter. */
export function soundParameterAt(offset: number): SoundParameter | undefined {
  return BY_OFFSET.get(offset);
}

/** Decode a stored byte according to the parameter's encoding. */
export function decodeSoundValue(p: SoundParameter, coarse: number): number {
  switch (p.encoding) {
    case "bipolar":
      return coarse - 64;
    case "fine":
      return (coarse - 64) * 2;
    default:
      return coarse;
  }
}
