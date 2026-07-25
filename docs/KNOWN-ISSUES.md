# Known issues and open gaps

What is wrong, unfinished or untrusted, and how it was found. Read this before changing the
converter.

---

## The failure mode to understand first

Conversion is a **transplant**: the caller supplies a DN2 project the device itself wrote,
and we overwrite only the regions we have verified. That is what makes writing safe with a
partial understanding of a 12.9 MB format — but it has one nasty consequence.

> **A field nobody writes silently inherits the template's value.**
> It does not crash, does not warn, and does not show up in a byte diff against Elektron's
> output if that output is also the template.

Two audible bugs shipped this way before anyone noticed, both caught on hardware by ear
rather than by 75 passing tests:

- **Pattern scale mode.** Per-track lengths were written correctly, but the mode byte
  deciding whether the device *honours* them was not. A 32-step bass line played as 16.
- **Track levels.** Every track arrived at the template's default of 100, so a converted
  project lost its mix entirely.

A third, subtler variant caused a fix to only half-work: several DN1 bytes were logged as
*"constant across the corpus, nothing to transfer"*. That reasoning is wrong — **nothing to
transfer is not the same as nothing to write**, because the template's value is not
necessarily the importer's.

**Mitigation.** `test/convert.test.ts` contains a per-region byte budget measured against
Elektron's output using the *neutral* `EMPTY.dn2prj` template. The byte-diff test uses
Elektron's own output as the template and is structurally incapable of catching omissions;
the budget test exists specifically to cover that blind spot. Keep budgets tight.

---

## Hardware validation: passed, 2026-07-25/26

`MORNING_JAM_EXPANDED.dn2prj` has been loaded on a real Digitone II. **Expanded tracks 9-16
exist and carry their sounds**, which was the single largest unproven assumption in the
project — and on 2026-07-26 the user reported that **every check they ran from the test sheet
cleared on the machine**: track lengths, levels, trigs still sound-locked where they should
be, and the per-trig detail that travelled with promoted trigs.

That closes the expansion writer as an unproven component. It is not a claim that every
pattern of every project is correct — the sheet covers what was checked — but the mechanism
is validated end to end on hardware.

One reported defect did not survive checking: track 9's length in pattern A1 appeared to read
48 against the 62 in the file, and on reload it reads **62**, as written. The first reading
was of another track or page. Nothing was wrong and nothing was changed.

Two useful facts came out of chasing it anyway, and both are now recorded properly:

- Track length is written at `settings+0x0D` **on all 16 tracks**, tracks 9-16 included, with
  nothing accompanying it — `docs/dn2-pattern-format.md` §6.
- RESET and CHNG are pattern-level fields, not per-track — same section.

---

## Open gaps, largest first

Measured as bytes per project differing from Elektron's conversion, with `EMPTY` as
template. All are bounded by the budget test.

### Kit MIDI track records — ~3 bytes/project, was 10,112

**Solved 2026-07-26.** DN1 `kit+0x54E`, 4 × 172 bytes, onto DN2 `kit+5964` record 4+n of 16 ×
268. Derived from 7,168 record samples (14 pairs × 128 kits × 4 tracks): of the 18 DN2 bytes
that vary, 14 have exactly one DN1 source agreeing on every sample, three are ambiguous by
value and assigned positionally, and one has none. See `MIDI_TRACK_MAP` in
`src/expand/fieldmap.ts`.

Two thirds of the old divergence was not the configuration at all but the **track name**: a
native DN2 names its MIDI records `MIDI 1`..`MIDI 16` and the importer clears all sixteen, so
a template contributed sixteen names we inherited. Textbook "constant across the corpus is not
the same as nothing to write".

What remains: `dn2[54]` varies across 0, 41 and 42 with no DN1 source — `UNPLACED_MIDI_BYTES`.
Two projects show a residue of 2 and 11 bytes per project; the other pairs are exact.

### Pattern metadata — closed, 0 bytes/project

**Solved 2026-07-26**, and 95% of it was one byte. `+0x21` reads 7 in every record Elektron
converted and 1 in every native capture, so a device-written template contributed 1 and we
inherited it — 768 of the 810 differing bytes. The other two were exact copies at the same
relative offset the rest of the block already uses: `+0x11` from DN1 `0x4735` and `+0x18`
from DN1 `0x473C`, unanimous across all 1,152 matched pattern pairs.

The block now matches Elektron byte for byte on every pair. What the three fields *mean* is
still unknown on both devices.

### Kit FX region — ~152 bytes/project, was ~409

Four of the seven unplaced DN1 bytes were found on 2026-07-26 by correlating what still
differed against the **whole** DN1 kit rather than only the FX block:

- `FX+0x37`, `FX+0x46`, `FX+0x47` are ordinary copies to kit+5859, +5874, +5875 — each at
  `5804 +` its own FX offset, the rule most of the block already follows.
- `FX+0x34` is **rescaled**, not copied: 0..127 becomes a `u16be` at kit+5898 at roughly
  x201.57 (64 to 12,900, 100 to 20,157, 127 to 25,599). Five values appear in the corpus and
  they are stored as a table; anything outside it keeps the template's value and warns, since
  no arithmetic rule reproduces all five exactly. This alone was 256 bytes/project, because
  the field differs in **every** kit.

`UNPLACED_FX_BYTES` is now `0x36, 0x3A, 0x4C`.

Three DN2 bytes remain unexplained: **kit+5858** (values 0, 6, 94, 100, 102), **kit+5860**
(0, 100) and **kit+5878** (0, 1). None is an exact copy of, or a function of, any single byte
of the DN1 kit — checked over all 2,560 offsets across 1,024 kit pairs. They either combine
several sources or come from outside the kit record.

### Kit gap 10252-10751 — ~117 bytes/project

500 bytes of unidentified kit data. Two things are now known inside it:

- **kit+10260** is the `u16be` synth/MIDI track mask (`docs/dn2-pattern-format.md` §7). We
  write it.
- **kit+10264 looks like a 16 × 5-byte per-track array**, default `00 00 81 20 00`. Elektron's
  importer writes non-default values into individual entries — in `MORNING_JAM` A1, entry 2
  reads `00 00 01 20 00` and entry 3 `00 00 81 20 01` — and we never write any of it. The
  values do not correlate with track length or speed in the samples checked, so what they are
  is unknown. Alignment of the array start is inferred from the repeat, not proven.

The rest is uninvestigated.

### Tail project settings — ~19 bytes/project

MIDI config (sync, port config, channels) and audio routing. Tiny and tractable: only 30
distinct byte offsets differ between `EMPTY` and Elektron's conversions across four
projects. The clearest signal is `+0xA0..+0xA7` going `0xFF` to `8,9,...,15` in every
project — the per-track MIDI channel array widening from the DN1's 8 entries to the DN2's
16, corroborating the DN1 tail finding at `0x299A1B`. `+0xB0..+0xB7` look like per-track
flags.

### Track settings — ~5 bytes/project

Effectively closed, but four DN1 bytes vary with no consistent destination:
`UNPLACED_TRACK_SETTINGS` = `0x01, 0x06, 0x08, 0x0A`.

---

## Accepted divergences

Deliberate, bounded, and asserted so they cannot grow.

**Duplicate sounds in the project pool.** A DN1 pool accumulates byte-identical copies from
repeated saves — `002 MORNING_JAM` holds 64 named slots but only 57 distinct sounds, one of
them occupying seven consecutive slots. We copy the pool across verbatim, which is exactly
what Elektron's own importer does. **Deliberately not deduplicated:** the conversion is a
transplant, not a clean-up, and collapsing slots would mean rewriting every sound lock that
addresses the pool by index. Decided 2026-07-26.

**Unused trigger slots and unused lock records.** Elektron leaves uncleared residue there —
fragments of whatever previously occupied the memory. We write a clean `0xFF` fill, which is
what a natively empty DN2 pattern contains. Our output is arguably more correct than the
device's; either way the bytes are inert.

**146 parity bytes.** The importer sets the odd-step flag bit per 16-step page and only on
pages containing a trig; we set it on every odd step. That bit is documented UNKNOWN, is not
needed to decode anything, and never differs on a step that carries a trig.

---

## Untrusted or unverified

**DN2 pattern record version 2.** The factory `PRESETS.dn2prj` uses version 2; our reader
assumes 3 and its structural check fails on all 128 of its patterns. Conversion always
targets version 3 so this does not affect the converter, but a librarian operating on native
DN2 projects will hit it.

**Sound-mapping residue.** Three fields carry provenance warnings rather than certainty:
`dn1[173] -> dn2[229]` and `dn1[208] -> dn2[270]` are inferred from a structural rule and
confirmed on only one non-default sample each; `dn1[284]` and `dn1[286]` have no known
destination and are dropped, affecting 4 of 1,102 sounds. `convertDn1SoundToDn2Detailed`
reports all of these per field.

**DN1 song-row layout.** Rows are 21 bytes on the DN1 and 29 on the DN2, and the 8-byte
difference is certainly per-track — almost certainly a mute mask. Its position is unknown
because every one of the 89,199 corpus rows is empty. **Any feature that moves a track
between indices must refuse when the song table is non-empty**, or it risks a desync that
plays correctly but arranges wrongly. `isSongTableEmpty()` exists for exactly this.

**The 1,024 × 11-byte slot array** at DN1 `0x299A45`. `1024 = 8 × 128` and the corpus cannot
distinguish "8 tracks × 128 patterns" from the other factorisation. Empty in 50 of 53
projects. Guard with `isSlotArrayEmpty()`.

---

## Traps that have already cost time

**Entropy is not a compression test.** Windowed entropy over a project payload reads 3.7-6.2
bits and looks nothing like compressed data. It is LZ4 throughout. Worse, the leftover
literals invite false pattern-matching: a run of `u16le` match offsets puts an `0xFF` every
six bytes and looks exactly like a field layout. **Decompress first; never pattern-match raw
payload bytes.**

**Micro timing's `0xFF` means −1**, not "unset". It is the only byte in the pattern record
where `0xFF` is a value rather than a sentinel.

**Do not stop reading the trigger array at the first `0xFF`.** The device frees slots in
place and leaves holes. Elektron's importer happens to write a dense prefix, so code that
stops early appears to work until it meets a device-written pattern.

**Name fields are never cleared on rename.** Renaming NEW PROJECT to GROOVY leaves "JECT"
after the terminator. Re-encoding a decoded string zeroes that residue and diverges from the
device. Transplant the bytes.

**Rebuilt files are not byte-identical and that is fine.** LZ4 admits many valid encodings.
Correctness means *decodes to the same image*, never *same bytes*. Do not diff project files
to check a change.
