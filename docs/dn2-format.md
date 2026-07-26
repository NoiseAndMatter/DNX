# Digitone II `.dn2prj` project format

Status of every claim below is marked **[verified]**, **[inferred]** or **[speculative]**.

- **[verified]** — checked programmatically against the whole corpus available at the time
  (53 DN1 `.dnprj` payloads, 9 DN2 `.dn2prj` payloads, 1 native DN2 SysEx pattern dump,
  511 DN1 SysEx sound dumps). The evidence is stated inline.
- **[inferred]** — follows from verified facts plus one reasonable assumption, stated.
- **[speculative]** — plausible reading of the bytes, not yet tested. Do not build on it.

Related: `docs/sysex-format.md` (SysEx transport), `docs/dn1-project-format.md`.

> **Note for readers of `docs/dn1-project-format.md` and `src/project/dn1.ts`:** those were
> written before the compression was found and describe the payload body as
> "uncompressed and variable length". That is not correct — see
> [The body is LZ4-compressed](#1-the-body-is-lz4-compressed) below. The "variable-length
> records" and "unsolved length encoding" described there are LZ4 sequences. Once
> decompressed, DN1 projects are fixed-offset arrays with no scanning required.

---

## 0. File container

**[verified]** A `.dn2prj` is a ZIP with two entries: `manifest.json` and a binary payload
named by `manifest.Payload`.

```json
{ "FormatVersion": "1.0", "ProductType": [], "Payload": "MORNING_JAM",
  "FileType": "Project", "FirmwareVersion": "1.10E" }
```

DN1 `.dnprj` manifests are identical except `ProductType: ["24","30"]` and a DN1 OS
version. **[verified]** on 62 files.

### Payload header

Offsets into the raw (still compressed) payload. Little-endian unless stated.

| Offset | Size | Value | Status |
|---|---|---|---|
| `0x00` | 4 | `AC 11 D3 03` container magic | verified, 62/62 |
| `0x04` | 4 | `02 00 05 00` | verified constant, 62/62 |
| `0x08` | 1 | device kind: `9` = DN1, `15` (0x0F) = DN2 | verified |
| `0x09` | 4 | ASCII format version: `"0097"` DN1, `"0050"` DN2 | verified |
| `0x0D` | 3 | zero | verified |
| `0x10` | 4 | `01 00 00 00` | verified constant, 62/62 |
| `0x14` | u32le | root object version: 12 on DN1, 3 on DN2 | verified — equals the u32be version inside the decoded root object at image offset 4 |
| `0x18` | u16le | project slot, 0-based (file `002 X.dnprj` → 1) | verified |
| `0x1A` | 2 | `72 2A` on every DN1, `AE C4` on every DN2 | verified constant per device family; meaning unknown |
| `0x1C` | 3 | `04 01 0C` | verified constant, 62/62; meaning unknown |
| `0x1F` | — | **start of the LZ4 block chain and of the CRC region** | verified |
| `len-12` | u32be | CRC-32 (solved separately, see `src/project/checksum.ts`) | verified elsewhere |
| `len-8` | u32be | `len - 43` | verified |
| `len-4` | 4 | `AA A1 DA AA` footer magic | verified |

**[speculative]** `0x1C = 04 01 0C` may be a codec descriptor (`04` for LZ4, `01` a
version). Nothing tests this; it is constant across both families so it carries no
information we can exploit.

---

## 1. The body is LZ4-compressed

**[verified]** The payload body between `0x1F` and `len-12` is a chain of **LZ4
block-format** blocks sharing one continuous dictionary (LZ4 "linked blocks").

```
0x1F      u32be  compressed size of block 0
0x23             block 0 bytes
          u32be  compressed size of block 1
                 block 1 bytes
          ...
          u32be  0                      <- chain terminator
len-12    CRC / length / footer
```

Each block decodes to exactly **32,768** bytes except the last. **[inferred]** — there is
no field stating the block size; it is the observed output of every non-final block in
all 62 payloads.

The blocks are **linked**: a match in block *n* may reference output produced by block
*n-1*. Decoding each block into a fresh buffer fails within the second block.

Standard LZ4 block format applies with no deviations found **[verified]**:

- token byte: high nibble = literal count, low nibble = match length − 4
- a nibble of 15 is extended by a chain of bytes, terminated by any byte ≠ 255
- literals follow the token, then a **u16le** match offset
- the last sequence of a block is literals only, with no trailing offset

### Evidence

| Check | Result |
|---|---|
| Chain lands exactly on the zero terminator | 62/62 payloads, zero slack |
| Every DN1 payload decodes to | exactly **2,781,700** bytes (53/53) |
| Every DN2 payload decodes to | exactly **12,889,604** bytes (9/9) |
| Decoded DN2 name field vs raw | raw `SHAK ff R VEL ff CY T` → decoded `SHAKER VELDCY T` |
| Decoded DN2 kit vs native SysEx kit | byte-identical structure, see §3 |

First sequence of `MORNING_JAM.dn2prj`, worked by hand, as a sanity anchor:
`F0 05` = token `0xF0` (literal count 15, extended by `0x05` → 20 literals, match len 4),
20 literals `BE EF BA CE 00 00 00 03 "MORNING_JAM" 00`, offset `01 00` = 1, so the match
repeats the last byte (`0x00`) four times — completing a 16-byte name field.

Implementation: `src/project/dn2codec.ts`.

### This resolves the stride-6 `0xFF` anomaly

**[verified]** The `0xFF` bytes that appeared to punch holes in sound names at
name-relative offsets 4, 10, 16, 22 are **not in the data at all**. They are the low byte
of the u16le match offset in LZ4 sequences. A run of `[offset u16le][token][1 literal]`
triples — which is exactly what encoding a series of near-identical 16-byte name fields
produces — puts a byte at a 6-byte spacing. Common small offsets (5, 1, 2) give a low
byte that is not `0xFF`, which is why some grid slots looked "unpunched" and why the
spacing sometimes jumped to 11 (a sequence with 2 literals instead of 1).

The same reasoning explains `BA CE FF 0C` (should be `BA CE F0 0C`) and `FF EF BA CE`
(should be `BE EF BA CE`): those bytes were never contiguous in the decoded image.

After decompression, all 62 images contain clean ASCII names, correct `BE EF BA CE`
object magics and correct `BA CE F0 0C` object terminators.

**Practical consequence:** do not pattern-match on the raw payload. Decompress first.

---

## 2. Decoded image geometry

The decoded image is a flat, fixed-offset array. No scanning is needed for anything in
this section. **[verified]** on all 9 DN2 and all 53 DN1 payloads.

### Digitone II (kind 15, `"0050"`), image size 12,889,604 (`0xC4AE04`)

| Region | Offset | Size | Count | Stride |
|---|---|---|---|---|
| Header (root object + project name) | `0x000000` | 512 | 1 | — |
| **Pattern array** | `0x000200` | 11,403,264 | 128 | **89,088** (`0x15C00`) |
| **Kit array** | `0xAE0200` | 1,376,256 | 128 | **10,752** (`0x2A00`) |
| Tail | `0xC30200` | 109,572 | — | — |

`0x200 + 128 × 89,088 = 0xAE0200` and `0xAE0200 + 128 × 10,752 = 0xC30200` — the arithmetic
closes exactly, and `0xAE0200` is independently confirmed as the offset where an unbroken
run of 128 kit records begins.

### Digitone 1 (kind 9, `"0097"`), image size 2,781,700 (`0x2A7204`)

| Region | Offset | Size | Count | Stride |
|---|---|---|---|---|
| Header | `0x000000` | 512 | 1 | — |
| **Pattern array** | `0x000200` | 2,359,296 | 128 | **18,432** (`0x4800`) |
| **Kit array** | `0x240200` | 327,680 | 128 | **2,560** (`0xA00`) |
| Tail | `0x290200` | 94,212 | — | — |

### Image header (first 512 bytes)

```
0x00  BE EF BA CE            object magic
0x04  u32be                  version (3 on DN2, 12 on DN1)
0x08  16 bytes               project name, NUL-padded  ("MORNING_JAM")
0x18  u32                    4 bytes, differ per project           [speculative: a hash/id]
0x1C  ...                    zero out to 0x200 in every file checked
```

**[verified]** name and version. **[speculative]** the meaning of `0x18`.

---

## 3. A project pattern IS a SysEx pattern

**This is the highest-leverage finding.** **[verified]**

```
sysex pattern dump payload (99,840 bytes)
    = project pattern record (89,088)  ++  project kit record (10,752)
```

`89,088 = 0x15C00` is exactly where `KIT 1` begins in a decoded native DN2 SysEx pattern
dump, and `99,840 − 89,088 = 10,752` is exactly the project's kit stride.

Verified three independent ways:

1. Both start with the same u32be version 3 then the same repeating `00 00 00 10` groups.
2. The 64 bytes immediately before the kit — 55 × `FF` then nine `00` — are byte-identical
   at SysEx `0x15BC0` and project `0xAE01C0`.
3. The trigger slot array lands at pattern-record offset `0x4A34`, the same offset the
   SysEx corpus established, and reads correctly:
   `00 00 3C FF FF 00 | 00 01 3C FF 4E E9 | 00 04 3C FF FF 00 | 00 0B 3C ...`
   i.e. `[track, step, note, ...]` 6-byte records on track 0 at steps 0, 1, 4, 11, 12.

**Everything learned from the 424-capture SysEx corpus applies to project patterns with
no offset translation.** `patternAsSysexPayload()` in `src/project/dn2image.ts` rebuilds a
dump-equivalent buffer for any of the 128 slots.

**[inferred]** pattern *k* pairs with kit *k*: the arrays are parallel, both 128 long, and
kit contents track pattern contents across the whole matched-pair corpus (§6).

---

## 4. Kit record layout

### DN2 kit, 10,752 bytes **[verified]** offsets, from object-magic positions

| Offset | Size | Contents |
|---|---|---|
| `0` | 60 | Kit object: `BE EF BA CE` (+0) + u32be version 3 (+4) + 16-byte kit name (+8) + 4 unidentified bytes (+0x18) + 16 × u16le (+0x1C, all `0x0064` at default — **[speculative]** per-track levels). The DN1 kit header is the same idea minus the magic: version (+0), name (+4), 4 × u16le (+0x14), and its four values match the DN2's first four. |
| `60` | 16 × 359 = 5,744 | **16 sound slots**, one per track |
| `5,804` | 160 | unidentified |
| `5,964` | 16 × 268 = 4,288 | **16 MIDI track records**, one per track |
| `10,252` | 500 | unidentified |

### Sound object, 359 bytes **[verified]**

```
+0x00  BE EF BA CE            magic
+0x04  u32be                  version (2 in DN2 kits, 5 in DN1 project kits,
                              2 in DN1 SysEx sound dumps)
+0x08  4 bytes                unidentified
+0x0C  16 bytes               sound name, NUL-padded
+0x1C  ...                    u16le parameter array
+0xF4  u8                     machine selector      (244 decimal, see below)
+0x163 BA CE F0 0C            object terminator (last 4 bytes)
```

#### Machine selector at +244 **[verified]**

| Value | Machine |
|---|---|
| 0 | FM TONE |
| 1 | WAVETONE |
| 2 | FM DRUM |
| 3 | SWARMER |
| 4 | MIDI |

Found by diffing pattern A6 of the device-authored capture — three tracks switched to
different machines — against a pattern where every track is FM TONE. Switching a machine
rewrites a couple of dozen bytes (the new machine's parameter defaults), but only **seven**
offsets move for all three machines at once, and only `+244` is a small enum taking a distinct
value per machine. The others are the name field and per-machine parameter defaults.

Confirmed independently on the matched corpus: across 12,288 sound slots of Elektron's own
conversions the byte takes exactly two values — 0 on 9,216 and 4 on 3,072, the latter being
precisely slots 4-7 of every kit, which is where the DN1's four MIDI tracks land. The capture's
MIDI-machine track agrees.

**The numbering is not the device's menu order** (which reads FM TONE, FM DRUM, WAVETONE,
SWARMER). Values 5 and up have not been observed and the DN2's machine list is longer than this
capture covered, so an unrecognised value stays unnamed rather than being guessed.

The name offset and the u16le parameter array are confirmed by cross-referencing a DN1
SysEx sound dump of `THAT ORGAN SM` against the same sound inside a DN1 project image:
the first 41 bytes are byte-identical, including junk in the name padding.

**[verified]** Unused sound slots are all-zero, not `0xFF`.

**Unknown:** the parameter map inside the 359 bytes. The DN2 manual's parameter list is
the obvious next reference. The DN1 SysEx sound bank (`00_Examples/01_DN1/02_Sounds`,
511 unique sounds, 284 bytes each, uncompressed) is a good corpus for DN1 sounds.

### MIDI track record, 268 bytes **[verified]**

```
+0x00  BE EF BA CE  + u32be version 2 + 4 bytes
+0x0C  16 bytes     track name, "MIDI 1".."MIDI 16" at default
...
+0x8E  16 × u16le   ascending 0x46..0x55 at default   [speculative: CC numbers 70..85]
+0xB0  16 × 5 bytes CC value names: "VAL1\0".."VAL9\0", then "VAL10".."VAL16"
                    (5-byte fields, so the two-digit ones have no terminator)
+0x108 BA CE F0 0C
```

The `VAL` name array was the Rosetta stone that cracked the codec: in the compressed
payload it appears as `VAL1` followed by ~14 repetitions of `05 00 10 <digit>`, i.e.
"copy 4 bytes from 5 back, then one literal".

### DN1 kit, 2,560 bytes **[verified]**

| Offset | Size | Contents |
|---|---|---|
| `0` | 28 | u32be version 10 + 16-byte kit name + 4 × u16le |
| `28` | 4 × 302 = 1,208 | 4 sound slots (DN1 has 4 synth tracks) |
| `1,236` | 1,324 | unidentified — DN1's 4 MIDI tracks presumably live here, but no `BE EF BA CE` objects are present in this range, so the layout differs from DN2 |

---

## 5. Tracks, and how MIDI tracks are marked

**[inferred]** DN2 pattern records contain 16 track records of 1,187 bytes. The
`40 40 40` marker recurs at exactly that stride, 16 times, at SysEx offsets
1162 … 18967 — established from the native SysEx capture, and pattern records are
byte-identical to that region (§3). The array base is therefore near `0x400`;
**[speculative]** the exact base is 1,020.

**[verified]** In `007 ORION_MIDI_TEST` (a DN1 project with MIDI tracks, imported to DN2),
slicing pattern 0's track area at stride 1,187 splits the 16 tracks cleanly into two
groups: tracks 1-8 carry varied data, tracks 9-16 are uniformly filled with u16le `0x00A1`
repeated. That is consistent with a DN1 import populating 4 synth + 4 MIDI tracks and
leaving 8 tracks untouched.

**Unknown:** the per-track synth/MIDI flag itself has not been located. The DN2 stores a
sound slot *and* a MIDI record for all 16 tracks regardless, so the discriminator is a
separate field. Finding it needs either a native DN2 project with a known MIDI track, or
a diff of two DN2 SysEx patterns differing only in one track's mode.

**Unknown:** per-track length, speed, and scale fields. The emnyeca corpus has
`Length_Field` and `Track_Step_State_Table` folders that would localise these; they were
not analysed here.

---

## 6. Matched-pair cross-check (DN1 source → DN2 import)

**[verified]** `002 MORNING_JAM.dnprj` (DN1) against `MORNING_JAM.dn2prj` (DN2):

- All 128 kits: the DN1 4 sound names equal the DN2 first-4 sound names, **128/128 exact**.
  Kit 0: `DEEP KICK SM`, `SAWPASS BR`, `CLICK 2 HZ_ARP`, `ETHER 3-2` in both.
- `DEEP KICK SM`, `BASS SUB MF`, `SOUND 3`, `BD ROMP` all present in both decoded images.
- **DN2 sound slots 5-16 are never named in any of the 128 kits** — a DN1 import fills
  only tracks 1-4 and leaves 5-16 as all-zero slots. This is precisely the gap the
  expansion project exists to fill.

**[verified]** The name mangling reported earlier ("SHAKER VELOCITY T" reading as
`SHAK ff R VEL ff CY T`) was an artefact of reading compressed bytes. There is no import
corruption: the decoded DN2 name is `SHAKER VELDCY T`, matching the DN1 source
`SHAKER VELDCY` exactly.

---

## 7. Tail region

**[verified]** DN2: 109,572 bytes at `0xC30200`. It opens with a record that has the exact
shape of a kit — `BE EF BA CE` + version 3 + 16 u16le `0x0064`, then 16 × 359-byte sound
objects named `SOUND 1`..`SOUND 4`, then 16 × 268-byte MIDI records with the standard
`VAL` arrays.

**[speculative]** This looks like the active/edit-buffer kit. What occupies the remaining
~98,800 bytes is unidentified; project-level settings, song mode and the +Drive sound
pool are the obvious candidates.

**[verified]** DN1 tail: 94,212 bytes at `0x290200`. Not analysed.

---

## 8. What is still unknown

Ordered by how much they block writing valid DN2 files.

1. **Re-compression.** Reading is solved; writing is not attempted. Any LZ4 encoder that
   emits linked blocks of 32,768 bytes should work, since LZ4 decoding is
   encoder-independent — but the device may be strict about block size, and the CRC and
   length fields must be recomputed over the new compressed bytes. Untested.
2. **The synth/MIDI per-track flag** (§5). Needed for any DN1→DN2 track expansion.
3. **Sound parameter map** inside the 359-byte sound object (§4).
4. **Per-track length / speed / scale / machine type** (§5).
5. **Trailing region contents** (§7), and the two unidentified gaps inside the kit record
   (160 bytes at `5,804`, 500 bytes at `10,252`).
6. **Header field `0x1A`** (constant per device family) and `0x1C` (`04 01 0C`).
7. **Image header `0x18`** u32.
8. Whether a DN1 pattern record concatenated with its DN1 kit record equals a DN1 SysEx
   pattern dump, as it does on DN2. Not checked — no DN1 pattern dump in the corpus.

## 9. Code

| File | Purpose |
|---|---|
| `src/project/container.ts` | ZIP + payload header/footer (pre-existing) |
| `src/project/checksum.ts` | CRC-32 over `payload[0x1F : len-12]` (pre-existing) |
| `src/project/dn2codec.ts` | LZ4 linked-block chain decoder — works for DN1 and DN2 |
| `src/project/dn2image.ts` | Decoded image geometry, record slicing, name accessors |

```ts
const project = parseProject(new Uint8Array(readFileSync(path)));
const { image } = decodeProjectImage(project.payload.raw);

projectName(image);                     // "MORNING_JAM"
dn2KitSoundNames(image, 0);             // 16 slot names for pattern 0's kit
patternAsSysexPayload(image, 0);        // 99,840 bytes, identical to a SysEx dump payload
```

### Sound object parameters, by name — VERIFIED 2026-07-26

The 359-byte object was mapped *structurally* long before it was mapped *meaningfully*: 139
offsets have a known DN1 source and conversion is 99.99966% byte-exact, but nothing said which
byte was `CUTOFF`. This closes that. Implementation: `src/project/soundparams.ts`.

Captured in pattern H4 of `MORNING_JA 1640(5).dn2prj`. Six tracks on FM TONE + MULTI-MODE, track 1
left untouched as a baseline, tracks 2-6 each carrying a group of controls set to distinct values.
Diffing each sound against the baseline names a byte by the value it received.

**No parameter locks were used.** A sound object holds the track's live values, so turning a knob
moves a byte directly — which makes this the cheapest capture of the three and the only one that
needed no trigs at all.

#### The LFO block is a regular grid

```
offset = 30 + 8 * parameter + 2 * lfo

        SPD  MULT FADE DEST WAVE  SPH MODE  DEP
LFO 1    30    38   46   54   62   70   78   86
LFO 2    32    40   48   56   64   72   80   88
LFO 3    34    42   50   58   66   74   82   90
```

Every byte that moved in the LFO tracks lands on this rule, and nothing lands off it. **The fourth
slot of each group of eight is unused**, so there is room for a fourth LFO here too — the same
spare capacity the lock table shows.

Note the lock table interleaves the same three LFOs as `4 * slot + lfo`. Both layers interleave
rather than block, at different strides, so neither can be derived from the other.

#### Encodings, and they match the lock table

| Kind | Stored as |
|---|---|
| unipolar | the value |
| bipolar | `value + 64` |
| fine-resolution | `value / 2 + 64` in a coarse byte, with a fine byte beside it |

Verified on the LFO depths: 32 stored 80, 56 stored 92. That is the same coarse/fine pair the
p-lock slots use, so one decoder serves both.

#### It is parameter-addressed, not slot-addressed

**`AMP HOLD` has its own byte at +204**, in the gap between `ATK` (+202) and `DEC` (+206), holding
127 in ADSR where `HOLD` does not exist. The sound object therefore agrees with the lock table,
which gives `HOLD` id 88 distinct from `DEC`'s 89.

That settles a question that would have shaped an editor: **reading an envelope does not require
knowing the AMP `MODE`.** Had the byte been shared, every read would have needed the mode first.

#### The named offsets

| Region | Contents |
|---|---|
| 30-90 | the three LFOs, by the rule above |
| 102-108 | SYN 1 — HARM, DTUN, FDBK, MIX |
| 114-128 | SYN 2 — the two operator envelopes, ATK/DEC/END/LEV each |
| 130, 136 | SYN 3 — ADEL, BDEL |
| 168-172 | SYN 4 — KTRK A, B1, B2 |
| 176-196 | FLTR — FREQ, RESO, ENV, then ATK/DEC/SUS/REL, with FLTR 2's DEL, KEY.T, BASE, WDTH interleaved |
| 202-220 | AMP — ATK, HOLD, DEC, SUS, REL, then PAN and VOL |
| 212-216, 232, 236 | the per-sound FX sends: CHR, DEL, REV, SRR, OVER |

**`HARM` centres on 63, not 64** — the one control that does. Two points agree: the untouched
baseline reads 63 for a value of 0, and +23 stored 86, slope exactly 1. With its range of
-26..+26 confirmed on the device, it occupies 37..89. Recorded as measured rather than
normalised to match the others.

#### SYN pages 1 and 3, and the fine tunes — added 2026-07-26

Knowing `HARM` sat at +102 made SYN page 1 fall out in **knob order across consecutive even
offsets**:

| 94 | 96 | 98 | 100 | 102 | 104 | 106 | 108 |
|---|---|---|---|---|---|---|---|
| ALGO | RATIO C | RATIO A | RATIO B | HARM | DTUN | FDBK | MIX |

**`RATIO B` never moved its coarse byte** — only the fine byte beside it, 120 to 147. That fits
the manual's account of B1 and B2 *revolving* through combinations: a fine-grained index rather
than a coarse value.

SYN page 3 is the same, in knob order but skipping `PHRT`: **130 ADEL, 132 ATRG, 134 ARST,
136 BDEL, 138 BTRG, 140 BRST**. `PHRT` is knob D but lives at **+110**, away from the
per-operator block, which fits its being a setting shared by both operators.

**The four switches are INFERRED, and the ordering is all that supports them.** All four bytes
moved together when all four switches were set, so the *set* of four is certain. Nothing observed
distinguishes them individually — a later track moved only +132 and +138, but only two switches
were changed on it, so that says nothing about which two.

The assignment rests on knob order alone. That ordering holds for `ADEL` and `BDEL` either side
of them on the same page, and for the whole of SYN page 1, which is why it is plausible — but it
is not confirmed. Setting **exactly one** switch on a spare track would settle it outright.

**The operator fine tunes** are at **160, 162, 164, 166**, storing `value * 64 + 64`. Set to
-0.500, +0.250, -0.750 and +0.875, they stored 32, 80, 16 and 120 — four exact hits. Choosing
powers-of-two fractions is what made the *scale* readable and not merely the offsets; arbitrary
decimals would have located the bytes and taught us nothing about the encoding.

**`FX BR` was not placed.** It was set to 11 and no byte took that value; `+230` moved to 19,
which is the nearest candidate and does not match, so it is left unclaimed in
`UNRESOLVED_SOUND_CONTROLS` rather than guessed.

The selector controls were deliberately given no numbers, so their bytes are located but unnamed;
the values written on the capture sheet will close those.
