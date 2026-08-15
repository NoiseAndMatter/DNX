# The Digitone II song table — **[verified]** 2026-08-15

16 arrangements, in the last 49,152 bytes of the image. Established by differential capture on
hardware; every field below was stated by a person before it was read, and each one matched.

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

---

## Geometry, and it closes exactly

**16 × 3,072 = 49,152 bytes, from `tailBase + 0xec04` to the last byte of the image.** Nothing
rounded, nothing left over. Inside a record, `0x10 + 99 × 29 = 0xb47` abuts the trailer with no slack.
`test/dn2song.test.ts` asserts both rather than trusting them: if any of the numbers were wrong,
neither sum would land.

| | |
|---|---|
| table offset | `tailBase + 0xec04` |
| song record | 3,072 bytes (`0xc00`) |
| songs | 16 |
| rows per song | 99 |
| row | 29 bytes |

---

## The song record

| offset | size | field |
|---|---|---|
| `+0x000` | 16 | **name**, latin-1, NUL-terminated; all zeros when unnamed |
| `+0x010` | 2,871 | **99 rows × 29 bytes** |
| `+0xb48` | 1 | **row count** — how many rows are in use |
| `+0xb49` | 1 | **end mode** — `0xff` LOOP, `0xfe` STOP |
| `+0xb4c` | 2 | **song tempo**, `u16be`, BPM × 120 |

`+0xb47` and `+0xb4a..b` were zero in every record seen, used or not.

The row count is the field the guard reads: 18, 1 and 2 were read off three songs before being
stated, which is what makes it certain rather than suggestive.

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
| `+11` | 18 | — | zero in every row seen |

**`+3..4` and `+11..28` are not claimed to be padding.** Nothing observed has set them, which is a
statement about the captures rather than about the format. `rawRow` hands the bytes back.

Row length matched the patterns' own lengths — 128, 63, 256, then 2 — confirming the manual's "the
default value is the same as the pattern length".

### The tempo encoding is shared with the Digitone 1

Both families store tempo as `u16be` BPM × 120: the DN1 at `+0x838` of its 2,560-byte record, the DN2
at `+0xb4c` of its 3,072-byte one. Different geometry, same idea — a small independent sign that both
were read correctly.

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

---

## What this unblocks immediately

`librarian/device.ts` has a song guard because **a song row names a pattern by slot** — precisely the
reference a rearrangement invalidates. It returned `unknown` for the Digitone II for as long as it
existed, so the manager had to assume the worst on the machine it cares most about.

It is now real: `DN2.songState` reads each record's declared row count, and a project with no rows
anywhere is one a rearrangement cannot desync.

## What is still open

- **Writing.** Nothing here has been written back to an instrument. A song edit cannot go over the
  dump protocol at all — the tail is not transmittable — so it needs a whole-project +Drive write.
- **`+3..4` and `+11..28`** of a row, and `+0xb47` / `+0xb4a..b` of a record.
- **Swing**, which the manual says is always per row. Nothing in the captures varied it.
