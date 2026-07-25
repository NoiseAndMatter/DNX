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

## Open gaps, largest first

Measured as bytes per project differing from Elektron's conversion, with `EMPTY` as
template. All are bounded by the budget test.

### Kit MIDI track records — ~3,072 bytes/project

DN1 `kit+0x54E`, 4 × 172 bytes. DN2 `kit+5964`, 16 × 268 bytes. **Not transferred at all.**

A DN1 project using its MIDI tracks loses channel and CC configuration. Impact is limited —
only 3 of 9 sampled projects use MIDI tracks at all — but for those it is a real loss.
Derivable by the usual correlation method.

### Pattern metadata — ~131 bytes/project

Residual after the scale-mode fix. The identified fields (name, tempo, length, change
length, scale mode, speed, slot index) are all correct; something else in the 44-byte block
is not. Not yet investigated.

### Kit FX region — ~397 bytes/project

49 of the 56 varying bytes are mapped. Seven DN1 FX bytes vary with no consistent DN2
destination — `UNPLACED_FX_BYTES` in `src/expand/fieldmap.ts`: `0x34, 0x36, 0x37, 0x3A,
0x46, 0x47, 0x4C`. Either the importer drops them or they land outside the region searched.

### Kit gap 10252-10751 — ~117 bytes/project

500 bytes of unidentified kit data, never investigated.

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

**Unused trigger slots and unused lock records.** Elektron leaves uncleared residue there —
fragments of whatever previously occupied the memory. We write a clean `0xFF` fill, which is
what a natively empty DN2 pattern contains. Our output is arguably more correct than the
device's; either way the bytes are inert.

**146 parity bytes.** The importer sets the odd-step flag bit per 16-step page and only on
pages containing a trig; we set it on every odd step. That bit is documented UNKNOWN, is not
needed to decode anything, and never differs on a step that carries a trig.

---

## Untrusted or unverified

**The expansion writer has never been loaded on hardware.** It writes into DN2 tracks 9-16
in a shape no Elektron file we possess has ever used. This is the single largest unverified
assumption in the project.

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
