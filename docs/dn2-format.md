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
0x18  u32                    project identity / revision token      [inferred, see below]
0x1C  ...                    zero out to 0x200 in every file checked
```

**[verified]** name and version.

**`0x18` is not a content hash, and not recomputed on save.** Measured across 32 DN2
projects: 19 distinct values, and every duplicate group is explained by copying rather than
by shared content. `EMPTY.dn2prj` and `MORNING_JAM_EXPANDED.dn2prj` have entirely different
content and share `743a3f5b`, which rules out a checksum. A device round-trip of a file we
wrote preserved the value exactly, which rules out recomputation on save; on a second file,
whose contents the tester had changed, the device wrote a new value. That fits an identity or
revision token bumped on a modifying save. **[inferred]** — 2026-07-27, see
`hardware-test-rearrange.md`.

**The nine DN1 projects the device upgraded all carry distinct values** — the DN2 sides of the
matched pairs in `test/convert.test.ts`. So a device authoring a project gives it a fresh
identity. We used to inherit the template's, meaning everything built on `EMPTY.dn2prj` claimed
to be `EMPTY`; since 2026-07-27 `mintProjectId` supplies a new one wherever a file is authored.
Rearranging an existing project keeps its identity, because that is editing rather than
authoring. See `KNOWN-ISSUES.md`.

Worth knowing about the workflow this sits in: **Elektron's Transfer tool does not convert.**
It places a DN1 project on the +Drive, where the device lists it as needing upgrade, and the
conversion happens **on the device at first open**. So "Elektron's importer", which this
project reproduces byte for byte, is the device's own upgrade path rather than a desktop tool.

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

**An empty kit name is legitimate; the device supplies `KIT <slot index + 1>` lazily.**
A round-trip of a project we wrote came back with 13 kits newly named `KIT 1`, `KIT 17`,
`KIT 113` and so on — always the 1-based slot index, always only for kits the device had
actually loaded. The same file's 126 untouched blank kits came back still unnamed. So the
positional name is a display default materialised when a kit is loaded, not a field a valid
project must carry, and clearing it when we blank a slot is correct. **[verified]** 2026-07-27.

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

**[verified] The per-track synth/MIDI flag is a `u16be` bitmask at kit offset 10,260**, bit
*t* set meaning track *t* is a MIDI track. The DN2 stores a sound slot *and* a MIDI record
for all 16 tracks regardless, so this mask is the only discriminator — nothing in the pattern
record distinguishes them. Full evidence in `docs/dn2-pattern-format.md` §7.

Two independent encodings agree on it. The manual (§5.3.1) defines the type by the machine —
*"a track that contains any other SYN machine than the MIDI machine is considered an audio
track"* — and the stored mask matches the mask derived from each preset's machine byte
(`sound + 244 == 4`) in **3,319 of the corpus's 3,328 kits**. All nine exceptions are in
`PRESETS.dn2prj`, the only storage-version-2 project we hold; versions are per struct, so the
offset simply means something else there. **Read it only on version 3.**

### An empty track is named, not nameless — VERIFIED 2026-07-28

**[verified]** In the captured blank patternKit every track's preset carries a name:
`PRESET 1` … `PRESET 16`, **by track number**. An initialised track is therefore not an unnamed
one, and a cleared `T2` comes back as `PRESET 2` — not `PRESET 1`, and not an empty string.

Two consequences:

- **Anything reading the blank must index it by destination.** `applyTrackMove` already fills a
  vacated track from the blank's track of the same number; code predicting the result has to
  line up the same way or it will expect `PRESET 1` everywhere.
- **`empty` cannot be a name test.** `tracksummary.ts` defines empty as *no trigs and no locks*,
  which is right for the reason above: a name-based test would call every initialised track
  occupied.

Found by the track hardware test's own guard, which holds the built file against every claim the
printed sheet is about to make. The first cut of that sheet assumed a cleared track came back
nameless; the guard refused to print it. Nothing shipped, and the fact is recorded rather than
re-derived next time.

**Unknown:** per-track length, speed, and scale fields. The emnyeca corpus has
`Length_Field` and `Track_Step_State_Table` folders that would localise these; they were
not analysed here.

---

## 5b. The saved position — VERIFIED on hardware 2026-07-28

**[verified]** A project stores **where the device was when it was saved**:

| | offset | absolute |
|---|---|---|
| Pattern | `tail + 56,843` | 12,836,875 |
| Track | `tail + 56,839` | 12,836,871 |
| Track, second copy | `tail + 56,920` | 12,836,952 |

where `tail = kitBase + 128 × kitSize` = **12,780,032**.

### How it was found

The user noticed a generated test project opening on `G2` — the pattern it had been *seeded
from* — although the file puts its reference at `A1`. Our builder copies the source project's
tail **verbatim** (0 differing bytes of 109,572), so if position is stored, it was inherited.

The first search looked through the tail for the byte `97`, because `G2` is 97. That was
circular: it could only ever confirm the assumption it started with. The search that worked asks
**which tail offsets vary across the corpus *and* always hold a plausible value**, then tests the
survivors against something independent — the pattern byte names an occupied pattern in 20 of 26
projects, and it walks `H1, H2, H3, H3, H4, H4` through six `MORNING_JAM` captures in timestamp
order.

### The track offset was wrong first, and why the check missed it

The first guess was `tail + 56,840`, one byte along. It survives every check that asks *"is this
a plausible track index?"* — because it reads **5 in every file we hold**. A constant passes a
plausibility test trivially.

What caught it was the user reporting the original project sat on **track 1** while the prediction
said track 6. **A hypothesis that can only be confirmed by plausible-looking values is not being
tested.** There is now a test asserting the field is *not* constant across the corpus, which is
the check that was missing.

### What settled it

A controlled pair: the same project saved twice from `G2`, once on track 1 and once on track 5.
**15 bytes** of the 109,572-byte tail differ, and exactly two go `0 → 4` — `+56,839` and
`+56,920`. The pattern byte held at 97 across both, correctly, since both saves were from `G2`.

The two track copies agree in **24 of 24** corpus projects and moved together in the pair, so
`readSavedPosition` reports a disagreement rather than picking one.

### Unexplained, from the same diff

Twelve of the remaining thirteen differing bytes sit at a stride of **359** — the DN2 sound size —
one byte in each of twelve consecutive sound-pool entries, going 1 to 0. Recorded rather than
guessed at.

### Nothing writes it, and that is now a known defect

A librarian that rearranges patterns leaves this field naming the old slot, so a project reopens
somewhere the user did not leave it. Now that the field is confirmed that is a real defect rather
than a hypothetical one — see `docs/KNOWN-ISSUES.md`. It is deliberately **not** fixed alongside
the discovery: rewriting it on every move raises its own question (does the cursor follow the
pattern, or stay on the slot?) that only the user can answer.

`npm run project -- <file>` prints the pair.

---


## 5c. What a device sends — VERIFIED on hardware 2026-07-28

**[verified]** Captured from a Digitone II (1.10E, build 0050) using `SETTINGS > SYSEX DUMP >
SYSEX SEND`, which the device initiates — nothing was transmitted to it.

### A project is 248 messages, in three groups

| Dump type | Count | Payload each | What |
|---|---|---|---|
| `0x50` PatternKit | **128** | **99,840 B** | every pattern slot, `objNr` 0..127 in order |
| `0x53` Sound | **119** | **359 B** | the project sound pool, `objNr` 0..118 |
| `0x54` ProjectSettings | **1** | **512 B** | one record, `objNr` 0 |

Sent strictly in that order: all patterns, then all sounds, then settings.

**All 128 patterns are sent regardless of occupancy.** The source project holds trigs in 14 of
them; the device dumped every slot, blanks included. So a project transfer costs 14.6 MB whatever
the project contains — which is a strong argument for per-pattern requests (`0x60`) over whole-
project dumps once sending is implemented.

**A PatternKit payload is 99,840 = 89,088 pattern + 10,752 kit**, exactly. The unit we had
inferred, now seen on the wire.

**A standalone Sound dump is 359 bytes** — precisely the kit's per-sound stride. So a preset is
the same 359-byte record whether it sits inline in a kit or alone in the pool.

**ProjectSettings is 512 bytes**, which is the first hard number we have for that object.

### Speed: use USB alone

DIN MIDI runs at 31.25 kbaud, about 3,125 B/s, so a 14.6 MB project takes **~78 minutes**. The
manual says so directly (§13.4.2): *"If MIDI+USB is selected in the OUTPUT TO settings, MIDI data
will limit the USB speed. When sending large chunks of data, make sure you only use the USB
setting."* On USB alone the same dump completes in about a minute.

### The device and the file differ in exactly two places

Comparing all 128 dumped patterns against the same project file:

1. **Unused lock records.** The file pads steps 64..127 with `0xFF`; the device sends `0x00`.
   Only in records whose header marks them unused, so `readLockTable` returns identical results
   from both — same records, same parameters, same live steps.

2. **`sound + 354`, one byte in every preset.** The file holds **1**, the device sends **0**, in
   all 16 presets of every kit. Nothing else in the kit differs — not the levels, not the MIDI
   records, not the mask, not the unknown array at `+10,264`.

   The same byte moved `1 → 0` across twelve pool sounds between two consecutive device saves
   during the saved-position experiment (§5b), which points at a **runtime flag** the device
   maintains rather than musical content. Unnamed, and recorded rather than guessed at.

**Everything our parsers read agrees.** The DN2 pattern and kit readers are now validated against
live device output rather than only against files Elektron's importer wrote — which matters,
because those two had agreed partly by sharing an origin.

### One bad checksum

Pattern `G11` arrived with a stored checksum of 877 against 13,837 computed. Every other message
in 248 was clean, and `G11` is an untouched blank in a project whose content stops at `A14`, so a
transfer glitch is more likely than a format misunderstanding. Worth watching for on the next
capture: if the same slot fails again it is not a glitch.

### A kit is dumpable on its own — and it is exactly the kit record

A `0x52` Kit dump sent from the kit manager carried a payload of **10,752 bytes**: precisely
`DN2_LAYOUT.kitSize`. So a kit is a first-class, transferable object on a Digitone II, and it is
the same record that sits inline in a project.

`docs/references.md` called this *"strong evidence a kit is a first-class object"* on the basis of
elk-herd implementing `0x62` request / `0x52` response for the Digitakt. **Now verified on this
family, on hardware.**

The captured kit matched no kit in the source project — the nearest was `A15`, 1,528 bytes away —
which is expected when the send comes from the +Drive library or from an active kit that has been
edited. It says nothing about the format and everything about which kit was selected.

### And a standalone sound is exactly the kit's sound slot

A `0x53` Sound dump sent from the preset manager carried **359 bytes**: precisely
`DN2_KIT.soundSize`. Read with our own sound reader it gives `HIDDEN TEARS`, machine `FM TONE` —
so a preset is one record, unchanged, whether it sits inline in a kit, alone in the project pool,
or on its own over the wire.

Its byte 354 reads **0**, matching every other dumped preset and supporting the runtime-flag
reading above.

---

### The Digitone 1 sends a different shape — and omits its sound pool

Captured the same way, from a Digitone 1 on 1.42A:

| | Digitone 1 | Digitone II |
|---|---|---|
| Product id (dump space) | **13** (`0x0D`) | 21 (`0x15`) |
| PatternKit payload | **20,992** = 18,432 pattern + 2,560 kit | 99,840 = 89,088 + 10,752 |
| Sound payload | **302** | 359 |
| A project dump | **128 PatternKit + 1 ProjectSettings** | 128 PatternKit + 119 Sound + 1 ProjectSettings |
| ProjectSettings payload | **11,776** | 512 |

Both PatternKit sizes are `patternSize + kitSize` **exactly**, on both machines. The unit is the
same idea at two scales, and the product ids confirm what `src/sysex/devices.ts` had recorded.

> [!warning] **A DN1 project dump carries no sounds**
> There is **no `0x53` in a Digitone 1 project dump** — only patterns and settings — and its
> ProjectSettings payload of 11,776 bytes is far too small to hold a 128 × 302 = 38,656-byte
> pool.
>
> A DN1 kit carries its four track sounds inline, so a pattern dump is not sound-less. But
> **sound-locked** sounds live in the project pool, and the pool is what the expander exists to
> unfold. So a project reconstructed from a DN1 SysEx dump alone would be missing exactly the
> data the DN1 → DN2 workflow depends on.
>
> The DN1 offers separate soundbank and pool sends in its own `SYSEX DUMP` menu, so the data is
> reachable — it is simply **not part of a project dump**, and any transfer built on dumps has to
> fetch it as a second step. On the DN2 the same information arrives automatically as 119
> `0x53` messages.

### The object number runs out at 128

**[verified]** The object number is a single 7-bit SysEx byte, so it counts `0`–`127` and then
**reports `0` for every message after that**. It does not wrap cyclically — it saturates.

Seen on a Digitone sending +Drive soundbanks of different sizes:

| Bank | Messages | Object numbers |
|---|---|---|
| 28 sounds | 28 | `0`–`27`, one each |
| 182 sounds | 182 | `0`–`127`, then `0` × 54 |
| 256 sounds | 256 | `0`–`127`, then `0` × 128 |

The sounds after the 128th are **distinct records, not duplicates** — the names differ. So the
data is all there and only the numbering stops being useful.

> [!important] **Past 128 objects, only send order identifies a record**
> Any transfer that reassembles a bank or a pool from dumps must count messages rather than trust
> the object number. Under 128 the two agree, which is exactly the size at which the mistake
> would never be caught in testing.

The bank contents read correctly regardless: 302 bytes each, decoded by our own DN1 sound reader
straight off the wire — `DIGIT-ONE`, `CHAPPET DL`, `PLUCKY EÅ`.

---

### Requesting works — a device answers on demand — VERIFIED 2026-07-28

**[verified]** Every implemented request was sent to a Digitone II and answered with its matching
response, payload **exactly** the size of the record it names:

| Asked | Answered | Payload | Record |
|---|---|---|---|
| `0x64` ProjectSettings | `0x54` | 512 | 512 |
| `0x63` Sound | `0x53` | 359 | `DN2_KIT.soundSize` |
| `0x62` Kit | `0x52` | 10,752 | `DN2_LAYOUT.kitSize` |
| `0x61` Pattern | `0x51` | 89,088 | `DN2_LAYOUT.patternSize` |

All checksums good. The `0x5n` response / `0x6n` request convention, known only from elk-herd's
Digitakt implementation, **holds on the Digitone family**.

This is the piece the device story was waiting on. With the +Drive file API absent here (§3c-iv
of the ROADMAP), asking for objects one at a time is the *only* way to read a device — and it
works, at any granularity, without the 14.6 MB cost of a whole-project dump.

**The Digitone 1 answers identically.** Same four requests, same matching responses, each payload
exactly its own record:

| Asked | Answered | DN1 payload | DN2 payload |
|---|---|---|---|
| `0x64` ProjectSettings | `0x54` | **11,776** | 512 |
| `0x63` Sound | `0x53` | **302** | 359 |
| `0x62` Kit | `0x52` | **2,560** | 10,752 |
| `0x61` Pattern | `0x51` | **18,432** | 89,088 |

Eight requests across two machines and two firmware generations, every one exact, every checksum
good. So the convention is a **family** property rather than one device's — and a Digitone of
either generation can be read on demand.

> [!important] `supportedMessages` enumerates responses, not requests
> Neither Digitone advertises `0x60`–`0x6f`, and both honour them. So **absence from that list is
> not a refusal** — a lesson worth carrying to any other code that seems to be missing.

Two traps cost time getting here, both ours rather than the device's:

- **A MIDI input is not opened by `addEventListener`.** Only assigning `onmidimessage` opens one
  implicitly. A closed port delivers nothing, which is indistinguishable from a silent device.
- **The two protocols number products differently.** A request must be addressed in the *dump*
  space — `0x0D` Digitone, `0x15` Digitone II — not with the id the API's `Device` response
  reports (20 and 43). The first request went out to product 43 and was rightly ignored.

---

### A whole project read by request — VERIFIED 2026-07-29

**[verified]** 257 requests to a Digitone II — 128 `0x60` PatternKit, 128 `0x63` Sound, one
`0x64` ProjectSettings. **Every one answered.** 14,662,233 bytes in 257 messages:

| | |
|---|---|
| Silences | **0** — the device answers for blank patterns and empty pool slots alike |
| Payload sizes | **exactly** 99,840 / 359 / 512, all 257 |
| Bad checksums | **0** |
| Object numbers | `0`–`127` in order, on all three types |

#### A response echoes the object number it was asked for

**[verified]** The open question this run existed to settle. All three response types returned
`0`–`127` in request order, so under 128 objects a reassembly may trust the number in the message.
The field still saturates past 128 — that limit belongs to the field, not to requesting — but a
request cannot address past 127 anyway, so within one request stream the two never disagree.

#### `0x63 n` reaches the project sound pool, and reveals more of it than a dump does

**[verified]**, and the answer is better than expected. All 128 slots answered: **0–118 named,
119–127 empty**. The device's own front-panel project dump sends exactly **119** `0x53` messages —
the occupied ones. So:

- **a dump sends the occupied pool; a request enumerates the whole pool.** The nine empty slots
  are visible only by asking, and a rebuild that inferred pool size from a dump would size it 119.
- the 119 that both carry are **identical by position, 119/119**.

Cross-checked against a file as well: the 128 requested sounds are **byte-identical to the sound
pool of `008 JAM.dn2prj`**, all 128 — which validates the pool offset (`tailBase + 10,756`) and
the sound reader against live device output. That project's *patterns* no longer match the file,
the device's copy having been played and re-saved since, which is why the comparison that carries
the weight is the next one.

#### Requesting and dumping return the same bytes

**[verified]**, and this is what makes requesting trustworthy. Last night's front-panel project
dump against tonight's requested read — same device, same project:

| | |
|---|---|
| PatternKits identical | **127 / 128** |
| Sounds identical, by position | **119 / 119** |
| ProjectSettings | **0 differing bytes of 512** |

So `0x60` returns the stored record rather than a live or re-serialised view of it, and two
independent acquisition paths agree byte for byte.

#### Where a dumped record sits in the image — VERIFIED 2026-07-29

**[verified]** by searching real images for a captured payload. Both placements are unambiguous,
and they are what lets a capture be written back into a project.

| | Digitone 1 | Digitone II |
|---|---|---|
| Pattern | `headerSize + n × patternSize` | same |
| Kit | `kitBase + n × kitSize` | same |
| Sound pool slot | `tailBase + 4 + n × 302` | `tailBase + 10,756 + n × 359` |
| **ProjectSettings** | **`tailBase + 38,912`**, 11,776 B | **`tailBase + 56,832`**, 512 B |

The DN2 placement matched **510 of 512** bytes against a corpus project, and the two that differed
are `+9` and `+11` — the latter exactly `SAVED_PATTERN_OFFSET`. So §5b's saved-position bytes are
**fields of the ProjectSettings record**, not loose tail offsets.

The DN1 placement was the same offset in **all 23** corpus projects at 99.5–99.9%, and the
arithmetic closes exactly: `tailRegionBase + TAIL.settingsOffset` is `0xFC`, and
`0xFC + 11,776 = 0x2EFC` is precisely `TAIL.songOffset`. **A DN1 ProjectSettings dump is the
post-pool tail from the settings block up to but not including the song table** — settings, the
1,024 × 11 slot array, the CC map and the mixer. **No songs.**

##### A capture is 99.5% of a project

Everything else has to come from a donor: the 512-byte image header (project name, identity token
at `0x18`), the 10,756 bytes of tail before the pool, 124 bytes before the settings record, and
the 52,228 bytes after it where the song table and slot array live. **63,620 bytes, 0.49%.**

#### `0x63` addresses different objects on the two families — VERIFIED 2026-07-29

**[verified]**, and it is the sharpest behavioural difference found between the two machines.

- **Digitone II** — `0x63 n` returns **project sound pool slot `n`**. All 128 answered, 0–118
  named and 119–127 empty, byte-identical to the pool in the project file.
- **Digitone 1** — `0x63 n` returns the **active kit's track sound `n`**. Exactly four answers,
  `n` = 0..3, matching that kit's track slots in order, and silence from 4 to 127.

The alternative reading — "a pool with only four entries" — was checked rather than dismissed.
The same DN1 project's sound locks reference **31 distinct pool slots, up to slot 91**, across 398
locked trigs, and the device stayed silent on every one. It is declining slots it provably holds.

Confirmed on hardware by a front-panel pool send: **93 `0x53` messages, `objNr` 0–92 contiguous**,
covering every slot the project's locks reference. Three of the four sounds `0x63` returned are
**not in the pool at all**, and at matching indices nothing agrees — pool 0–3 are `VBASS HZ-DAFT`,
`GNARLY_PUNCH`, `-- BASS 6 MF`, `BASS 1 MF` against `CZ NE`, `MOVEMENT`, `TROLLEY TK`, `CATHARSIS`.

That absence is the normal case, not an anomaly: **a DN1 sound can be assigned to a track straight
from the +Drive library**, and it then lives only inline in that kit. The pool is the project's own
quick-access store, and its other role is the binding one — **a sound lock can only point into the
pool**. So a track sound need never be there.

The consequence for a restore is that **two captures are complete**: `0x50` carries every track
sound whatever its origin, and the panel pool send carries every lock target.

> [!warning] **A Digitone 1's sound pool has no known request**
> `0x63` is not it, and a DN1 project dump carries no `0x53` at all. The pool is real — 128 slots
> at `tailBase + 4`, and what every sound lock points at — but nothing we have tried reaches it.
>
> **This is ignorance, not impossibility.** A DN1 advertises `0x50`–`0x5d` and we can name only
> `0x50`–`0x54`; **nine dump types are unidentified**, whose requests would be `0x65`–`0x6d`, and
> none has been sent. Neither has `0x6f`.
>
> The free experiment: the DN1's front panel sends the whole sound pool. Capture one with Listen —
> which transmits nothing — and the dump type it arrives as names the request to try.

Practical consequence for anything rebuilding a project: **the two cases are indistinguishable
from the bytes.** Both are `0x53`, both carry an object number, both are 302 bytes. Placing a
request's four kit sounds as pool slots 0–3 would overwrite sound-lock targets with whatever the
tracks happened to be using — so `src/project/rebuild.ts` refuses to place DN1 sound records until
told which they are.

#### The 128th pattern explains itself

The one disagreement is **`G11`** — pattern index 106, 6,433 differing bytes. Precisely the slot
whose checksum failed in last night's dump, alone in 248 messages. Tonight all 257 checksums are
good, so the corrupt copy is the old one: the glitch is **confirmed as a transfer glitch rather
than a format misunderstanding**, with a good copy of the same record to prove it.

Worth saying plainly, because it generalises: the checksum caught it, a re-read fixed it, and a
transfer that trusted one pass would have written 6,433 wrong bytes into a project. **A read is
not finished until its checksums are.**

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
2. ~~**The synth/MIDI per-track flag**~~ **Found** — kit `+10,260`, §5.
3. **Sound parameter map** inside the 359-byte sound object (§4).
4. **Per-track length / speed / scale / machine type** (§5).
5. **Trailing region contents** (§7), and the two unidentified gaps inside the kit record
   (160 bytes at `5,804`, 500 bytes at `10,252`). One byte in the first gap, kit `+0x16b0`,
   is known to be **live**: a device round-trip rewrote it from `0x40` to `0x00` in 114 kits
   without any visible effect. Meaning unknown.
6. **Header field `0x1A`** (constant per device family) and `0x1C` (`04 01 0C`).
7. ~~**Image header `0x18`** u32.~~ Identified as an identity/revision token — see §2.
8. Whether a DN1 pattern record concatenated with its DN1 kit record equals a DN1 SysEx
   pattern dump, as it does on DN2. Not checked — no DN1 pattern dump in the corpus.

## 8a. Storage versions, and what elk-herd's Digitakt II tables tell us

VERIFIED by measurement across the 24-project DN2 corpus, 2026-07-27.

**Pattern records carry a storage version at offset 0 (u32be), and it is not always 3.**

| Version | Projects |
|---|---|
| 3 | 23 of 24, every record |
| 2 | `PRESETS.dn2prj`, **all 128 records** |

Note that the corpus holds two files named for presets: `017 PRESETS.dn2prj` is version 3,
while `PRESETS.dn2prj` is version 2 throughout. So version 2 is not a corrupt file — it is an
older storage revision, and every project we hold otherwise comes from either Elektron's
importer or our own captures, both of which write version 3. **A device-written project at
another version is exactly the case a manager meets first**, which is why
`librarian/device.ts` reports the version and refuses rather than parsing on regardless.

### Why the versions differ — HYPOTHESIS, not established

The user's reading, recorded because it is the most plausible account and it changes what we
should build: **the storage version tracks the firmware.** The device runs OS 1.10D, which
added the chord library, and expanding the pattern record to carry that information would
explain a version bump. `PRESETS.dn2prj` would then be a factory project written by an older
OS and never re-saved.

Consistent with what we can see — every project written or re-saved by the current device is
version 3, and the single version 2 file is a factory preset bank — but **not confirmed**. It
would be confirmed by saving a project on a known older OS, which we cannot do.

**If it holds, version handling is a firmware-compatibility problem, not a parsing problem**,
and elk-herd already models the shape: compare the project's storage version against the
instrument's, **fail** when the project is newer than the device can load, and **warn** when
it is older, because sending it should upgrade it. That is a better answer than our current
flat refusal, and it needs the device's version — which means WebMIDI. Until then, refusing to
edit a version we have never parsed remains correct.

### The Digitakt II is the same storage family

elk-herd (`00_References/elk-herd`, BSD 2-Clause) supports the Digitakt II, and its
`Elektron/Digitakt/CppStructs.elm` is a generated table of `(device, version) -> offset`.
Several of its Digitakt II numbers are ours exactly:

| elk-herd, Digitakt II | Value | Our DN2 |
|---|---|---|
| `patternStorage_sizeof` v3 | 89,088 | `PATTERN.size` = 89,088 |
| `trackStorage_soundSlotLocks` v2 | 1,024 | `TRACK.soundLockOffset` = 0x400 = 1,024 |
| `trackStorage_sizeof` v2 | 1,184 | `TRACK.size` = 1,187 |
| `kitStorage_trackSounds` v0/v3/v4 | 60 | `DN2_KIT.soundOffset` = 60 |

Two things follow, and both matter more than the individual numbers.

1. **Versions are per struct, not per project.** The pattern record is version 3 while the
   track record inside it matches the Digitakt II's version 2 track layout. So "the version"
   is only ever meaningful about a named structure.
2. **elk-herd cannot parse every version either**, and says so: each function returns
   `Maybe Int`, with `_ -> Nothing` for combinations it has no offsets for — including
   Digitakt II `patternStorage` version 2. When the answer is `Nothing` the operation is
   simply unavailable. Our `supported: false` is the same idea reached independently, and
   the agreement is worth more than the convenience.

### What was ruled out

`patternStorage_kitIndex` (Digitakt II v3, offset 88,768) suggests a pattern might reference
its kit by index rather than owning it positionally — which would change how a manager moves
things. **Probed and rejected for the DN2**: at that offset every pattern of every corpus
project reads a constant, `0xFFFF` in thirteen projects and `0` in eleven, never the pattern
index. Kits stay positional — kit `n` belongs to pattern `n` — so a pattern and its kit move
together as one unit. This is the same pairing that makes `patternRecord ++ kitRecord` a
SysEx pattern payload (§3), and elk-herd calls that unit a `patternKit`.

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

**`FX BR` is at +230**, placed by a maximum reading: set to max it stored 127. An earlier track
set it to 11 and the same byte read 19, which no scaling explains — 127 at maximum rules out a
multiplier. The offset is measured; **the 11 -> 19 mismatch is unexplained** and recorded rather
than smoothed over.

**A caveat on the baseline.** The capture used a converted project, and tracks 6, 7 and 8 carry
content from the original music, so they differ from track 1 in bytes nobody touched — the LFO
speed, multiplier and waveform bytes among them. Every offset named here was confirmed by a
*value match*, so those are unaffected. But a changed byte on those tracks that matched no
expected value cannot be assumed to be a selector; it may simply be pre-existing difference.

The selector controls were deliberately given no numbers, so their bytes are located but unnamed;
the values written on the capture sheet will close those.
