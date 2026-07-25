/**
 * Digitone sound tags — the complete, device-confirmed table.
 *
 * A sound carries a 32-bit tag bitfield at offset +8 of its object, stored big-endian.
 * Tag t occupies bit t of that word, so `tagBits & (1 << t)`. Equivalently: tag t lives in
 * byte `11 - (t >> 3)` at bit `t & 7`.
 *
 * The tag set is CLOSED — 32 predefined values chosen on the device's TAGS screen (Digitone
 * manual sections 9.4.1 and 14.4.2). Users cannot define their own, so this table is
 * complete by construction.
 *
 * NAMES AND ORDER ARE CONFIRMED FROM THE HARDWARE. Photographs of a Digitone II TAGS screen
 * show the tags laid out in two pages of three columns, six entries per column, read
 * column-major. That order maps exactly onto bit indices 0..31:
 *
 *   page 1  col 1: <SAVE> KICK SNARE DEEP BRASS STRINGS        bits  0.. 4
 *           col 2: PERCUSSION HI-HAT CYMBAL EVOLVING           bits  5.. 8
 *                  EXPRESSIVE BASS                             bits  9..10
 *           col 3: LEAD PAD TEXTURE CHORD SOUND FX ARPEGGIO    bits 11..16
 *   page 2  col 1: METALLIC ACOUSTIC ATMOSPHERE NOISY          bits 17..20
 *                  GLITCH HARD                                 bits 21..22
 *           col 2: SOFT DARK BRIGHT VINTAGE EPIC FAIL          bits 23..28
 *           col 3: LOOP MINE FAVOURITE <RESET> <CLEAR> <SAVE>  bits 29..31
 *
 * The screen order was cross-checked against eight bit assignments derived independently
 * from 664 named sounds in 53 real projects (KICK 45/45, SNARE 39/39, PAD 13/13, LEAD 4/4,
 * BASS 39/40, HI-HAT 30/31, PERCUSSION 34/36, ARPEGGIO 4/4). Every one lands where the
 * screen puts it, which is what makes the remaining 24 trustworthy too.
 *
 * The photographs are of a Digitone II, but the DN1-derived anchors above agree with them,
 * so the two devices share this assignment.
 *
 * PERCUSSION, EXPRESSIVE and ATMOSPHERE are inferred expansions: the display truncates at
 * nine characters (PERCUSSIO, EXPRESSIV, ATMOSPHER). Nothing depends on the full spelling.
 *
 * Tags are worth relying on: 99.8% of named pool sounds and 98.9% of sounds used as sound
 * locks carry a non-zero bitfield across the corpus.
 */

/** Tag names by bit index, exactly as the device orders them. */
export const TAG_NAMES = [
  "KICK",
  "SNARE",
  "DEEP",
  "BRASS",
  "STRINGS",
  "PERCUSSION",
  "HI-HAT",
  "CYMBAL",
  "EVOLVING",
  "EXPRESSIVE",
  "BASS",
  "LEAD",
  "PAD",
  "TEXTURE",
  "CHORD",
  "SOUND FX",
  "ARPEGGIO",
  "METALLIC",
  "ACOUSTIC",
  "ATMOSPHERE",
  "NOISY",
  "GLITCH",
  "HARD",
  "SOFT",
  "DARK",
  "BRIGHT",
  "VINTAGE",
  "EPIC",
  "FAIL",
  "LOOP",
  "MINE",
  "FAVOURITE",
] as const;

export type TagName = (typeof TAG_NAMES)[number];

/**
 * Tags describing percussive character.
 *
 * Membership is a judgement about musical role, not a fact about the format — the device
 * itself draws no such distinction. Placement rules should treat it as a default the user
 * can override, never as a constraint.
 */
export const PERCUSSIVE_TAGS: ReadonlySet<TagName> = new Set<TagName>([
  "KICK",
  "SNARE",
  "PERCUSSION",
  "HI-HAT",
  "CYMBAL",
]);

/** Tags describing melodic or tonal character. Same caveat as above. */
export const MELODIC_TAGS: ReadonlySet<TagName> = new Set<TagName>([
  "BASS",
  "LEAD",
  "PAD",
  "CHORD",
  "BRASS",
  "STRINGS",
  "ARPEGGIO",
  "ACOUSTIC",
]);

export function tagIndex(name: TagName): number {
  return TAG_NAMES.indexOf(name);
}

export function hasTag(tagBits: number, name: TagName): boolean {
  return (tagBits & (1 << tagIndex(name))) !== 0;
}

/** Every tag set in a bitfield, in bit order. */
export function decodeTags(tagBits: number): TagName[] {
  const out: TagName[] = [];
  for (let b = 0; b < 32; b++) if (tagBits & (1 << b)) out.push(TAG_NAMES[b]!);
  return out;
}

/** Build a bitfield from tag names. */
export function encodeTags(tags: readonly TagName[]): number {
  let bits = 0;
  for (const t of tags) bits |= 1 << tagIndex(t);
  return bits >>> 0;
}

/**
 * Classify a sound for layout purposes.
 *
 * Returns `mixed` rather than picking a side when a sound carries both kinds, because the
 * tie-break is a policy decision that belongs at the placement layer where the user can see
 * and change it. That case is common — 85 of 283 sound-locked sounds in the corpus — and
 * often deliberate: CLAP SM is tagged BRASS and PERCUSSION, and a percussive sound used as
 * a lead is a legitimate creative choice, not a tagging error.
 */
export function soundCharacter(tagBits: number): "percussive" | "melodic" | "mixed" | "untagged" {
  if (tagBits === 0) return "untagged";
  const tags = decodeTags(tagBits);
  const perc = tags.some((t) => PERCUSSIVE_TAGS.has(t));
  const mel = tags.some((t) => MELODIC_TAGS.has(t));
  if (perc && mel) return "mixed";
  if (perc) return "percussive";
  if (mel) return "melodic";
  return "untagged";
}
