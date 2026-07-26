# Digitone II pattern record

The 89,088-byte pattern record: tracks, trigs, sound locks, parameter locks, metadata.

Companion to `docs/dn2-format.md` (container, image geometry, kit record) and
`docs/dn1-project-format.md` (the DN1 equivalents). Implementation:
`src/project/dn2pattern.ts`. Cross-validation: `test/dn2pattern.test.ts`.

Every claim below carries a status tag:

- **VERIFIED** — checked programmatically against the whole corpus, evidence stated inline.
- **INFERRED** — follows from verified facts plus one stated assumption.
- **SPECULATIVE** — a plausible reading of the bytes, not tested. Do not build on it.
- **UNKNOWN** — the bytes are located and their behaviour bounded, but not explained.

## Corpora

| Corpus | Size | What it proves |
|---|---|---|
| **Matched pairs** — nine DN1 `.dnprj` projects and Elektron's own DN2 conversions of them | 1,152 pattern pairs, 7,713 trigs, 2,131 sound locks, 392 lock records, 544 chord notes | Semantics. `dn1.readPattern` already decodes the DN1 side exactly, so the correct answer is known before looking at the DN2 bytes. |
| **Single-variable SysEx captures** — `emnyeca/digitone-syx-toolkit`, 419 native DN2 pattern dumps in 34 folders | 419 records | Field locations, native defaults, and what the *device* writes as opposed to what the *importer* writes. |

A SysEx pattern payload maps onto the project with no offset translation:

```
sysex pattern payload (99,840) = project pattern record (89,088) ++ project kit record (10,752)
```

so an offset established in one corpus is the same offset in the other. Totals below of
"1,571 records" mean 1,152 project records plus 419 captures.

---

## 1. Record geometry — VERIFIED

| Offset | Size | Count | Stride | Contents |
|---|---|---|---|---|
| `0x00000` | 4 | 1 | — | u32be record version, **3** in all 1,571 records |
| `0x00004` | 18,992 | 16 | **1,187** | track records |
| `0x04A34` | 49,152 | 8,192 | **6** | trigger slots |
| `0x10A34` | 20,640 | 80 | **258** | parameter-lock records |
| `0x15AD4` | 44 | 1 | — | pattern metadata |
| `0x15B00` | 256 | — | — | `0xFF` padding to the end of the record |

The three array bases were found independently — the track base and stride from the
`40 40 40` marker recurring 16 times at 1,187-byte spacing, the trigger base from the
SysEx corpus, the lock base by hunting known DN1 lock values inside a DN2 conversion — and
then each array's end landed exactly on the next array's start:

```
0x0004 + 16 × 1187 = 0x4A34      0x4A34 + 8192 × 6 = 0x10A34      0x10A34 + 80 × 258 = 0x15AD4
```

Three independent closures with zero slack. The 80-record lock capacity is the same as the
DN1's; the 258-byte record is the DN1's 130-byte record widened from 64 to 128 steps.

Both `0x4A34` and `0x10A34` are also confirmed structurally: in
`captures/BASE/BASE_EMPTY.syx` the run `0x004A34 .. 0x010A36` is 49,154 consecutive `0xFF`
bytes — the whole trigger array plus the first lock header — and the 80 × 258 grid of
`FFFF` + 256 zero bytes that follows lands exactly on the name field.

---

## 2. Track record, 1,187 bytes

Offsets relative to the start of the track record (`0x0004 + 1187 × track`).

| Offset | Size | Field | Status |
|---|---|---|---|
| `+0x000` | 128 × u16be | step flag words, one per step | VERIFIED |
| `+0x100` | 128 × u8 | trig condition, primary family (`0xFF` = none) | INFERRED |
| `+0x180` | 128 × u8 | trig condition, second family (`0xFF` = none) | UNKNOWN |
| `+0x200` | 128 × u8 | per-trig probability, percent (`0xFF` = none) | INFERRED |
| `+0x280` | 128 × u8 | unidentified | UNKNOWN |
| `+0x300` | 128 × u8 | unidentified | UNKNOWN |
| `+0x380` | 128 × u8 | unidentified | UNKNOWN |
| `+0x400` | 128 × u8 | **sound lock**, pool index (`0xFF` = none) | VERIFIED |
| `+0x480` | 35 | track settings | partly VERIFIED, see §5 |

`0x480 + 35 = 1187`, so the block accounts for the record exactly.

The three arrays at `+0x280`, `+0x300` and `+0x380` are `0xFF` in **every byte of every
track of all 1,571 records**. They exist by arithmetic, not by observation.

### 2.1 Step flag words — VERIFIED

128 u16be words, one per step. Not the DN1's 32 u32be words holding two steps each.

Evidence: `Track_Step_State_Table` and `Trigger_Add_1_to_16` add exactly one trig at a
time; adding a trig on track 1 step 1 flips exactly the u16be at `track+0`, on step 16 the
u16be at `track+30`, on track 8 step 1 the u16be at `track7base+0`.

| Bit | Name | Meaning | Status |
|---|---|---|---|
| `0x0001` | `trig` | a trig of some kind occupies this step | VERIFIED |
| `0x0010` | `oddStep` | set on odd-numbered steps | see below |
| `0x0080` + `0x0100` | `note` | set together on a note trig, by device and importer alike | UNKNOWN individually |
| `0x0200` | `deviceNote` | set on a note trig by the device, never by the importer | UNKNOWN |
| `0x0800` | `lockTrig` | trigless "lock" trig: locks but no note | VERIFIED |
| `0x2000` | `untouched` | see below | UNKNOWN |

**`0x0001` — VERIFIED.** Across all 1,571 records, this bit is set on exactly the steps
that have a trigger slot, in both directions, with zero exceptions
(`checkDn2PatternRecord` asserts this).

**`0x0800` — VERIFIED.** All 1,517 DN1 trigless lock trigs (`hasNote=false`,
`isLockTrig=true`) became DN2 words `0x0801` (even step) or `0x0811` (odd step); no DN1
note trig ever produced this bit. 1,514 of the 1,517 also have `0xFF` in the note byte of
their trigger slot; the other three carry a stale note that their DN1 originals carry too
(see §8).

**Observed complete flag words.** The whole matched corpus produces only:

| Word | Meaning | Count |
|---|---|---|
| `0x0000` / `0x0010` | empty step, even / odd | ~2.6 M |
| `0x0181` / `0x0191` | note trig, even / odd (importer) | 3,618 / 2,575 |
| `0x0801` / `0x0811` | lock trig, even / odd (importer) | 731 / 786 |
| `0x0380` / `0x0390` | empty step, even / odd (device, some patterns) | 556 / 522 |
| `0x0381` / `0x0391` | note trig, even / odd (device) | 522 / 418 |
| `0x2000` | every step of an importer-untouched track | 589,824 |
| `0x6181`, `0x2381` | three records with high bits inherited verbatim from unusual DN1 flag words | 3 |

Masking away `0x0010`, `0x0200` and the top nibble leaves exactly two shapes: `0x0181` for
a note trig and `0x0801` for a lock trig. The test asserts this.

**`0x0010`.** Set on odd steps of every track the device wrote and of tracks 1-8 of an
import; clear on even steps. It is not needed to decode anything, and its purpose is
UNKNOWN — calling it a parity bit is a description, not an explanation.

**`0x2000`.** Present on every step of DN2 tracks 9-16 in a DN1 import — exactly the eight
tracks the importer never populated — and on no other track: 1,149 of 1,152 patterns show
it on tracks 9-16 only, the other three add track 3. Those tracks carry `0x2000` on both
parities and no `0x0010`. Best guess is "step never initialised", SPECULATIVE. It does not
affect trig detection.

**For writing:** the importer's shapes are proven to load on hardware — these DN2 files
*are* Elektron's own conversions. Use base `0x0000` / `0x0010` per parity, OR in `0x0181`
for a note trig or `0x0801` for a lock trig, and do **not** leave `0x2000` on a track you
populate. INFERRED for the write direction; untested on hardware.

### 2.2 Sound locks — VERIFIED

`+0x400 + step`, one u8 per step, `0xFF` = no lock, otherwise an index 0..127 into the
project's 128-slot sound pool at `tailBase + 10756` (see `src/project/soundmap.ts`).

This is the single most important field for the expander and it is the most strongly
verified one. All 2,131 sound locks in the matched corpus agree with the DN1 source
byte-for-byte, on the same track and the same step, with zero exceptions. It is the direct
analogue of the DN1's `track+0x380+step`, widened from 64 to 128 steps.

None of the 419 SysEx captures exercises a sound lock, so this field rests entirely on the
matched pairs — which is the stronger evidence anyway, since it comes with known answers.

### 2.3 Trig conditions and probability — INFERRED

DN1 trig conditions land in **three different arrays** depending on the condition's family.
Each affected trig writes exactly one array and leaves the other two at `0xFF`. Complete
observed mapping over the matched corpus (nothing else was ever seen):

| DN1 condition | DN2 array | DN2 value | Count |
|---|---|---|---|
| 6, 7, 8, 9, 10, 11, 12, 13, 15, 21 | `+0x200` | 19, 25, 33, 41, 50, 59, 67, 75, 87, 100 | 170 |
| 22 | `+0x180` | 1 | 240 |
| 23 | `+0x180` | 0 | 103 |
| 24 … 38, 40, 42 | `+0x100` | 0,1,2,3,4,5,8,9,10,12,14,16,18,20,22,26,30 | 736 |

The `+0x200` values are a **probability percentage stored literally** — VERIFIED on hardware
2026-07-26 by setting eight known percentages and reading the bytes back: 1 %, 13 %, 25 %,
50 %, 63 %, 75 %, 88 % and 99 % store as `0x01, 0x0D, 0x19, 0x32, 0x3F, 0x4B, 0x58, 0x63`,
which are exactly 1, 13, 25, 50, 63, 75, 88 and 99. No ladder, no table: the number on screen is
the number in the file.

### The `+0x100` code table — SOLVED on hardware, 2026-07-26

A single capture settled it: one pattern with a different condition on each of 28 steps, so
the step index names the code. `docs/dn2-capture-plan.md` §1 is the method.

| Code | Condition | Code | Condition |
|---|---|---|---|
| `0x00` | PRE | `0x01` | not PRE |
| `0x02` | NEI | `0x03` | not NEI |
| `0x04` | 1ST | `0x05` | not 1ST |
| `0x06` | LST | `0x07` | not LST |
| `0x08` | 1:2 | `0x09` | 2:2 |
| `0x0A` | 1:3 | `0x0B` | not 1:3 |
| `0x0C` | 2:3 | `0x0D` | not 2:3 |
| `0x0E` | 3:3 | `0x0F` | not 3:3 |
| `0x10` | 1:4 | `0x11` | not 1:4 |
| `0x16` | 4:4 | `0x17` | not 4:4 |
| `0x3C` | 1:8 | `0x3D` | not 1:8 |
| `0x4A` | 8:8 | `0x4B` | not 8:8 |

**Two rules generate the whole table.** Negation is **+1** — every positive condition is even
and its negation is the odd code above it. And the ratios are blocks: for a given `B`, the code
is `base(B) + 2 x (A - 1)`, with `base(2)=0x08, base(3)=0x0A, base(4)=0x10, base(5)=0x18,
base(6)=0x22, base(7)=0x2E, base(8)=0x3C`. Each block is `2B` codes long, so each base is the
previous plus twice its `B` — and the observed `1:8 = 0x3C`, `8:8 = 0x4A` confirm the arithmetic
across the largest block.

That also explains why the device offers no `not 1:2`: code `0x09` **is** the negation of `1:2`,
and the UI simply labels it `2:2`, because over a two-cycle those are the same rule. The code
space is uniform; only the labels collapse.

**The unobserved codes are therefore predicted, not measured** — `2:4 = 0x12`, `3:4 = 0x14`, and
all of `B` = 5, 6, 7. A later capture should spot-check one of them.

### `+0x180` is the FILL family — VERIFIED

`0x01` is FILL and `0x00` is not-FILL, which is why this array only ever held 0 and 1 across the
matched corpus. It also names the two DN1 conditions that fed it: DN1 22 is FILL, DN1 23 is
not-FILL.

**None of the 419 SysEx captures sets any of these three arrays**, so there is no
single-variable evidence at all — only the matched pairs. Treat the mapping table above as
the full extent of what is known and do not extrapolate to unlisted values.

---

## 3. Trigger slots — VERIFIED

8,192 slots of 6 bytes at `0x4A34`.

```
+0  u8   track    0..15;  0xFF marks the slot unused
+1  u8   step     0..127
+2  u8   note     MIDI note, or 0xFF on a trigless lock trig
+3  u8   velocity 0..127, or 0xFF to inherit the track default
+4  u8   noteLength       or 0xFF to inherit the track default
+5  i8   microTiming      signed; 0xFF is -1, NOT "unset"
```

Every byte is confirmed twice. Single-variable captures isolate each one
(`Pitch_Field` moves only `+2`, `Velocity_Field` only `+3`, `Length_Field` only `+4`,
`Track08_Chord_Trigger_Notes/21..26` only `+5`), and the matched pairs check all four
payload bytes against the DN1 for all 7,713 trigs.

The micro-timing byte deserves emphasis: capture `13_REPRESENTATIVE_E5_TIME_MINUS1`
sets it to `0xFF` for a time of −1, and `14_..._RETURN_TIME0` sets it back to `0x00`. So
`0xFF` here is a value, not a sentinel — unlike every other `0xFF` in the record.

### 3.1 Chords — VERIFIED

A chord is stored as **extra slots repeating the same `(track, step)`**, each carrying an
absolute MIDI note, placed immediately after the root. The root is first.

- Capture evidence: `Track08_Chord_Trigger_Notes` grows a chord one note at a time and
  each new note appears as the next slot with the same track and step, up to 16 notes.
- Matched-pair evidence: all 544 chord notes reconstruct the DN1's signed chord offsets.
- Chord slots copy the root's velocity, note length and micro timing verbatim — 544/544.

**One importer behaviour to know:** a DN1 chord offset of `0`, which would duplicate the
root note, is not re-emitted. `[-7, 0, 1]` becomes notes `[root, root-7, root+1]`. Seven
chord notes across seven trigs in the corpus are dropped this way.

### 3.2 Allocation and ordering — VERIFIED

The array is a **single global pool shared by all 16 tracks**, not per-track: 128 notes on
track 1 plus 1 on track 2 occupy slots 0..128 contiguously (`over_129_notes/03`).

**Slots are allocated in edit order and freed in place, leaving holes.** In
`order_compaction/4_step1deleded.syx`, slot 0 is `FF`-filled while slot 1 still holds a
live trig. So a reader must **scan all 8,192 slots and skip `0xFF`-headed ones**; stopping
at the first `0xFF` would silently drop trigs from a device-written pattern.
`readTrigSlots` does the full scan.

Scanning the whole array is safe: across all 1,571 records, every slot past the live set
has `0xFF` in its first byte — even in regions holding uncleared residue from an earlier
edit (some DN1 conversions leave what looks like a shifted copy of the track data in the
unused tail of the array, but never with a non-`FF` first byte).

Elektron's importer, unlike the device, writes a **dense prefix sorted by (track, step)**:
verified for all 1,152 converted patterns.

**Capacity 8,192 is INFERRED** from `(0x10A34 − 0x4A34) / 6`, and confirmed only as far as
144 used slots (`over_129_notes/04`). 16 tracks × 128 steps = 2,048 single-note trigs, so
the pool allows an average of four notes per step across a completely full pattern.

---

## 4. Parameter locks — VERIFIED

80 records of 258 bytes at `0x10A34`.

```
+0    u8         parameter id
+1    u8         track 0..15
+2    128 × (u8 coarse, u8 fine)   value per step; 0xFFFF = step not locked
```

**A lock slot is two bytes, and only some of them are a plain integer** — corrected on hardware
2026-07-26. For an ordinary 0-127 parameter the value sits in the **coarse** byte and the fine
byte is zero, which is why reading the pair as a little-endian integer worked for as long as
nothing with finer resolution was tested. For a parameter with fine resolution it does not: a
`u16le` read turns an LFO depth of `-1.00` into 32,575. Read the two bytes as `u16be` and split
them; `src/project/lockvalue.ts` does this and is the only place that should.

Swept across a 16-bit LFO depth of range -128 to +127.98 — pattern A3 of `DATA_CAPTURE.dn2prj`,
lock record 1, track 3, parameter 29:

| Set to | bytes | coarse × 256 + fine | `raw / 128 - 128` | |
|---|---|---|---|---|
| -128.00 | `00 00` | 0 | **-128.000** | exact |
| -64.00 | `20 00` | 8,192 | **-64.000** | exact |
| -1.00 | `3f 7f` | 16,255 | -1.008 | one tick out |
| -0.01 | `3f ff` | 16,383 | -0.008 | |
| 0.00 | — | — | — | no lock written |
| +0.01 | `40 01` | 16,385 | +0.008 | |
| +1.00 | `40 81` | 16,513 | +1.008 | one tick out |
| +60.00 | `5e 00` | 24,064 | **+60.000** | exact |
| +127.98 | `7f fe` | 32,766 | +127.984 | |

So the quantum is **1/128 = 0.0078**, displayed to two places as `0.01`, and the maximum is
`32766/128 - 128 = 127.984`, displayed `127.98`.

Three points land on the scale exactly, which is what pins it — those are the steps whose fine
byte is zero, so the device had no rounding to do. **The two `±1.00` steps sit one fine tick
further from zero than asked for.** That is 0.008, and it is recorded rather than modelled: the
same capture has the step labelled `+64.00` in the sheet reading `+60.00`, so encoder slips
demonstrably happened. Whether the device rounds outward at whole units, or the value was simply
entered one tick off, needs a second sweep to settle. Nothing depends on the answer — the
converter transfers both bytes untouched.

The step set to `0.00` produced **no lock record entry at all**. Setting a p-lock to the
parameter's current value appears not to create a lock, seen on two independent parameters in
this capture.

**Bipolar values are offset, not two's complement** — also VERIFIED here. A byte-sized bipolar
parameter stores `value + 64`, so -64 is `0x00` and +63 is `0x7F`. That answers a question worth
asking before writing p-locks: two's complement would have put -1 at `0xFFFF`, colliding with the
"step not locked" sentinel. Offset encoding never reaches it.

A record whose first u16le is `0xFFFF` is unused. In a native empty pattern the unused
records read `FF FF` followed by 256 zero bytes; DN1 conversions leave 128 zeros then 128
`0xFF`. Either way the header is the only reliable "unused" marker.

The table is a flat pool shared by all tracks, allocated from slot 0 upwards — the DN1
design, widened.

**Evidence.** 392 lock records across the matched corpus were compared to the DN1
originals. All 392 agree on track, on the exact set of locked steps, and on record
position in the table. 389 also agree on every value; the remaining three differ only in
value (17→25, 43→51 in one record, 71→89, 1→0 — six values in total), which is the
importer rescaling parameters whose range changed between the devices.

**Parameter ids are the DN2's own numbering and are NOT the DN1's.** The importer remaps
them through a stable one-to-one function; every mapping observed in the corpus:

```
2→2  4→6  8→14  10→18  16→30  17→33  18→34  19→35  20→36  21→37  22→38  23→39  24→40
25→41  30→46  34→50  50→73  51→74  52→75  53→76  54→78  55→79  60→87  61→89  62→90
63→91  64→104  65→95  66→96  67→94  68→93  69→92  71→99
```

The mapping from either numbering to a **named** synth parameter is UNKNOWN.

**They are not NRPN numbers.** Elektron's Appendix C gives each parameter an NRPN LSB, and the
DN2 ids 73-79, 89-96 and 104 resemble the SYN pages' NRPN block closely — both schemes allocate
eight consecutive numbers per page. But the same corpus locks ids 30-41, whose NRPN numbers are
audio-input mixer parameters that a converted DN1 project cannot have locked. Checked and
rejected 2026-07-26; `docs/dn2-capture-plan.md` §5 has the capture that would settle it
properly.

No record in the corpus locks a step above 63, because every source is a 64-step DN1
pattern. Steps 64..127 are structurally present and `0xFFFF`-filled — **INFERRED** that
they behave like steps 0..63.

---

## 5. Track settings, 35 bytes at `+0x480`

Native default (all 16 tracks of every capture):

```
3c 64 0e 07 80 00 40 40 40 0e 0c 40 00 10 00 02 64 05 ff 00 00 40 00 00 00 00 00 00 00 00 7f 00 7f 00 7f
```

| Offset | Field | Status | Evidence |
|---|---|---|---|
| `+0x00` | default note, `0x3C` (C5) | VERIFIED | equals DN1 `settings[2]` on all 9,216 importer-populated tracks |
| `+0x01` | default velocity, `0x64` (100) | VERIFIED | equals DN1 `settings[3]` on all 9,216 |
| `+0x02` | default note length, `0x0E` | INFERRED | equals DN1 `settings[4]` on all 9,216; the *name* is from position in the DN1 block, not proven |
| `+0x03` | `7` native / `6` on importer-touched tracks | UNKNOWN | exactly `6` on the 9,216 tracks the importer populated (9 × 128 × 8), `7` everywhere else |
| `+0x04` | constant `0x80` | UNKNOWN | 25,136/25,136 |
| `+0x05` | `0` | UNKNOWN | 4 values, 25,129 are `0` |
| `+0x06..08` | `40 40 40` native, `00 00 00` on every converted track | UNKNOWN | exactly two states, 6,704 native (419 × 16) vs 18,432 converted |
| `+0x09` | constant `0x0E` | UNKNOWN | |
| `+0x0A` | constant `0x0C` | UNKNOWN | |
| `+0x0B` | constant `0x40` | UNKNOWN | |
| `+0x0C` | constant `0x00` | UNKNOWN | possibly the high byte of the length below |
| **`+0x0D`** | **track length in steps, 1..128** | **VERIFIED** | `Per_Track_Length_T01` walks 2,3,4,8,15,17,32,33,64,128 and moves only this byte; matches the DN1 track length on all 9,216 importer-populated tracks |
| `+0x0E` | `0`, `0x64` in 14 tracks | UNKNOWN | |
| **`+0x0F`** | **track speed enum** | **VERIFIED** | `Per_Track_Speed_T01` walks all seven and moves only this byte; matches the DN1 speed on all 9,216 |
| `+0x10` | `0x64` (100) | SPECULATIVE: track level | 25,107/25,136 are `0x64` |
| `+0x11` | `5` native, `4` converted, rises to `6`/`7` | UNKNOWN | rose 5→6 when a chord reached 5 notes and fell back at 3 (`Track08_Chord…/06` and `/08`), so plausibly a voice count |
| `+0x12` | `0xFF` | UNKNOWN | |
| `+0x13`, `+0x14` | `0` | UNKNOWN | |
| `+0x15..0x22` | constants `40 00 00 00 00 00 00 00 00 00 7f 00 7f 00 7f` | UNKNOWN | never varies in 25,136 samples |

Speed enum (`+0x0F`, and the pattern-level speed at meta `+0x1A`) — VERIFIED, same codes
on DN1 and DN2:

| Code | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| Speed | 2× | 3/2× | **1× (default)** | 3/4× | 1/2× | 1/4× | 1/8× |

---

## 6. Pattern metadata, 44 bytes at `0x15AD4`

| Offset | Size | Field | Status |
|---|---|---|---|
| `+0x00` | 16 | **pattern name**, NUL-padded | VERIFIED |
| `+0x10`, `+0x11` | 2 | `00 00`. `+0x11` is a copy of DN1 `0x4735` — same relative offset, unanimous on 1,152 pairs; meaning still UNKNOWN | VERIFIED as a copy |
| `+0x12` | u16be | **tempo × 120** | VERIFIED |
| `+0x14` | u16be | **master pattern length**, 1..1024 | VERIFIED |
| `+0x16` | u16be | **pattern change length (CHNG)**, 1..1024, `1` = off | VERIFIED |
| `+0x18` | u8 | copy of DN1 `0x473C`, same relative offset, unanimous on 1,152 pairs; meaning UNKNOWN | VERIFIED as a copy |
| `+0x19` | u8 | **scale mode**: 0 = one length for the pattern, 1 = per-track | VERIFIED |
| `+0x1A` | u8 | **pattern speed**, same enum as the per-track speed | VERIFIED |
| `+0x1B` | u8 | constant `0` | UNKNOWN |
| `+0x1C` | u8 | **own slot index**, 0..127 | VERIFIED |
| `+0x1D` | u8 | constant `0xFF` | UNKNOWN |
| `+0x1E..0x20` | 3 | constant `0` | UNKNOWN |
| `+0x21` | u8 | `7` in all 1,152 project records, `1` in all 419 captures. The importer always writes 7, so a conversion must write it rather than inherit the template's 1 | UNKNOWN, but must be written |
| `+0x22` | u8 | constant `0` | UNKNOWN |
| `+0x23..0x2B` | 9 | constant `0xFF` | UNKNOWN |

**Name — VERIFIED and it is stored twice.** `Pattern_Name_Position` changes one character
at a time and each edit moves exactly two bytes: one at `0x15AD4 + n` and one at
`0x15C08 + n`. The second is the **kit record's name field** (kit `+8`), which is why the
name appears to have a "shadow": pattern and kit carry the same 16-byte string. Both
copies must be written.

**Tempo — VERIFIED**, same encoding as the DN1: u16be of `bpm × 120`. 120 BPM → `0x3840`
(14,400); 120.1 → `0x384C`; 300 → `0x8CA0`. Cross-checked against `readPattern`'s tempo on
all 1,152 pattern pairs.

**Master length — VERIFIED** by `Pattern_Wide`, which changes the pattern length and moves
this u16be together with `+0x0D` of all 16 track settings. Values 2, 3, 16, 33, 64, 128
observed; 1,024 reachable via the u16be.

**Both fields are pattern-level, and the device UI calls them RESET and CHNG.**
`Per_Track_Reset_T01` and `Per_Track_Change_T01` walk what the panel presents as per-track
settings while track 1 is selected, and each moves exactly one of these two pattern-level
u16be fields and nothing inside any track record: RESET → `+0x14` (2, 3, 4, 12, 17, 1024,
and `INF` → 1), CHNG → `+0x16` (2, 3, 4, 12, 16, 17, 1024, and `OFF` → 1). So a track cannot
carry its own reset or change length; only LEN (`settings+0x0D`) and speed
(`settings+0x0F`) are per track.

**Track length is written the same way on all 16 tracks — VERIFIED.**
`Per_Track_Field_Mapping_T01_T16/L_MSB_MAP_T{01..16}_LEN128` sets a length on each track in
turn, and every one moves exactly `settings+0x0D` of that track, including tracks 9-16 that
no Elektron import ever populates. Nothing accompanies it, and a length of 62 written this
way onto track 9 was confirmed on hardware.

**Change length — VERIFIED** by `Pattern_Change_Encoding_20260605` and
`Per_Track_Change_T01`, which walk 2, 3, 4, 12, 16, 17, 32, 64, 128, 256, 512, 1024 and
"OFF"; "OFF" stores `1`.

**Scale mode — VERIFIED** by `Track_Wide_Mode_Field` and `Per_Track_Length_T01`, both of
which toggle PER-PTN ↔ PER-TRK and move only this byte.

**Slot index — VERIFIED**: equals `readPattern(...).slotIndex` on all 1,152 pattern pairs,
including `ODD XS`, whose DN1 slot indices are scrambled (48, 1, 96, 96, 80, 1, 1, …) and
whose DN2 records reproduce the same scrambling.

---

## 6a. Kit FX offsets — mapped by capture, 2026-07-26

A device-authored pattern with a distinct value on every FX parameter placed the block. All
are single bytes at a stride of 2 from `kit+5810`, in page order:

| Offsets | Page | Parameters, in order |
|---|---|---|
| 5810-5822 | Chorus | DPTH, SPD, HPF, WDTH, DEL, REV, VOL |
| 5858-5880 | Input | see the external input page below |
| 5824-5838 | Delay | TIME, **ping-pong at 5826**, **WID at 5828**, FDBK, HPF, LPF, REV, VOL |
| 5842-5854 | Reverb | PRE, DEC, FREQ, GAIN, HPF, LPF, VOL |
| 5882-5898 | Compressor | THR, ATK, REL, MUP, RAT, **SCS at 5892**, **SCF at 5894**, DRY/CMP, VOL |

**Bipolar FX parameters are offset by 64**, the same as p-lock values: `WID` at -9 stored `0x37`
(55) and at -17 stored `0x2f` (47); `SCF` at -25 stored `0x27` (39).

**`kit+5898` is the compressor volume**, a plain 0-127 byte — 119 stored as `0x77`, default 100.
`kit+5899` is its **fine byte**, worth 1/256 each, and the device writes zero there in every
pattern of the capture. Same coarse/fine shape as a p-lock slot (§4) and as every other entry
in this stride-2 block.

That corrected the reading in `src/expand/fieldmap.ts`, which treated 5898/5899 as one `u16be`
rescaled by "roughly x201.57" — an artefact of reading two fields as one number. The bytes it
wrote were right, since the table came from the pairs Elektron actually produces.

**What Elektron's importer does to it.** DN1 `FX+0x34` (0-127) lands here rescaled, and with
the pair split correctly the rule is exact on all five observed inputs:

```
coarse.fine = min( floor(dn1 × 25600 / 127), 25599 ) / 256
```

| DN1 `FX+0x34` | 5898, 5899 | value | check |
|---|---|---|---|
| 64 | 50, 100 | 50.391 | `floor(12900.79)` = 12900 |
| 73 | 57, 122 | 57.477 | `floor(14714.96)` = 14714 |
| 94 | 74, 4 | 74.016 | `floor(18948.03)` = 18948 |
| 100 | 78, 189 | 78.738 | `floor(20157.48)` = 20157 |
| 127 | 99, 255 | 99.996 | `25600` clamped to 25599 |

A 0-127 source mapped onto a 0-100 scale, clamped one 1/256 step below 100.00. **Why** it lands
on a 0-100 scale is unexplained — the DN2 plainly accepts 119 here when a human sets it — so the
converter keeps a table of the five observed pairs rather than applying the formula. The formula
is recorded so a capture can confirm or break it.

Note the distribution: 1,008 of 1,024 sampled kits sit on the default 100, so this rests on four
non-default observations. The exact fit to 1/256 including the fine byte is what makes it more
than a correlation, but it is not the unanimous-across-the-corpus evidence most fields here have.

**`SCS` is a 19-entry enum** — COMP, NOT COMP, TR1 … TR16, INLR — numbered 0 to 18. Observed:
`INLR` stores 18. Only that one value has been seen, so the numbering rests on the device's
list plus a single reading.

**Ping-pong at `kit+5826` is a 0/1 toggle**, confirmed by a pattern pair differing only in it.

The table above is machine-readable in `src/project/kitfx.ts`, which the differential analyser
uses to name FX bytes instead of reporting them as "kit gap 5804-5963, unidentified".

### The external input page — mapped by a second capture, 2026-07-26

`5856-5881` was a page the first sheet missed entirely. `DATA_CAPTURE_MI.dn2prj` pattern A7 set
fifteen parameters to fifteen distinct values in one save; all fifteen bytes moved, none
collided, and the page fell out complete. It sits **between** the reverb and compressor pages,
so UI page order is not offset order.

| Offsets | Parameter |
|---|---|
| 5858 / 5860 | IN level, L / R |
| 5862 / 5864 | IN balance, L / R — bipolar, offset by 64 |
| 5866 / 5868 | IN chorus send, L / R |
| 5870 / 5872 | IN delay send, L / R |
| 5874 / 5876 | IN reverb send, L / R |
| 5878 | DUAL — 0 stereo, 1 dual mono |
| 5880 | master overdrive — **INFERRED**, see below |

**The layout is L/R pairs**, adjacent, parameter by parameter. Setting the device to DUAL splits
the UI page into an L page and an R page with identical parameters; the bytes were already
there either way, so DUAL is a display mode over a structure that always holds both channels.

**`IN R level` and `master overdrive` were both captured at 127**, so values alone could not
tell 5860 from 5880. The tie breaks on layout: balance and all three sends are adjacent L/R
pairs, so level is too, which makes 5858/5860 the pair and leaves 5880 as the overdrive. The
corpus agrees — across 2,176 kits 5880 takes 30 distinct values, 5860 only three, and a master
overdrive is a far more used control than a line-input right-channel level. Setting the
overdrive alone to a unique value would upgrade this to VERIFIED.

**The mixer page's chorus, delay and reverb levels are the FX pages' `VOL` bytes** — setting the
mixer level moved 5822, 5838 and 5854, which were already named. One parameter, two views.

**`kit+5856` is still unplaced**, constant `1` across all 2,176 kits sampled — UNKNOWN.

One hypothesis was raised and **rejected on 2026-07-26**: that it flags whether these pages are
per-pattern or global. The DN2 has no such setting. FX, mixer and compressor values live in the
pattern's kit unconditionally, which is precisely the structure the bytes show — one FX block
per kit, one kit per pattern. What the device offers instead is **Perform Kit** mode, which
makes them behave globally by *not reloading* the kit on a pattern change; that is runtime
state and leaves nothing in the file. Recorded because ruling a reading out is worth as much
as confirming one, and a byte that never moves invites this guess again.

**`5900-5956` is zero in all 2,176 kits** — 28 slots of nothing, immediately after the
compressor page. That is what reserved space looks like in this format, and it is a better
candidate for "room for later features" than any gap between pages.

### What the converter does not transfer

Auditing the copy table against these names, every copy now lands on a named parameter, and
thirteen named parameters have no copy at all (`test/fieldmap.test.ts` pins the set):

- **The whole compressor page** except `VOL` — THR, ATK, REL, MUP, RAT, SCS, SCF, DRY/CMP.
- **`chorus HPF`**.
- **`IN L level`, `IN R level`, `IN R reverb send`, `DUAL`** — note the asymmetry: the left
  reverb send transfers and the right does not, and the fine byte of `IN L level` transfers
  while its coarse byte does not. Those two look like defects rather than absent sources.

Whether each is a defect depends on whether the DN1 has the parameter at all. But every one is
a byte a non-default template leaks through, which is the failure mode `KNOWN-ISSUES.md` opens
with, so none should stay unexamined.

## 7. Synth vs MIDI tracks — VERIFIED, and it is not in the pattern record

The pattern record carries **no** per-track synth/MIDI discriminator. Every field of the
track record is populated identically for a DN1 synth track and a DN1 MIDI track, and the
kit allocates a sound slot *and* a MIDI record for all 16 tracks unconditionally.

The discriminator is a **u16be bitmask at kit offset 10,260** (`kitRecord + 10260`, i.e.
`0x15C00 + 10260` in a SysEx pattern payload). Bit *t* set means track *t* is a MIDI track.

Evidence: `0x00F0` — tracks 5-8, 1-based — in **all 1,152 kits of all nine DN1
conversions**, which is exactly right because a DN1 project is always four synth tracks
then four MIDI tracks; and `0x0000` in all 419 native captures, none of which has a MIDI
track configured.

The corpus therefore proves the field takes those two values in exactly the right
circumstances, but has never shown an arbitrary mask (e.g. one MIDI track in the middle).
That the mask is per-bit rather than, say, a count is **INFERRED** from the value `0x00F0`
being precisely bits 4..7.

**Confirmed by direct experiment, 2026-07-26.** Assigning a MIDI machine to track 3 of an
otherwise untouched project moved the mask from `0x0000` to `0x0004` — bit 2, track 3 — and
nothing else in the kit changed. The bit-per-track reading is no longer an inference.

`007 ORION_MIDI_TEST` independently corroborates the reading: its kit's MIDI records 5-8
carry edited data while 1-4 and 9-16 are at defaults, matching the mask.

---

## 8. Two importer quirks worth knowing

Both are asserted in the test suite so they cannot regress into silent bugs.

1. **Stale notes on trigless trigs.** Three trigs (`TECNO_EXP` patterns 33, 40, 41, track
   2, step 28) have the trigless flag `0x0801` *and* a note byte of 53. Their DN1
   originals have the same contradiction — DN1 flag `0x0002` with an uncleared note record
   — and the importer copied it faithfully. `hasNote` is therefore derived from the flag
   word, never from the note byte.
2. **Zero chord offsets are dropped**, §3.1.

---

## 9. What is still unknown

Ordered by how much it blocks writing a valid DN2 pattern.

1. **The three condition arrays' code tables** (§2.3). Probability is readable; the two
   condition families are located but their DN2 code → UI condition mapping is unknown,
   and no single-variable capture exercises them. Copying a DN1 trig's condition through
   the observed table is safe; inventing a code is not.
2. **Parameter id → named parameter** (§4), for both devices.
3. **Track settings `+0x03`, `+0x06..08`, `+0x11`** (§5) — the three fields where the
   importer's output differs from the device's default. Elektron's own conversions load on
   hardware with the importer's values, so copying them is safe; the meanings are unknown.
4. **The three unused per-track arrays** at `+0x280`, `+0x300`, `+0x380` (§2). `0xFF` in
   every byte of both corpora.
5. **Flag bits `0x0080`, `0x0100`, `0x0200`, `0x2000`** (§2.1).
6. **Meta `+0x11`, `+0x18`, `+0x21`** (§6).
7. **Trigger-slot capacity above 144** (§3.2) — the 8,192 figure is arithmetic.
8. **Lock-table steps 64..127** (§4) — structurally present, never exercised.
9. Whether the device rejects a pattern whose trigger slots are ordered differently from
   its own edit-order allocation. Writing a sorted, dense array matches what Elektron's
   importer produces, which is the safest available precedent, but is untested on hardware.

## 10. Code

| Symbol | Purpose |
|---|---|
| `readDn2Pattern(image, index)` | decode pattern `index` of a decompressed project image |
| `readDn2PatternRecord(record, index?, midiMask?)` | decode a bare 89,088-byte record (e.g. from SysEx) |
| `readTrigSlots(record)` | the raw 6-byte trigger slots, holes skipped |
| `readLockTable(record)` | the 80-record parameter-lock table, order preserved |
| `readTrackSettings(track)` | the 35-byte settings block, decoded and verbatim |
| `stepFlags(track, step)` / `soundLockAt(track, step)` | single-field accessors |
| `readMidiTrackMask(image, index)` / `midiTrackMaskOf(kit)` | the kit-side synth/MIDI mask |
| `checkDn2PatternRecord(record)` | assert the documented geometry; passes on all 1,571 records |

```ts
const project = parseProject(new Uint8Array(readFileSync(path)));
const { image } = decodeProjectImage(project.payload.raw);

const pattern = readDn2Pattern(image, 0);
pattern.name;                                  // "250319"
pattern.tempo;                                 // 40
pattern.tracks[0]!.trigs[1]!.note;             // 60
pattern.tracks[0]!.trigs[1]!.soundLock;        // 3
pattern.tracks[0]!.trigs[1]!.microTiming;      // -23
```

---

## 4a. Parameter-lock ids, by name — VERIFIED 2026-07-26

Named by a device-authored capture: 61 controls, each locked on its **own step** of one pattern
(`H1` of `MORNING_JA 1640.dn2prj`), so a record's single locked step identifies it by position.
47 records came back, every one with exactly one locked step. Implementation:
`src/project/plockparams.ts`.

### The LFO block is arithmetic, not a list

The three LFOs are **interleaved with a stride of 4**:

```
id = 4 * slot + lfo          slot 0..7 in page order, lfo 1..3

SPD   1  2  3        DEST  13 14 15        MODE  25 26 27
MULT  5  6  7        WAVE  17 18 19        DEP   29 30 31
FADE  9 10 11        SPH   21 22 23
```

All 24 ids fit with no exceptions. **`4 * slot + 0` is never used** — ids 0, 4, 8, 12, 16, 20,
24, 28 belong to no LFO — so the layout has room for a fourth. Whether that is reserved or
belongs to something else is UNKNOWN.

This independently confirms the A3 capture, where `DEP` read id 29, and settles the ambiguity
it left: **id 9 is `FADE`, not `VFAD`**, because `VFAD` produces no lock record at all.

### The rest

| Page | Ids |
|---|---|
| TRIG 2 | PORT 99, PTIM 100 |
| FLTR 2 | DEL 77, KEY.T 82, BASE 83, WDTH 84, RSET 85, BW.RT 105 |
| AMP | ATK 87, **HOLD 88***, DEC 89, SUS 90, REL 91, PAN 95, VOL 96, **MODE 97***, RSET 98 |
| FX | CHR 92, DEL 93, REV 94, BR 101, SRR 102, SR.RT 103, OVER 104, OD.RT 106 |

\* INFERRED, not observed. Both were skipped during the capture because `AMP MODE` decides
whether `HOLD` exists, so locking it alongside the controls it gates was unsafe. The AMP
envelope runs 87..91 in page order with 88 the only gap, and 97 is the only gap around the
other AMP controls. A short follow-up capture confirms or breaks both.

### Twelve controls are not in the lock table at all

`NOTE`, `VEL`, `LEN`, `PROB`, `COND` and `FILL` on TRIG 1, and `RTRG`, `VFAD`, `LEN`, `RATE` on
TRIG 2, plus `LFO.T` and `FLT.T` — every one was locked on its own step and produced **no
record**. Note, velocity and length live in the trigger slot; probability and the two condition
families live in the track record's own per-step arrays (§2). Where the remaining seven are
stored is UNKNOWN — they are in no array this project has identified.

### Ids 32..76 are unaccounted for

Everything named sits in 1..31 or 77..106. The SYN pages and FLTR page 1 were excluded from the
capture because they vary with the selected machine, and 45 free ids is about the right size
for them. INFERRED from the gap, not observed.

---

## 4b. Machine-page lock ids are machine-relative — VERIFIED 2026-07-26

**The same id means a different parameter on a different machine.** An id in this range is
meaningless without knowing the track's machine. Captured in pattern H2 of
`MORNING_JA 1640(2).dn2prj`: four machines on four tracks of one pattern, each control locked on
its own step. Implementation: `src/project/machineplock.ts`.

Of the **22 ids FM TONE and WAVETONE both use, all 22 name different parameters.** In the
filters:

| Id | MULTI-MODE | COMB- |
|---|---|---|
| 73 | TYPE | **LPF** |
| 75 | RESO | **FDBK** |

The other six filter ids happen to carry the same name on both machines, which is why two
machines were the minimum needed to see this at all — comparing only knobs A-E would have
concluded the ids were absolute.

### What this means for an editor

An editor cannot render a lock from its id. It needs `(machine, id)`, and the machine comes from
`sound+244` — so **reading a p-lock depends on the sound object**, not just the pattern. That is
a real constraint on the data model and it is worth knowing before building one.

### Ranges

| Ids | Meaning |
|---|---|
| 1..31 | LFOs, **absolute**, `4 * slot + lfo` |
| 33..76, 78..81 | **machine-relative** |
| **77** | FLTR page 2 `DEL` — **absolute**, and it sits inside the machine range |
| 82..85, 87..106 | fixed pages, absolute |

`77` is the exception that makes the machine-relative ids two ranges rather than one span.
FLTR page 1 and page 2 interleave, so anything treating 33..81 as uniformly machine-relative
will mis-resolve `DEL`. A test asserts this, having caught exactly that error once.

### Allocation, where it is visible

**WAVETONE uses 33..55 with no gaps** — 23 controls, 23 consecutive ids — but *not* in knob
order: SYN page 2's `TBL1` is id 35, sitting between page 1's `WAV1` (34) and `PD1` (37). So an
id cannot be derived from a position even within one machine.

**FM TONE uses 33..72** with 42 and 57..65 unused. 42 is a control WAVETONE has and FM TONE does
not. `PHRT` breaks its page's run entirely, taking id 41 while its neighbours are 51..56.

**FM TONE's SYN page 2 is the operator envelope page**, read off the device: `ATK`, `DEC`,
`END`, `LEV` for operator A on knobs A-D, and the same four for operator B on E-H.

| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| A ATK | A DEC | A END | A LEV | B ATK | B DEC | B END | B LEV |
| 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 |

**The device shows the same four labels twice**, so the operator is carried by knob position
alone — nothing on screen distinguishes operator A's `ATK` from operator B's. Any UI reading a
lock here has to supply the operator from the id, because the name will not.

The manual's OS 1.00A text yields only `B1` and `B2` for this page, which are neither of these:
another extraction artefact, from prose about the operators rather than knob labels.

### Still unmapped

`32`, `57..65`, `86`. Nine of the twelve are expected to fall to FM DRUM and SWARMER, which have
not been captured. `32` and `86` are the genuinely odd ones.

### Two inferred ids, confirmed

`HOLD` = **88** and `AMP MODE` = **97**, both predicted from gaps and both correct.

`HOLD` at 88 is **not** `DEC` at 89, and `HOLD` occupies knob B in AHD exactly where `DEC` sits
in ADSR. So the **AMP page is parameter-addressed** while the machine pages are slot-like: the
DN2 does both, in different places. `AMP MODE` reads **0 for AHD and 1 for ADSR**.
