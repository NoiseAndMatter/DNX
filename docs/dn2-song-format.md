# The Digitone II song table — **[verified]** 2026-08-15, **corrected** 2026-10-03

16 arrangements the instrument names, in a **17-record array** at the end of the image. Established
by differential capture on hardware; every field below was stated by a person before it was read,
and each one matched.

---

## Corrected 2026-10-03 — read this before the sections below

Three things here were wrong. The field layout inside a record was not among them.

### 1. The row count is a `u16be` at `+0xb47`, not one byte at `+0xb48`

`+0xb48` is the low half. For every count a song can hold — 0 to 99 — the high half is zero, so
reading the low byte alone gave the right answer every time and writing it left the other half
untouched. This document even recorded `+0xb47` as *"zero in every record seen"*, which is exactly
what the high byte of a small number looks like.

Found from the firmware's own loader, not from the files: no song in any of the seven captures had
more than 18 rows, so nothing on disk could have shown the difference.

### 2. There are **17** records, not 16, and the array starts one record earlier

An untouched song record reads `0x3840` at `+0xb4c` — 14,400, which is 120 BPM at the ×120 scale. A
clean project holds **seventeen** of those words at a stride of 3,072, the first at `tailBase +
0xeb50`, one whole record before what this document called song 0. Seventeen records from `tailBase +
0xe004` land on the image's last byte with nothing left over.

The sixteen-record reading closes on the last byte too, which is why it survived: to do so it has to
treat that seventeenth tempo word as a coincidence sitting exactly one stride ahead of the array.
**The Digitone 1 has seventeen song records as well** (`dn1tail.ts`), which is a second reason to
believe it rather than a second reason to doubt.

What the extra record is **for is unknown**. It reads as an untouched song in every corpus project —
no name, no rows, 120 BPM — so nothing distinguishes "a working copy of the song being edited" from
"a slot the front panel does not reach". DNX keeps the song numbering that was validated against the
device's own song list, so record 1 is still song 0; only `isSongTableEmpty` reads record 0, because
a row there is a row this build cannot explain and the guard is where that should count.

### 3. OS 1.11 moved the whole array 512 bytes later

`004 SKETCHPAD` captured on both firmwares shows **every byte of song content landing exactly 512
later** — 36 of 36, with the shift searched over `-0x2000 .. +0x2000` rather than assumed. That is
the `BOB::bobConfigStorage_v0_t` Outbox 8 block being inserted ahead of the array, the same thing OS
1.43 did to the Digitone 1, where `dn1tail.ts` already follows it. On a 1.11 image the block sits at
`tailBase + 0xdf13`, 8 records of 22 bytes, in space that was zero before. The object terminator
moves with the array.

**So song 0 is at `tailBase + 0xee04` on a project OS 1.11 wrote**, and the record's interior is
unchanged.

Confirmed field by field on two clean 1.11 captures, `TEST_FX_LOCK` and `TRACK16PROBE`: at that base
**all sixteen records read as untouched songs in every field at once** — no name, no rows, count 0,
end mode 0, 120 BPM — and the sixteenth ends on the image's last byte. A base 512 bytes out could not
produce that in sixteen consecutive records.

> **A first pass refused version 5 instead**, on the grounds that the first record's name field held
> float-shaped bytes rather than sixteen zeros. That was true of the two 1.11 projects it had looked
> at — a damaged one and one DNX had built — and false of the two sitting unexamined in the same
> folder. *The sample you happen to have is not the sample.* Four captures existed; the conclusion
> was drawn from two.

**The seventeenth record survives as all zeros, tempo included**, where a pre-1.11 project reads it
as an untouched song at 120 BPM. Nothing explains that. It costs the guard nothing: zero rows is zero
rows.

### 4. Why the version and not the image length

`GLITCH_EXP slot7` is a project read off an updated instrument that **declares storage version 3 at
the 1.11 image length**. Its object terminator sits at 12,889,600 — the 1.10E end — with 512 bytes of
slack after it, and its song array is at the version-3 base with all seventeen records intact.

**A pre-1.11 project read off a 1.11 instrument arrives padded**, exactly as a Digitone 1 project does
on OS 1.43. Placing the array by image length would have moved that file's array 512 bytes and read
every record from the middle of its neighbour. The project object's version is the thing that
actually changed, so it is what the offsets key off.

That also answers a question `KNOWN-ISSUES.md` recorded as open: **the Digitone II does over-read the
same way.** `drive.ts` still slices a Digitone II read to its declared length, so an image like this
one reaches callers with 512 bytes of slack on it. That is a separate bug and a separate fix.

### What an earlier analysis got wrong, and why

A 2026-09-27 pass concluded the **meta block moved `-0xa00` inside each record**, to `+0x147`. The
bytes it measured did move, and its reading of them predicts the same absolute addresses as a whole
array sliding, so the meta fields alone cannot tell the two apart. Rows can: `+0x147` sits inside
**row 10**, so a record laid out that way would have its row count overwritten by its own
arrangement. Testing the two readings against all of SKETCHPAD's non-zero table bytes settled it
**30-0 against the moving-field reading, and 36-36 for a +512 slide**.

> The lesson is the one this file already carries in another form: *a field's new position is only
> established against the fields around it.* Two offsets that agree on the bytes you looked at can
> disagree completely about the ones you did not.

---

## How it was found

The statistical approach failed first, and that is worth recording. A scanner that indexed recurring
values in the tail and proposed a stride was built and examined against the **Digitone 1**, whose
song table is known independently (`dn1tail.ts`, 17 × 2,560 at `0x2efc`). **It failed on all 55 DN1
projects**: song records are nearly all empty, a region of zeros is perfectly periodic at every
stride, and the true answer cannot be told from a meaningless one.

The differential method needs no inference at all. Copy the factory `PRESETS` — whose song region is
**all zeros** — build a song on the instrument, save, and diff. Four further saves each moved a
handful of bytes and settled the rest. The last one moved **two bytes in 12.9 MB**.

| capture | what it settled |
|---|---|
| a song with 18 rows, varied everything | table location, row stride, and five row fields |
| a second song, END = STOP | song record stride, row count, end mode, song tempo |
| a third song using `(EMPTY)` and `(PTN NAME)` | label values 0 and 1 |
| song 1 → STOP | LOOP vs STOP, separated from any new-song default |
| a row set to FADE | label value 16 |
| swing 57% and 80%, plus a song in slot 16 | the swing byte, and the last slot reading at the predicted offset |
| a tempo of 135.1 | the × 120 scale, exactly, at 0.1 BPM resolution |

---

## Geometry, and it closes exactly

**17 × 3,072 = 52,224 bytes, from `tailBase + 0xe004` to the last byte of the image.** Nothing
rounded, nothing left over. Inside a record, `0x10 + 99 × 29 = 0xb47` abuts the meta block with no
slack. `test/dn2song.test.ts` asserts both rather than trusting them, and asserts the seventeen
untouched records against a real project rather than against the constant derived from them.

| | |
|---|---|
| array offset | `tailBase + 0xe004` before OS 1.11, `+ 0xe204` from 1.11 |
| song 0 | `tailBase + 0xec04`, i.e. array record 1; `+ 0xee04` from 1.11 |
| song record | 3,072 bytes (`0xc00`) |
| records | 17 |
| songs the instrument names | 16 |
| rows per song | 99 |
| row | 29 bytes |

The offsets above hold for **project storage versions 2 and 3**: anything before OS 1.10E, and 1.10E
itself. **Version 5 is OS 1.11 and adds 512 to the base**; the record's interior is identical. Version
4 has never been seen on this family — it went 3 to 5 — and is refused rather than sorted onto the
nearer side.

---

## The song record

| offset | size | field |
|---|---|---|
| `+0x000` | 16 | **name**, latin-1, NUL-terminated; all zeros when unnamed |
| `+0x010` | 2,871 | **99 rows × 29 bytes** |
| `+0xb47` | 2 | **row count**, `u16be` — how many rows are in use |
| `+0xb49` | 1 | **end mode** — `0xff` LOOP, `0xfe` STOP |
| `+0xb4c` | 2 | **song tempo**, `u16be`, BPM × 120 |

`+0xb4a..b` were zero in every record seen, used or not. `+0xb47` was on that list until the row
count turned out to be two bytes wide; see the correction at the top.

The row count is the field the guard reads: 18, 1 and 2 were read off three songs before being
stated, which is what makes it certain rather than suggestive. `002 COREVAULT` adds a fourth, read
from a file rather than a capture: 23 rows, `END_STOP`, 120 BPM, and row 0 is pattern J4 playing four
times labelled INTRO at 138 BPM for 32 steps.

---

## The row — 29 bytes

| offset | size | field | notes |
|---|---|---|---|
| `+0` | 1 | **pattern** | slot, zero-based: 0 is A1 |
| `+1` | 1 | **repeats − 1** | **zero-based** — 0 means the row plays once |
| `+2` | 1 | **label** | index into the table below |
| `+3` | 2 | — | zero in every row seen |
| `+5` | 2 | **tempo** | `u16be`, BPM × 120 |
| `+7` | 2 | **mute mask** | `u16be`, bit *n* mutes track *n+1* |
| `+9` | 2 | **length** | `u16be`, sequencer steps |
| `+11` | 16 | — | zero in every row seen |
| `+27` | 1 | **swing** | percent **minus 50**, so 0 is 50% and 30 is 80% |
| `+28` | 1 | — | zero in every row seen |

**`+3..4`, `+11..26` and `+28` are not claimed to be padding.** Nothing observed has set them, which
is a statement about the captures rather than about the format. `rawRow` hands the bytes back.

`+27` was on that list until a capture varied swing. That is the pattern to expect: these bytes fall
one at a time, as somebody thinks to change the right control.

Row length matched the patterns' own lengths — 128, 63, 256, then 2 — confirming the manual's "the
default value is the same as the pattern length".

### Swing

Per row, always — the manual is explicit that swing is never song-wide, unlike tempo. Stored as
**percent minus 50**: a row set to 57% read `7`, and one set to the maximum 80% read `30`. The
manual's 50-80 range closes exactly onto a single byte of 0..30, so the offset is measured rather
than fitted.

### The tempo encoding is shared with the Digitone 1

Both families store tempo as `u16be` BPM × 120: the DN1 at `+0x838` of its 2,560-byte record, the DN2
at `+0xb4c` of its 3,072-byte one. Different geometry, same idea — a small independent sign that both
were read correctly.

**× 120 is measured, not fitted.** Every tempo in the first captures was a round number, and a round
number cannot tell × 120 from × 100 or × 10. So one row was set to **135.1**, which read **16,212** —
135.1 × 120 exactly. The device's 0.1 BPM step moves the raw value by 12.

---

## Labels — 21 values, all measured

| | | | | | |
|---|---|---|---|---|---|
| `0` | (EMPTY) | `7` | SOLO | `14` | NOISE |
| `1` | (PTN NAME) | `8` | FILL | `15` | FX |
| `2` | INTRO | `9` | RISE | `16` | **FADE** |
| `3` | OUTRO | `10` | PEAK | `17` | MISC |
| `4` | BRIDGE | `11` | DROP | `18` | TEST |
| `5` | CHORUS | `12` | BREAK | `19` | PAUSE |
| `6` | VERSE | `13` | JAM | `20` | OTHER |

`(EMPTY)` and `(PTN NAME)` are the device's own parenthesised entries, not free text; a row labelled
`(PTN NAME)` shows the pattern's name.

> **The gap that was not a gap.** A first walk of the device's label list produced 2–15 and 17–20 and
> never landed on 16, and it was recorded as reserved. It is **FADE**, which the walk had missed.
> *An absence in a hand-made capture is evidence about the capture, not about the format* — the same
> mistake as reading a silence on the wire as a refusal.

The capture also validated itself: OTHER was used on two rows and both read `20`, MISC on two rows
and both read `17`. Repeated values that agree are a free consistency check and worth building into
future captures on purpose.

---

## Outside the table

**`tailBase + 0xde12`** — one byte, the **selected song index**, zero-based. It read 0 with one song,
1 after a second was created, 2 after a third, and returned to 0 when song 1 was edited again.

Now that the array is known to begin at `0xe004`, this sits 514 bytes ahead of it rather than
comfortably outside it. It is read only on a version 2 or 3 project and only to choose which song tab
opens first, so a wrong answer costs a wrong default tab.

---

## What this unblocks immediately

`librarian/device.ts` has a song guard because **a song row names a pattern by slot** — precisely the
reference a rearrangement invalidates. It returned `unknown` for the Digitone II for as long as it
existed, so the manager had to assume the worst on the machine it cares most about.

It is now real: `DN2.songState` reads each record's declared row count, and a project with no rows
anywhere is one a rearrangement cannot desync.

## What is still open

- **A populated song on OS 1.11.** The array's base is settled on 32 empty records across two clean
  captures, and the record's interior provably did not move — but no 1.11 project anywhere has a song
  in it, so a *row* has never been read at the new base. `T50` on the test sheet is one save.
- **What record 0 is for.** A working copy, a seventeenth slot, or something else. It reads as an
  untouched song in every pre-1.11 project and as **all zeros, tempo included**, in every 1.11 one,
  which is one more thing nothing explains about it.
- **What OS 1.12 did.** Released 30 September 2026, Outbox 8 routing only, no documented format
  change. The Outbox block reserves 512 bytes and used 304, so new settings most likely fill the
  reserve and move nothing. Unmeasured.
- **Whether `0xde12` is still the selected song on 1.11.** Unanswerable from files: every project
  available reads 0 there on both firmwares.
- **Writing.** Nothing here has been written back to an instrument. A song edit cannot go over the
  dump protocol at all — the tail is not transmittable — so it needs a whole-project +Drive write.
- **`+3..4` and `+11..28`** of a row, and `+0xb47` / `+0xb4a..b` of a record.
- **`+3..4`, `+11..26` and `+28`** of a row, and `+0xb47` / `+0xb4a..b` of a record — 19 bytes of the
  29-byte row remain unexplained, though every field the song editor exposes is now accounted for.
