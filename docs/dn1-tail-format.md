# Digitone 1 project tail — the 55,552 bytes after the sound pool

Reverse-engineered from the 53 DN1 projects in `00_Examples/01_DN1/01_Projects/`
(firmware `1.42A`), cross-checked against the 9 matched Digitone II conversions in
`00_Examples/02_DN2/01_Projects/`.

This document covers the region `docs/dn1-project-format.md` §6.3 left as *"UNKNOWN — the
55,552-byte remainder"*. Everything before it (header, 128 patterns, 128 kits, the
128-slot sound pool) is already decoded in `packages/core/src/project/dn1.ts`.

| Tag | Meaning |
|---|---|
| **VERIFIED** | Checked programmatically over all 53 decompressed images with no counterexample. The check is stated inline. |
| **INFERRED** | Follows from verified facts plus one stated assumption. |
| **SPECULATIVE** | A plausible reading of the bytes. Do not write code that depends on it. |
| **UNKNOWN** | Explicitly not established. Listed so nobody re-derives a dead end. |

---

## 0. The answer: yes, the tail contains per-track references — two of them

**Short answer: YES. Two structures in the tail are indexed by track 0..7, and a
"rearrange" feature that moves a sound from track 2 to track 11 must account for both.**

| # | What | Where | Confidence |
|---|---|---|---|
| 1 | **8 × u8 per-track MIDI channel** | `0x299A1B` .. `0x299A22` (8 bytes) | **VERIFIED — very high** |
| 2 | **8 per-track bytes inside every song row** (position within the row unknown) | 17 songs × 99 rows, `0x29C800` onward | **VERIFIED that 8 per-track bytes exist; UNKNOWN where in the row** |

Plus one structure that *might* be per-track and cannot be resolved from this corpus:

| # | What | Where | Confidence |
|---|---|---|---|
| 3 | 1,024 × 11-byte slot array; `1024 = 8 × 128` and the 8 may be the track dimension | `0x299A45` .. `0x29C644` | **UNKNOWN — flagged as a risk** |

### Why I am confident about #1

Three independent lines of evidence:

1. **The default is the identity permutation.** In 52 of 53 projects the eight bytes read
   `00 01 02 03 04 05 06 07` — track *n* on MIDI channel *n*+1, which is the Digitone's
   factory default. An array whose default content is `0..N-1` is an array indexed by
   the thing it is counting.
2. **One project breaks the identity in a track-shaped way.**
   `026 DOOTHABEETHEE.dnprj` reads `FF FF FF FF 04 05 06 07` — the four **synth** tracks
   set to `0xFF` (this format's universal "none/off") and the four **MIDI** tracks left
   at channels 5-8. That is exactly what turning off MIDI reception on T1-T4 looks like,
   and it is impossible to produce from a non-per-track field.
3. **The DN1→DN2 conversion widens the array from 8 entries to 16.** All 9 DN1 projects
   that have a matched `.dn2prj` conversion put a byte-identical settings object in the
   DN2 tail at `0xC3E000`, with every neighbouring field preserved verbatim — and the
   array itself becomes `00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F`, 16 entries for
   the DN2's 16 tracks. 9/9 pairs. Nothing but a per-track array grows from 8 to 16 when
   the track count goes from 8 to 16.

**What would falsify #1:** a DN1 project whose eight bytes carry values that are not
MIDI-channel-shaped (0..15 or 0xFF), or a DN2 conversion whose array is not 16 long.
Neither occurs in the corpus.

### Why I am confident about #2 — and what is still missing

The song array geometry is forced by exact arithmetic on both device families:

|  | DN1 | DN2 |
|---|---|---|
| song record stride | 2,560 (`0xA00`) | 3,072 (`0xC00`) |
| song record count | 17 | 17 |
| array closes exactly on the object terminator | `0x2EFC + 17 × 2560 = 0xD8FC` ✓ | `0xE000 + 17 × 3072 = 0x1AC00` ✓ |
| row array starts at | record `+0x16` | record `+0x16` |
| `u16be` tempo at | record `+0x838` (2,104) | record `+0xB50` (2,896) |
| ⇒ row bytes available | 2,104 − 3 − 22 = 2,079 | 2,896 − 3 − 22 = 2,871 |
| ⇒ rows × row size | 99 × **21** | 99 × **29** |

Row size 21 on DN1 is **VERIFIED directly**, not just by division: `001 PRESETS.dnprj`
has an initialised song table and its marker bytes recur at exactly 21-byte spacing,
98 times per record, in all 17 records (1,666 = 17 × 98 occurrences). 2,079 / 21 = 99,
and 99 is the documented Elektron song-row maximum.

Row size 29 on DN2 then follows from 2,871 / 99 = 29 exactly. **A DN2 song row is
exactly 8 bytes longer than a DN1 song row, and the DN2 has exactly 8 more tracks.**
That is 13 shared bytes plus one byte per track.

**INFERRED:** those 8 bytes are the per-track mute mask for the row — the only per-track
quantity a song row carries on any Elektron sequencer, and one byte per track matches the
format's habit of spending a whole byte on a boolean (see the `0/1` flag run in §2).

**UNKNOWN — and this is the practical gap:** *where inside the 21-byte row* the 8 bytes
sit. Every song row in all 53 corpus projects is empty (see §5), so there is nothing to
correlate against. Do not guess. See §7 for what to do instead.

### What is *not* in the tail

Also useful, and checked:

- **No sound-pool slot references.** Nothing in the tail is populated with values that
  behave like pool indices. The only candidate (§4) is empty in 50 of 53 projects and its
  populated values are all multiples of 12, which reads as note numbers, not slot indices.
  **INFERRED:** the librarian's dependency resolution does not need to rewrite anything in
  the tail when copying patterns between projects.
- **No pattern-index arrays.** Exactly one byte in the whole 55,552-byte region holds a
  pattern index (§2, `+0x0B`), and it is a single "last selected pattern" scalar, not an
  arrangement.
- **No +Drive references, no file paths, no strings at all.** The region contains zero
  printable-ASCII runs of length ≥ 4 in any project.

---

## 1. Geometry

**VERIFIED** The tail region is `0x290200` .. `0x2A7204` (94,212 bytes). Its first
38,660 bytes are the sound pool already decoded by `readSoundPool`
(`u32be` version 5, then 128 × 302-byte sound objects). This document starts at
`0x290200 + 4 + 128 × 302 = 0x299904`.

> Note: an early sketch of this task quoted the remainder as starting at `0x2999C4`.
> That is off by 0xC0. `4 + 128 × 302 = 38,660 = 0x9704`, and `0x290200 + 0x9704 =
> 0x299904`. The correct base is confirmed by the last pool sound's `BA CE F0 0C`
> terminator landing on `0x299900`..`0x299903` in all 53 images.

**VERIFIED** The 55,552 bytes partition exactly, with no slack and no overlap. Every
boundary below is confirmed on all 53 images by `checkDn1Tail()` in
`packages/core/src/project/dn1tail.ts`, which reports zero problems corpus-wide.

| Offset | Size | Region | Varying bytes across the 53 projects |
|---|---:|---|---:|
| `0x299904` | 252 | zero fill | 0 |
| `0x299A00` | 69 | **project settings object** (§2) | 38 |
| `0x299A45` | 11,264 | **1,024 × 11-byte slot array** (§4) | 52 |
| `0x29C645` | 5 | zero fill | 0 |
| `0x29C64A` | 312 | **8 × 39-byte MIDI CC records** (§3) | 0 |
| `0x29C782` | 34 | zero fill | 0 |
| `0x29C7A4` | 92 | **mixer-ish block** (§6) | 59 |
| `0x29C800` | 43,520 | **17 × 2,560-byte song records** (§5) | 1,683 |
| `0x2A7200` | 4 | `BA CE F0 0C` object terminator | 0 |
| | **55,552** | | **1,832 (3.3%)** |

`252 + 69 + 11,264 + 5 + 312 + 34 + 92 + 43,520 + 4 = 55,552.`

**VERIFIED** From OS 1.43 the region is **56,064** bytes: 512 more, inserted at `0x29C800`
for the Outbox 8 CV configuration (§5.1). Every row above the song array keeps its offset;
the songs and the terminator move up by 512. `tailGeometry` in `packages/core/src/project/dn1tail.ts`
derives the two that move from the image's own length, so `TAIL` stays one table rather than
becoming two that can drift apart.

**VERIFIED** The region is one object *body*: it carries no `BE EF BA CE` magic anywhere,
but its last four bytes are the object terminator `BA CE F0 0C`. This is the same
convention the kit record uses (`docs/dn1-project-format.md` §8): sub-objects inside a
container are terminated but not magic-headed.

**VERIFIED** The whole region is overwhelmingly inert. A typical project has 1,287
non-zero bytes out of 55,552 (min 1,282, max 3,009), and only 1,832 byte positions ever
differ between any two of the 53 projects. Contrary to expectation there are **no long
`0xFF` runs** — this region's unset fill is `0x00`, with `0xFF` reserved for "this slot is
empty" markers inside the slot array.

**VERIFIED** `050 JAGGED.dnprj` and `052 JAGGED_PLAY.dnprj` — the near-identical pair —
differ in exactly **6 bytes** across the entire 55,552-byte region, all six inside the
69-byte settings object. That is a useful sanity anchor: almost nothing a user does in
normal use writes to this region.

---

## 2. Project settings object — `0x299A00`, 69 bytes

**VERIFIED** Offsets below are relative to `0x299A00`, which holds a `u32be` version
field of `7` in all 53 images (the same house style as the image header's 12, the
pattern/kit records' 10 and the sound pool's 5).

| Off | Size | Field | Values seen | Tag |
|---|---|---|---|---|
| `+0x00` | u32be | record version | `7` in all 53 (DN2: `1`) | VERIFIED |
| `+0x04` | u16be | **project tempo × 120** | 4,984 .. 20,769 ⇒ **41.5 .. 173.1 BPM** | VERIFIED |
| `+0x06` | u8 | flag | `0` (5), `1` (48) | UNKNOWN |
| `+0x07` | u8 | | `0`..`4`; always `0` after DN2 conversion | UNKNOWN |
| `+0x08` | u8 | | `0`..`9` | UNKNOWN |
| `+0x09` | u8 | | `0`..`3` | UNKNOWN |
| `+0x0A` | u8 | | `0` in all 53 | — |
| `+0x0B` | u8 | **last selected pattern index** | `0`..`97` | VERIFIED-strong |
| `+0x0C` | u8 | | `0` in all 53 | — |
| `+0x0D` | u8 | | `0`..`0xE0` | UNKNOWN |
| `+0x0E`..`+0x11` | 4 | | `0` in all 53 | — |
| `+0x12` | u8 | flag | `0` (50), `1` (3) | UNKNOWN |
| `+0x13` | u8 | | `3` in all 53 | — |
| `+0x14` | u8 | | `2` in all 53 | — |
| `+0x15` | u8 | | `0` (40), `1` (6), `2` (7) | UNKNOWN |
| `+0x16` | u8 | | `0x40` (50), `0x25`, `0x3A` | SPECULATIVE: a 0..127 level |
| `+0x17` | u8 | | `0` in all 53 | — |
| `+0x18` | u8 | | `0x40` in all 53 | — |
| `+0x19` | u8 | MIDI channel | `8` (51), `7` (2) | INFERRED |
| `+0x1A` | u8 | MIDI channel | `9` (42), `0`, `1`, `0x0A`, `0x0E` | INFERRED |
| **`+0x1B`** | **8 × u8** | **per-track MIDI channel** | `00..07` (52), `FF FF FF FF 04 05 06 07` (1) | **VERIFIED** |
| `+0x23`..`+0x25` | 3 × u8 | MIDI channel / off | `FF` mostly; `01`, `09`, `0F` seen | INFERRED |
| `+0x26`,`+0x27` | 2 | | `0` in all 53 | — |
| `+0x28`,`+0x29` | 2 × u8 | | `3` mostly; `1`, `2` seen | UNKNOWN |
| `+0x2A`..`+0x3E` | 21 × u8 | **boolean flag block** | every byte is `0` or `1` | INFERRED |
| `+0x3C` | u8 | | `4` (46), `6` (4), `7` (2), `0` (1) | UNKNOWN |
| `+0x3F` | u8 | | `1` in all 53 | — |
| `+0x40`..`+0x44` | 5 | | `0` in 52; `02` at `+0x44` in one | UNKNOWN |

### Tempo, VERIFIED

Same encoding as the per-pattern tempo (`docs/dn1-project-format.md` §3): `u16be`,
BPM × 120. Every one of the 53 values lands in 41.5..173.1 BPM, inside the DN1's
30..300 range, and the DN1→DN2 conversion copies the two bytes verbatim in all 9 pairs.
This is the **project** tempo, not a pattern tempo: it equals pattern 0's tempo in only a
minority of projects.

### Last selected pattern, VERIFIED-strong

`+0x0B` holds a value < 128 that is a pattern the project actually uses (has trigs, a kit
name, or a pattern name) in **53 of 53** projects, and in **35 of 35** projects where the
value is non-zero. The baseline probability of a uniform `0..127` draw landing in a
project's used set is 7.5%, so 35/35 is decisive. `050 JAGGED` reads 20 and
`052 JAGGED_PLAY` reads 48 — both used patterns in their respective projects, and one of
the six bytes that differ between that near-identical pair.

**INFERRED** it is the pattern the user was on when the project was saved.

### The per-track MIDI channel array, VERIFIED

```
0x299A1B  8 x u8   MIDI channel per track, 0..15, or 0xFF = off
                   track order 0..7 = T1 T2 T3 T4 MIDI-A MIDI-B MIDI-C MIDI-D
```

Evidence is in §0. `+0x19`, `+0x1A` and `+0x23`..`+0x25` are five more channel-shaped
bytes bracketing the array; the Digitone's CHANNELS page also carries FX-control, auto,
and program-change-in/out channels, so **INFERRED** those five are those settings, but
the individual assignment is **UNKNOWN**. The DN1→DN2 conversion preserves `+0x1A`
verbatim (`09→09`, and `0A→0A` for the two projects that moved it) while dropping
`+0x19`, so `+0x1A` is a setting both devices have and `+0x19` is not.

### DN1 ↔ DN2 correspondence, VERIFIED on all 9 matched pairs

The DN2 puts the same object at DN2-tail `0xDE00` (absolute `0xC3E000`), version `1`:

```
DN1  ver | tempo | 6 bytes | 6 pad  | 03 02 02 40 00 40 | 08 09 | 8 channels  | ff ff ff | ...
DN2  ver | tempo | 6 bytes | 10 pad | 03 02 02 40 00 40 |    09 | 16 channels | 00 ff ff | ...
```

Every field either survives byte-identically or widens 8→16. This is the strongest single
piece of evidence in the whole document.

---

## 3. MIDI CC records — `0x29C64A`, 8 × 39 bytes

**VERIFIED geometry.** Eight 39-byte records, byte-identical in all 53 projects:

```
+0x00  FF 04
+0x02  46 47 48 49 4A 4B 4C 4D 4E 4F 50 51 52 53 54 55   16 ascending CC numbers, 70..85
+0x12  16 x 00
+0x22  02 02 00 02 00
```

**SPECULATIVE** a default CC-assignment table, one record per track — eight records and
eight tracks. **This is not established**: the alternative framing (nine 39-byte records
starting five bytes earlier at `0x29C645`, which also closes exactly on `0x29C7A4`) fits
the bytes equally well and would make the count nine, not eight. The corpus cannot
distinguish them because the region never varies.

**Practically irrelevant either way:** all eight records are byte-identical, so permuting
them is a no-op. A rearrange feature can ignore this region — but must copy it verbatim.

The DN2 has no equivalent: the `02 02 00 02 00 FF 04` signature does not appear anywhere
in any of the 9 DN2 tails.

---

## 4. The 1,024-slot array — `0x299A45`, 1,024 × 11 bytes  ⚠ RISK

**VERIFIED geometry.** 1,024 records of 11 bytes, `11,264 = 0x2C00` bytes, closing
exactly on the next region. An unused record is `FF` followed by ten `00`.

**VERIFIED occupancy.** 50 of the 53 projects have **every** slot empty. The other three:

| Project | Occupied slots | Contents |
|---|---|---|
| `001 PRESETS` | 0, 1, 2, 3, 4, 128, 256, 384 | see below |
| `043 GLITCH_EXPLORE` | 0 | `24 0F 02 FF 24 01 00 01 00 00 00` |
| `049 JAM` | 0 | `18 0F 02 00 18 01 00 01 00 00 00` |

```
001 PRESETS
  slot   0  00 0C 02 FF 3C 01 0A 01 00 00 00
  slot   1  30 0B 02 00 30 01 FF 00 00 00 00
  slot   2  3C 0B 02 01 3C 01 FF 00 00 00 00
  slot   3  48 0B 02 02 48 01 FF 00 00 00 00
  slot   4  54 2B 02 FF 54 01 FF 00 00 00 00
  slot 128  30 4F 02 FF 30 00 00 01 00 00 00
  slot 256  30 4F 02 FF 48 00 50 01 00 00 00
  slot 384  30 24 01 00 01 00 00 00 00 00 00
```

**SPECULATIVE readings.** Byte `+0` and byte `+4` are usually equal and take values
`0x00, 0x18, 0x24, 0x30, 0x3C, 0x48, 0x54` — all multiples of 12, i.e. C1..C6 as MIDI
note numbers. Byte `+3` on slots 1, 2, 3 holds 0, 1, 2 — the index of the preceding
occupied slot — which reads as a linked-list `prev` pointer.

**UNKNOWN** what the array is for. No DN1 feature obviously wants 1,024 eleven-byte
note-bearing records, and there is no DN2 counterpart to compare against.

### The risk

`1,024 = 8 × 128`, and **the occupied slots fall on multiples of 128**. Two readings fit:

- **8 groups of 128** — the outer index is the track. `001 PRESETS` then uses groups
  0, 1, 2, 3 = the four synth tracks, with nothing in groups 4-7 = the four MIDI tracks.
  That is a coherent story. **Under this reading the array is per-track and a rearrange
  must permute the 1,408-byte groups.**
- **128 groups of 8** — the outer index is the pattern. `001 PRESETS` then uses patterns
  0, 16, 32, 48 = the first pattern of banks A, B, C, D, with 5 sub-entries in pattern 0.
  Equally coherent.

The corpus cannot separate them: only three projects have any data at all, and two of
those have a single record at slot 0, which is index 0 under both readings.

**Recommendation:** treat the array as opaque and copy it verbatim. Before running a
rearrange, check whether every slot is empty (it is in 50/53 projects, including all
9 that have DN2 conversions). If any slot is occupied, refuse or warn — do not guess a
permutation.

---

## 5. Song array — `0x29C800`, 17 × 2,560 bytes

**VERIFIED geometry**, on all 53 DN1 images and all 9 DN2 images:

```
0x29C800 + 2560*k, k = 0..16          17 song records
0x29C800 + 17*2560 = 0x2A7200         the object terminator, exactly
```

Per record, offsets relative to the record start:

| Off | Size | Field | Tag |
|---|---|---|---|
| `+0x000` | u32be | record version — `1` in all 53×17 DN1 records, and in a 1.43 save (`0` in all DN2 records) | VERIFIED |
| `+0x004` | 18 | zero in all 53×17 | VERIFIED |
| `+0x016` | **99 × 21** | **song rows** — see below | VERIFIED |
| `+0x835` | u8 | flag: `0` in 900 of 901 records; `0xFF` in `001 PRESETS` (all 17) and `008 TEST-1` (record 0) | VERIFIED |
| `+0x836`,`+0x837` | 2 | zero in all 53×17 | VERIFIED |
| `+0x838` | u16be | **song tempo × 120** — `14400` = 120.0 BPM in all 53×17 | VERIFIED |
| `+0x83A` | 454 | zero in all 53×17 | VERIFIED |

`0x16 + 99 × 21 + 3 = 0x838`. The row array ends exactly where the flag byte begins.

**INFERRED** 17 records = the DN1's 16 songs plus one extra slot (a scratch/current-song
buffer is the obvious candidate, but this is **SPECULATIVE**). The DN2 also has exactly
17, at stride 3,072.

### 5.1 The Outbox 8 CV block — `0x29C800`, 512 bytes, from OS 1.43

**VERIFIED** OS 1.43 puts a 512-byte block exactly where the song array used to start, and
moves the songs and the terminator along by 512. Read at the old offset, a 1.43 image's first
"song record" is the tail of this block and its version field reads `0` rather than `1`, which
is what `checkDn1Tail` catches.

**VERIFIED** 105 of the 512 bytes are non-zero in the measured project, and the shape is
regular: one 22-byte record repeated **8 times**, then 8 × `3F FF`, plus a lone `08` at `+27`.

```
+01b  08
+060  00 00 3c 00 00 48 03 e8 00 00 00 13 88 00 46 63 00 13 88 00 00 06   x8
+106  3f ff  x8
```

**INFERRED, from the firmware image** It is `BOB::bobConfigStorage_v0_t`, the Outbox 8 CV
configuration, initialised by `0x40015b44` with a stride of 22 over 8 items: 304 bytes used of
the 512. The 8 records are the Outbox's **8 CV outputs**, not the 8 tracks. Its editor,
`BreakOutBoxEditMenuView`, offers CV ZERO LEVEL, CV MAX LEVEL, INVERT POLARITY, SEND MIDI,
SUSTAIN, SOSTENUTO, EXPRESSION LEARN, REVERSE DIRECTION, PORT A and PORT B, formatted as
`%d.%03d`, which reads the defaults off directly: `0x1388` is 5.000 and `0x3E8` is 1.000, so
5 V maximum and 1 V per octave, and `0x3C`/`0x48` are notes 60 and 72, a C4 to C5 range.

**UNKNOWN** `0x4663`, and the 208 bytes the `_v0_t` suffix suggests a later release will fill.

**No accessor is provided**, for the same reason as the song row and the mixer block. `BOB_CONFIG`
in `packages/core/src/project/dn1tail.ts` names the block and its size so the geometry can step over it; the
bytes round-trip verbatim.

### Song rows — 99 × 21 bytes at `+0x16`

**VERIFIED** row size 21 and row count 99. Row size comes directly from `001 PRESETS`,
the only project with an initialised song table: its rows carry a `01` in byte `+0` at
exactly 21-byte spacing, 98 times in each of the 17 records (1,666 = 17 × 98
occurrences; the 99th row is the one left at `00`). Row count then follows from
`2,079 / 21 = 99`, which matches the documented Elektron 99-row song limit.

**VERIFIED** every song row in all 53 projects is otherwise empty. Across
53 × 17 × 99 = 89,199 rows, **not one byte outside `+0` is ever non-zero**, and `+0` is
only ever `0` or `1`. Nobody in this corpus ever built a song.

**INFERRED, strongly:** 8 of the 21 bytes are per-track. See §0 — the DN2 row is
29 bytes for 16 tracks, exactly 8 more for exactly 8 more tracks.

**UNKNOWN:** which 8 of the 21, what the other 13 are, and where the pattern index sits.
The corpus contains no populated row to correlate against, and no amount of further
analysis of these files will produce one. Resolving this needs a hardware capture: build
a two-row song on a DN1 with distinct patterns and distinct per-track mutes, save, and
diff.

---

## 6. Mixer-ish block — `0x29C7A4`, 92 bytes

**VERIFIED** starts with the constant marker `11 30` in all 53 images, and with the same
marker at the equivalent position in all 9 DN2 tails (DN2-tail `0xDEEC`, where the block
is 276 bytes rather than 92).

**SPECULATIVE** contents. The default in 44 of 53 projects is:

```
+0x00  11 30 00 00
+0x04  64 00 64 00 64 00 64 00     4 x u16le = 100, 100, 100, 100
+0x0C  80 bytes of zero
```

Four values of 100 matches the four synth-track levels stored in the kit record
(`docs/dn1-project-format.md` §8). `053 TECNO_EXP` extends the run to six 100s followed
by two `0x0040` (64) — which would be eight values, i.e. one per track — but three other
projects show `0x0040 0x0040` at `+0x10` with the four 100s unchanged, so the array
length is **not** established.

**Careful — this block contains uncleared residue.** Five projects (`008 TEST-1`,
`009 BLUEISH`, `012 KNOCK-OUT`, `013 CRAZARP`, `014 QUEREMOS-CLASSI`, `051 ODD XS`) carry
byte patterns like `41 34 DB C8 41 9E 48 F0` in `+0x10`..`+0x4F`, which decode as
IEEE-754 big-endian floats (11.30, 19.79) and are **identical between unrelated
projects**. That is leftover heap, not data. Do not read fields out of that range.

---

## 7. What a "rearrange" feature must do

Ordered by how much it matters.

1. **Permute the 8 bytes at `0x299A1B`.** If track 2's sound moves to track 11, track 2's
   MIDI channel byte must move with it, or the rearranged project will listen to the wrong
   channel on both tracks. This is the one confirmed, actionable per-track reference in
   the tail. (On DN1 there are only 8 tracks, so "track 11" means this matters for the
   DN1→DN2 expansion path, where the DN2's 16-entry array at `0xC3E000 + 0x1C` is the
   thing to fill.)
2. **Guard on song rows.** Every song row in the corpus is empty, so in practice there is
   nothing to permute. But the row *does* carry 8 per-track bytes, and their position is
   unknown. Detect a non-empty song table — any byte other than row byte `+0`, or row
   byte `+0` outside `{0, 1}` — and refuse the rearrange with a clear message rather than
   silently desyncing an arrangement. `isSongTableEmpty()` in `packages/core/src/project/dn1tail.ts`
   does exactly this check.
3. **Guard on the 1,024-slot array (§4).** Empty in 50 of 53 projects and in all 9 that
   have DN2 conversions. If occupied, refuse: the array *may* be per-track and we cannot
   tell.
4. **Copy everything else verbatim.** The CC records, the mixer block, the zero fills and
   the terminator are either constant across the whole corpus or carry no track index.

The `+0x0B` last-selected-pattern byte references a *pattern*, not a track, so a
rearrange leaves it alone — but a pattern-reordering feature would need to rewrite it.

---

## 8. What is still unknown

1. **Where the 8 per-track bytes sit inside a 21-byte song row**, and where the row's
   pattern index sits. Needs a hardware capture of a real song (§5).
2. **What the 1,024-slot array is** (§4) and whether its outer dimension is the track.
3. The purpose of the 9 non-constant settings bytes tagged UNKNOWN in §2 —
   `+0x06`, `+0x07`, `+0x08`, `+0x09`, `+0x0D`, `+0x12`, `+0x15`, `+0x16`, `+0x3C` — and
   the 21-byte boolean flag block at `+0x2A`, which is almost certainly the MIDI SYNC /
   PORT CONFIG page (`048 ORION_MIDI_TEST` sets the most of them, which is what a MIDI
   test project would do) but has not been mapped setting-by-setting.
4. Whether `+0x19`, `+0x1A` and `+0x23`..`+0x25` are FX-control / auto / program-change
   channels, and in what order.
5. The mixer block's array length (§6).
6. Whether the 39-byte CC records number 8 or 9 (§3). Harmless either way.

---

## 9. Code

`packages/core/src/project/dn1tail.ts` implements the readers and `checkDn1Tail()`, which re-runs every
**VERIFIED** claim in this document. It reports zero problems on all 53 corpus images.

```ts
import { readFileSync } from "node:fs";
import { parseProject } from "./src/project/container.js";
import { decodeProjectImage } from "./src/project/dn2codec.js";
import {
  checkDn1Tail, readProjectSettings, readSongs, isSongTableEmpty, isSlotArrayEmpty,
} from "./src/project/dn1tail.js";

const project = parseProject(new Uint8Array(readFileSync("050 JAGGED.dnprj")));
const { image } = decodeProjectImage(project.payload.raw);

checkDn1Tail(image);          // { ok: true, problems: [] } on all 53, and on a 1.43 save
readProjectSettings(image);   // tempo, trackMidiChannels[8], lastPatternIndex, ...
readSongs(image);             // 17 songs, each with tempo and 99 raw 21-byte rows
isSongTableEmpty(image);      // true on all 53 — the rearrange guard
isSlotArrayEmpty(image);      // true on 50 of 53
```

No accessor is provided for the song row's internal fields, the slot array's fields, or
the mixer block. Those are **UNKNOWN** and shipping a guessed accessor for bytes that get
written to real hardware would be worse than shipping nothing.
