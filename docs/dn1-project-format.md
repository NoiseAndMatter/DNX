# Digitone 1 `.dnprj` project format

Reverse-engineered from the 53 DN1 projects in `00_Examples/01_DN1/01_Projects/`
(firmware `1.42A`), cross-checked against the 512 raw sound objects in
`00_Examples/01_DN1/02_Sounds/*.syx` and against `docs/dn2-format.md`.

**Every claim carries a confidence tag.**

| Tag | Meaning |
|---|---|
| **VERIFIED** | Checked programmatically over all 53 decompressed images — 6,784 patterns, 6,784 kits, 6,784 sound pool slots, 16,067 note trigs — with no counterexample. The check is stated inline. |
| **INFERRED** | Follows from verified facts plus one stated assumption. |
| **SPECULATIVE** | A plausible reading of the bytes. Do not write code that depends on it without testing. |
| **UNKNOWN** | Explicitly not established. Listed so nobody re-derives a dead end. |

> ### Correction notice
>
> An earlier revision of this document described the payload body as *uncompressed and
> variable length* with an "unsolved record encoding". **That was wrong at the premise
> level.** The body is a chain of LZ4 linked blocks. The bytes that looked like control
> codes (`F1 02`, `F5 08`, `F0 0C`, the `0xFF` bytes apparently punched into names) are
> LZ4 tokens and u16le match offsets. There is no bespoke encoding, no escape range, and
> nothing to crack. See [`docs/dn2-format.md` §1](./dn2-format.md#1-the-body-is-lz4-compressed)
> and `src/project/dn2codec.ts`.
>
> **Practical rule: never pattern-match on raw payload bytes. Decompress first.** Once
> decompressed, a DN1 project is a flat array of fixed-size records and every offset in
> this document is arithmetic on a constant. Nothing is scanned for.

---

## 1. Container and decompression

**VERIFIED** `.dnprj` is a ZIP holding `manifest.json` plus one binary entry named by
`manifest.Payload`. The payload header, footer, CRC and length field are documented in
[`docs/dn2-format.md` §0](./dn2-format.md#0-file-container); DN1 differs only in the
device kind byte (`9`), the ASCII format version (`"0097"`), the device signature at
`0x1A` (`72 2A`) and the root object version (`12`).

**VERIFIED** All 53 DN1 payloads decompress to exactly **2,781,700** bytes
(`0x2A7204`), with the LZ4 block chain landing exactly on its zero terminator — no
slack in any file.

```ts
const project = parseProject(new Uint8Array(readFileSync(path)));
const { image } = decodeProjectImage(project.payload.raw);   // 2_781_700 bytes
```

---

## 2. Image geometry

**VERIFIED** on all 53 images.

| Region | Offset | Size | Count | Stride |
|---|---|---|---|---|
| Header | `0x000000` | 512 | 1 | — |
| **Pattern array** | `0x000200` | 2,359,296 | 128 | **18,432** (`0x4800`) |
| **Kit array** | `0x240200` | 327,680 | 128 | **2,560** (`0xA00`) |
| Tail (sound pool + project settings) | `0x290200` | 94,212 | — | — |

The arithmetic closes exactly: `0x200 + 128 × 18,432 = 0x240200` and
`0x240200 + 128 × 2,560 = 0x290200`, and `0x290200 + 94,212 = 0x2A7204` = image size.

The strides are not just arithmetic. Independent confirmation:

- Every one of the 128 pattern records begins with u32be `10`, and every one of the 128
  kit records begins with u32be `10`. 6,784 of each across the corpus, no exception.
- Every kit record has four `BE EF BA CE`-framed sound objects at `+0x1C + 302k`, each
  correctly terminated by `BA CE F0 0C` at `+298`. 27,136 objects checked, all pass.
- The 128 sound-pool objects in the tail are likewise all correctly framed.

`src/project/dn1.ts` exposes `checkDn1Image()`, which re-runs all of the above.

### Image header (first 512 bytes)

**VERIFIED**

```
0x00  BE EF BA CE                object magic
0x04  u32be = 12                 root object version (mirrored at payload 0x14)
0x08  16 bytes                   project name, NUL-terminated, residue after the NUL
0x18  4 bytes                    differs in every project             [SPECULATIVE: id/hash]
0x1C  ...                        zero out to 0x200 in all 53 images
```

---

## 3. Pattern record (18,432 bytes)

**VERIFIED** layout.

| Offset | Size | Contents |
|---|---|---|
| `0x0000` | 4 | u32be record version, `10` |
| `0x0004` | 8 × 976 | **track records** — see §4 |
| `0x1E84` | 80 × 130 | **parameter-lock table** — see §5 |
| `0x4724` | 16 | pattern name, `"UNTITLED"` in 6,625 of 6,784 records |
| `0x4736` | u16be | **tempo × 120** |
| `0x4735`, `0x4739`, `0x473B`, `0x473C`, `0x473D` | u8 each | vary per pattern — **UNKNOWN** (defaults `0x00`, `0x10`, `0x01`, `0x00`, `0x00`). Two of them have a known DN2 destination even though their meaning is not known: `0x4735` and `0x473C` are copied to DN2 pattern metadata `+0x11` and `+0x18`, at the same relative offset, unanimously across 1,152 matched pattern pairs. |
| `0x4741` | u8 | own slot index |
| `0x4742` | 190 | zero in every record |

`0x0004 + 8 × 976 = 0x1E84` and `0x1E84 + 80 × 130 = 0x4724` — both boundaries close on
the next identified field, which is how the two record counts were pinned.

**Tempo, VERIFIED.** The u16be at `0x4736` divided by 120 lands in 30..300 BPM for every
one of the 6,784 records, and on a whole number in the overwhelming majority
(`14400 → 120.0`, `15960 → 133.0`, `18720 → 156.0`, `4800 → 40.0`). Default is 120 BPM.

**Slot index, VERIFIED-with-exceptions.** `0x4741` equals the pattern's own array index
in 6,384 of 6,784 records. The 400 exceptions are **INFERRED** to be patterns that were
copy-pasted from another slot, since the byte then holds a different valid index.

---

## 4. Track record (976 bytes)

A pattern holds exactly eight. **VERIFIED** stride: the 16-byte settings block recurs at
exactly 976-byte spacing, eight times, and the eighth ends exactly at `0x1E84`.

| Offset | Size | Contents | Default |
|---|---|---|---|
| `0x000` | 32 × u32be | **step flag words**, two u16be halves per entry | `00 00 00 10` |
| `0x080` | 64 × u8 | **velocity** lock | `0xFF` = none |
| `0x0C0` | 64 × u8 | **note length** lock | `0xFF` = none |
| `0x100` | 64 × i8 | **micro timing** | `0x00` = none |
| `0x140` | 64 × u8 | **trig condition** | `0xFF` = none |
| `0x180` | 64 × 8 | **note records** | `FF 00 00 00 00 00 00 00` |
| `0x380` | 64 × u8 | **sound lock**, index into the 128-slot pool | `0xFF` = none |
| `0x3C0` | 16 | track settings | `06 00 3C 64 0E 04 3C 00 00 FF 00 00 10 02 64 00` |

Every per-step array has exactly 64 entries, which is the DN1 maximum pattern length.
The arrays were separated and step-indexed by cross-correlation: a trig at step *s*
lights up index *s* in all of them simultaneously, at four different array bases.

### 4.1 Step flag words

**VERIFIED** The 128-byte block at `0x000` is 32 u32be entries; entry *n* carries step
*2n* in its **high** u16 and step *2n+1* in its **low** u16.

| Bit | Meaning | Evidence |
|---|---|---|
| `0x0001` | **note trig** | Agrees with "note record byte 0 ≠ 0xFF" on 16,064 of 16,067 trigs |
| `0x0002` | **trigless lock trig** (locks, no note) | 2,190 occurrences; 0% carry a note, 96% carry a parameter lock |
| `0x0010` | set on **odd** steps only | Never once observed on an even step (0 of 11,733) |

Default halves are `0x0000` on even steps and `0x0010` on odd steps — i.e. the parity bit
is present even when the step is empty. **UNKNOWN** why the format spends a bit on step
parity.

Other bits observed, all **UNKNOWN**: `0x0080` and `0x0200` (1,021 and 1,038
occurrences, essentially always set together, and never on a step that also has a sound
lock), `0x0400` (118), `0x2000` (4), `0x4000` (16). Retrig is the obvious candidate for
one of them; nothing has been tested.

### 4.2 Note records

**VERIFIED** 8 bytes per step at `0x180 + 8s`.

```
+0  u8      MIDI note number, 0xFF when the step has no note trig
+1..+7      up to seven extra chord notes, as SIGNED semitone offsets from +0
```

Byte 0 spans 0x0E..0x6B (14..107) across the corpus. Offsets are signed (`0xFD` = −3,
`0xF9` = −7) and are terminated by zeros: `3C 04 07 0B 00 00 00 00` is a C major 7th on
C4. Byte 7 is zero in all 16,067 trigs, so no trig in the corpus uses eight notes.

**INFERRED** an offset of 0 means "no further note" — a unison doubling is therefore not
representable, which is why zero can act as a terminator.

### 4.3 Per-step locks

- **Velocity** `0x080`: `0xFF` = inherit, otherwise 1..127. 100 is by far the most common.
- **Note length** `0x0C0`: `0xFF` = inherit. **INFERRED** to be length because it sits
  alongside the other trig fields and its track default (`0x0E` at settings `+4`) matches
  the DN1's default note length; the value-to-musical-length table is **UNKNOWN**.
- **Micro timing** `0x100`: signed, 0 = none. **VERIFIED** every non-zero value in the
  corpus (41 distinct) lies in −23..+23, which is exactly the DN1's micro-timing range of
  ±23/384 of a note.
- **Trig condition** `0x140`: `0xFF` = unconditional; 35 distinct codes observed, spanning 5..64. The
  code-to-condition table (`%`, `FILL`, `PRE`, `NEI`, `A:B`) is **UNKNOWN**.

### 4.4 Sound locks

**VERIFIED** `0x380 + s` is a u8 sound lock: `0xFF` means none, otherwise it indexes the
128-entry project sound pool in the tail (§6).

Two independent checks over the whole corpus:

- All 4,047 non-`0xFF` values are `< 128`, so every one addresses a real pool slot.
- All 4,047 occur on tracks 0-3. **Zero** occur on tracks 4-7 (§7).

### 4.5 Track settings (16 bytes at `0x3C0`)

Default `06 00 3C 64 0E 04 3C 00 00 FF 00 00 10 02 64 00`.

| Offset | Default | Reading | Tag |
|---|---|---|---|
| `+0x00` | `06` | constant in 54,269 of 54,272 track records | UNKNOWN |
| `+0x01` | `00` | only ever `00` or `80` | UNKNOWN |
| `+0x02` | `3C` | default note (60) | INFERRED |
| `+0x03` | `64` | default velocity (100) | INFERRED |
| `+0x04` | `0E` | default note length | INFERRED |
| `+0x05` | `04` | constant | UNKNOWN |
| `+0x06` | `3C` | second note-like field, mostly multiples of 12 | SPECULATIVE |
| `+0x07`..`+0x0B` | `00 00 FF 00 00` | | UNKNOWN |
| `+0x0C` | `10` | **track length in steps** | INFERRED |
| `+0x0D` | `02` | **speed / scale multiplier index** | SPECULATIVE |
| `+0x0E` | `64` | | UNKNOWN |
| `+0x0F` | `00` | constant | UNKNOWN |

**Track length, INFERRED.** `+0x0C` takes 18 distinct values — 5, 6, 9, 10, 12, 13, 14,
15, 16, 17, 20, 22, 24, 32, 40, 48, 62, 64 — every one of them a legal DN1 pattern
length, with 16 the default and 64 the maximum, matching the 64 entries in every
per-step array. Not confirmed against hardware.

**Speed, SPECULATIVE.** `+0x0D` takes six distinct values (0, 1, 2, 4, 5, 6) with 2 as
default; the DN1 offers seven speed settings with 1× in the middle. The mapping is a
guess.

---

## 5. Parameter-lock table (80 × 130 bytes at `0x1E84`)

**VERIFIED** Each record is:

```
+0    u8        parameter id
+1    u8        track index, 0..7
+2    64 x (u8 coarse, u8 fine)   locked value per step, 0xFFFF = this step is not locked
```

A record header of `FF FF` marks the record unused; unused records hold stale garbage in
their bodies, so do not treat a body of zeros as meaningful.

**A value slot is two bytes, not a little-endian integer.** The coarse byte carries the whole
value for any 0-127 parameter and the fine byte adds 1/128 of a coarse step. This is verified on
the DN2 (see `dn2-pattern-format.md` §4) and **inferred** here: no DN1 sweep was captured, and
the two tables are otherwise identical in design. Nothing rests on the inference — conversion
transfers the byte pair intact — but an editor reading DN1 locks should assume the split.

The table is a **flat pool shared by all eight tracks**, not partitioned per track:
usage falls off monotonically from slot 0 (229 uses) to slot 79, exactly as a
first-free-slot allocator behaves. An earlier "10 slots per track" reading was tested and
rejected (834 contradictions).

**The verification that settles this.** Across all 6,784 patterns, 1,416 lock records are
in use. For every single one of them, the set of steps with a value ≠ `0xFFFF` is a
**subset** of the steps that carry a note trig or a trigless lock trig on the track named
in the record header. Zero violations. The check fails badly (295 violations) if you look
only at note trigs, which is what identified flag bit `0x0002` as the trigless lock trig.

**Parameter ids, UNKNOWN mapping.** Tracks 0-3 use ids spread over 1..72; tracks 4-7 use
only 19, 25 and 29. The mapping from id to a named synth parameter has not been
established. The obvious next step is to lock one parameter at a time on hardware and
diff, or to correlate ids against offsets in the 302-byte sound object.

---

## 6. Sound objects and the sound pool

### 6.1 Sound object (302 bytes)

**VERIFIED**

```
+0x000  BE EF BA CE          magic
+0x004  u32be                version: 5 inside a project, 2 in a SysEx sound dump
+0x008  u32be                tag bitfield
+0x00C  16 bytes             name, NUL-terminated; bytes after the NUL are uncleared
                             residue from the previous name (e.g. "DIGIT-ONE\0SM\0\0\0\0")
+0x01C  ...                  u16le parameter array
+0x12A  BA CE F0 0C          terminator
```

### 6.2 Relationship to a SysEx sound dump

**VERIFIED** A project sound object is 302 bytes; the same sound dumped over SysEx is
282. The first **174 bytes are byte-identical** once the version field is normalised
from 5 to 2 — including the uncleared name residue.

Checked against the eight sounds that appear both in the factory banks and inside a
project image. Six match exactly to byte 174; the other two (`THAT ORGAN SM`,
`JAZZ ORG 1 MF`) diverge earlier only because the user edited the sound after loading it.

**INFERRED** the extra 20 bytes are v2→v5 growth, distributed as: four u16le fields at
`+174` that default to `0x0040` where v2 has zeros; +8 bytes inserted in the zero run
around `+192..+206`; two adjacent u8s at v2 `+206` (`7F 45`) widened to two u16le; and
+10 more bytes inserted in the zero run before `+231`. The exact insertion points inside
those zero runs are ambiguous and the split above is a best fit, not a fact.

**Do not** try to convert v5 → v2 by truncation. Only the 174-byte prefix is safe.

### 6.3 Project sound pool

**VERIFIED** The tail region opens with the sound pool:

```
0x290200  u32be = 5           pool version
0x290204  128 x 302           sound objects, all correctly framed in all 53 images
0x299904  55,552 bytes        project settings / song data
```

This is the pool that sound locks (§4.4) index. It also explains why sound-lock bytes are
always `< 128`.

**UNKNOWN** the 55,552-byte remainder. It differs in every project (no two of the 53
share it), opens with 255 zero bytes, and visibly contains per-MIDI-track blocks
(`02 02 00 02 00 FF 04` followed by ascending CC numbers `46 47 48 ... 55`), a
short `0x0064` level array, and long sparse regions. Not analysed.

---

## 7. Tracks: synth vs MIDI

**VERIFIED** The DN1 has 4 synth tracks (T1-T4) and 4 MIDI tracks (A-D). In the image
this is **positional and fixed — there is no per-track mode flag**:

- A pattern always stores 8 track records; indices 0-3 are the synth tracks, 4-7 the MIDI
  tracks.
- A kit always stores 4 sound objects (one per synth track) and 4 MIDI configuration
  records (one per MIDI track). The counts do not vary anywhere in the corpus.

Two independent confirmations that the split is at index 4:

| Check | Tracks 0-3 | Tracks 4-7 |
|---|---|---|
| Sound locks in the corpus | 2,068 / 1,327 / 359 / 293 | **0 / 0 / 0 / 0** |
| Parameter-lock ids used | spread over 1..72 | only 19, 25, 29 |

A MIDI track cannot have a sound lock, and MIDI tracks address a much smaller parameter
space. Both facts fall out of the data without assuming anything.

This is the DN1 answer to the question `docs/dn2-format.md` §5 leaves open for DN2. On
DN2 all 16 tracks store both a sound slot and a MIDI record, so DN2 must carry an
explicit flag; DN1 does not need one.

---

## 8. Kit record (2,560 bytes)

**VERIFIED** offsets.

| Offset | Size | Contents |
|---|---|---|
| `0x000` | 4 | u32be record version, `10` |
| `0x004` | 16 | kit name (`"KIT 1"` etc.; empty in 6,309 of 6,784 kits) |
| `0x014` | 4 × u16le | per-synth-track level, `0x0064` = 100 by default |
| `0x01C` | 4 × 302 | **sound objects**, one per synth track |
| `0x4D4` | 122 | FX / kit-level parameter block — **SPECULATIVE** |
| `0x54E` | 4 × 172 | **MIDI track configuration records** |
| `0x81A` | 8 × 29 | named slots, `"MACRO0".."MACRO7"` by default |
| `0x8F1` | 271 | zero in the default kit |

Note the kit header has **no** `BE EF BA CE` magic — it starts straight at the version
field. Only the sound objects inside it are magic-framed. (The DN2 kit header does carry
the magic; see `docs/dn2-format.md` §4.)

### 8.1 FX / kit-level block

**SPECULATIVE** `0x4D4`, 122 bytes, reads as u16le values including several `0x7F`
(127), `0x64` (100), `0x40` (64) — the shape of DN1 delay / reverb / chorus / master
settings. Not decoded.

### 8.2 MIDI track configuration records

**VERIFIED** stride 172, four records at `0x54E`, `0x5FA`, `0x6A6`, `0x752`. Confirmed by
diffing `048 ORION_MIDI_TEST.dnprj` against the default kit: the same relative offsets
(0, 12, 28, 48, 64, 158) change in three consecutive records exactly 172 bytes apart.

Default record content, relative to the record start:

```
+0x00   60 00 60 00 03 00 03 00 40 00 40 00      u16le fields
+0x40   46 00 47 00 48 00 49 00 4A 00 4B 00 4C 00 4D 00
                                                 8 x u16le CC numbers 70..77
```

In `ORION_MIDI_TEST` those CC numbers become 3, 4 and 9 in different records, so
`+0x40` is **INFERRED** to be the eight assignable CC numbers of a MIDI track. The MIDI
channel field is **UNKNOWN**; `+0x0C` and `+0x30` both change when a MIDI track is
configured and are the best candidates.

**VERIFIED, and the record base with it.** Correlating these records against the DN2 records
Elektron's importer produced — 7,168 samples, 14 matched pairs × 128 kits × 4 tracks — places
17 of the 18 varying DN2 bytes on a DN1 source with no counterexample. That the map holds at
all confirms the `0x54E` base and the 172-byte stride, which §8.2 could previously only pin
to ±3 bytes. The correspondences are in `MIDI_TRACK_MAP` (`src/expand/fieldmap.ts`): DN1
`+0` `+1` `+2` `+4` `+16` `+28` `+29` `+32` `+34` `+36` `+38` `+48` `+50` `+64` `+66` `+158`
`+159`. Which of them is the channel is still **UNKNOWN** — the mapping says where a byte
goes, not what it means.

**INFERRED, ±3 bytes.** The record array is anchored by its 172-byte stride, but its exact
start and end are uncertain by a few bytes: `0x54E + 4 × 172 = 0x7FE`, while the next
identified structure (a four-entry array with stride 5) begins at `0x7FB`. Treat the
record boundary as approximate; the internal offsets above are relative to a real anchor
and are safe.

### 8.3 Macro slots

`0x81A`, 8 records of 29 bytes, each holding a name defaulting to `MACRO0`..`MACRO7`
followed by `00 00 00 00 00 FF` and zeros. The DN1 has no user-facing "macro" feature,
so this is **SPECULATIVE** — most likely a shared Elektron kit struct with a field the
DN1 does not expose.

---

## 9. Pattern ↔ kit pairing

**INFERRED** Pattern *k* uses kit *k*. Both arrays are 128 long and parallel, and the DN2
document reaches the same conclusion for DN2. Correlating "pattern has trigs" against
"kit has a name" over all 6,784 slots gives 378 agree-used / 6,277 agree-unused / 32+97
disagree — a 92% agreement, consistent with pairing plus users who name kits without
writing trigs (and vice versa), but not a proof.

---

## 10. What is still unknown

Ordered by how much they block the DN1 → DN2 expansion project.

1. **Parameter id → named parameter** for the lock table (§5) and the u16le parameter
   array inside a sound object (§6.1). Everything downstream of "which knob is this"
   needs it.
2. **Re-compression.** Reading is solved; writing a `.dnprj` is not attempted. It needs an
   LZ4 linked-block encoder plus recomputed CRC and length fields.
3. **Step flag bits** `0x0080`, `0x0200`, `0x0400`, `0x2000`, `0x4000` (§4.1). Retrig is
   the likely candidate for at least one.
4. **Trig condition code table** (§4.3) and **note length table** (§4.3).
5. **MIDI channel** and the rest of the MIDI configuration record (§8.2).
6. **Kit FX block** (§8.1) and the pattern trailer bytes `0x4739`..`0x473D` (§3).
7. **The 55,552-byte project settings region** in the tail (§6.3).
8. Whether a DN1 pattern record concatenated with its kit record equals a DN1 SysEx
   pattern dump, as it does on DN2. Untestable here — the corpus has no DN1 pattern dump.

---

## 11. Code

| File | Purpose |
|---|---|
| `src/project/container.ts` | ZIP + payload header/footer |
| `src/project/checksum.ts` | CRC-32 over `payload[0x1F : len-12]` |
| `src/project/dn2codec.ts` | LZ4 linked-block decoder — works for DN1 and DN2 |
| `src/project/dn2image.ts` | Shared image geometry and layout constants |
| `src/project/dn1.ts` | DN1 pattern / track / trig / lock / kit / sound-pool readers |

```ts
import { readFileSync } from "node:fs";
import { parseProject } from "./src/project/container.js";
import { decodeProjectImage } from "./src/project/dn2codec.js";
import { checkDn1Image, readPattern, readKit, readSoundPool } from "./src/project/dn1.js";

const project = parseProject(new Uint8Array(readFileSync("011 DIGIFLOW.dnprj")));
const { image } = decodeProjectImage(project.payload.raw);

checkDn1Image(image);        // { ok: true, problems: [] } on all 53 corpus files
readPattern(image, 0);       // name, tempo, 8 tracks, trigs with locks resolved
readKit(image, 0);           // 4 sounds, 4 MIDI records, levels
readSoundPool(image);        // the 128 sounds that sound locks index
```

Running `readPattern` over all 53 × 128 patterns yields 18,254 trigs (16,067 with a
note, the rest trigless lock trigs), 13,405 resolved parameter locks and 4,047 sound
locks, with `checkDn1Image` reporting zero problems on every file.
