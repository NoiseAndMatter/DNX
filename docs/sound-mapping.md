# DN1 -> DN2 sound field mapping

How a 302-byte Digitone 1 sound object becomes a 359-byte Digitone II sound object, derived
from nine project pairs that Elektron converted themselves, and validated on three of them
that were withheld from the derivation.

Implementation: `packages/core/src/project/soundmap.ts`. Test: `test/soundmap.test.ts`.

| Status | Meaning |
|---|---|
| **VERIFIED** | Derived from six projects and consistent with every one of the 368 distinct sound pairs in them. Held-out projects then reproduced byte for byte. |
| **VALIDATED** | Not derivable from the six — the field never left its default there. Recovered by diagnosing the held-out mismatches, then checked against all 5,760 pairs. Proven, but by the same data that revealed it. |
| **INFERRED** | Both sides constant throughout the paired corpus, so the corpus cannot tell "copied" from "coincidentally equal default". Filled in by a structural rule. Changes nothing on any observed sound. |
| **DEFAULT** | Same value in every pair, explained by no DN1 field. A DN2-only field, or a field DN1 does not have. |
| **UNEXPLAINED** | DN1 data with no known DN2 destination. Listed in full below. |

---

## 1. Why this is a single mapping

The DN1 has no selectable machines: one FM engine per synth track, whose DN2 equivalent is
FM TONE. DN1 MIDI tracks map to DN2 MIDI tracks. There is no machine dispatch, so every DN1
synth sound converts to exactly one DN2 sound type and the whole problem is a field remap.

Both families store a sound object the same way:

```
+0x000  BE EF BA CE          magic
+0x004  u32be                version: 5 in a DN1 project, 2 in a DN2 project
+0x008  4 bytes              tag bitfield
+0x00C  16 bytes             name, NUL-terminated
+0x01C  ...                  parameter array, u16le
        BA CE F0 0C          terminator (DN1 +0x12A, DN2 +0x163)
```

The version field must be normalised before any comparison; everything below assumes that.

## 2. Corpus

Nine DN2 projects in `00_Examples/02_DN2/01_Projects/` are Elektron's own conversions of
nine DN1 projects in `00_Examples/01_DN1/01_Projects/`:

| DN1 | DN2 | role |
|---|---|---|
| `002 MORNING_JAM.dnprj` | `MORNING_JAM.dn2prj` | derivation |
| `043 GLITCH_EXPLORE.dnprj` | `006 GLITCH_EXPLORE.dn2prj` | derivation |
| `048 ORION_MIDI_TEST.dnprj` | `007 ORION_MIDI_TEST.dn2prj` | derivation |
| `049 JAM.dnprj` | `008 JAM.dn2prj` | derivation |
| `050 JAGGED.dnprj` | `009 JAGGED.dn2prj` | derivation |
| `052 JAGGED_PLAY.dnprj` | `011 JAGGED_PLAY.dn2prj` | derivation |
| `051 ODD XS.dnprj` | `010 ODD XS.dn2prj` | **held out** |
| `053 TECNO_EXP.dnprj` | `012 TECNO_EXP.dn2prj` | **held out** |
| `031 DROWSY_WALK.dnprj` | `013 DROWSY_WALK.dn2prj` | **held out** |

### Alignment

**VERIFIED** For every kit index 0..127, DN1 kit sound `i` corresponds to DN2 kit sound slot
`i` for `i` in 0..3; DN2 slots 4..15 are unused after a DN1 import. Kit names agree 128/128
in all nine pairs.

**VERIFIED** The sound pools align the same way. DN1's pool is 128 x 302 bytes at
`DN1_LAYOUT.tailBase + 4`. DN2's is 128 x 359 bytes at `DN2_LAYOUT.tailBase + 10756` — the
DN2 tail opens with a complete 10,752-byte kit record before its pool version word, which is
why a naive `tailBase + 4` finds nothing. Pool names agree 128/128 in all nine pairs.

That gives 9 x (128 x 4 + 128) = **5,760 aligned sound pairs**, 3,840 from the derivation
projects (**368 distinct** after deduplication — most kit slots in a project are untouched
defaults) and 1,920 held out.

## 3. Method

1. For each DN2 offset `j`, keep every DN1 offset `i` with `dn1[i] === dn2[j]` in **all 368**
   derivation pairs. A wrong candidate is eliminated by the first pair that disagrees.
2. Require the surviving source to take more than one value in the corpus, so that agreement
   is not vacuous. This left **exactly one** candidate for 139 DN2 offsets and produced **no
   ambiguity anywhere** — no DN2 offset had two varying candidates.
3. DN2 offsets that vary but that no DN1 offset explains were tested for being a *function*
   of a single DN1 byte. All 25 of them are.
4. Everything else is constant across all 368 pairs and is treated as a DN2 default.
5. Convert the three held-out projects and compare byte for byte.

No rescaling of any copied field was found. Where a field is transformed, it is a small
value table, not arithmetic — see section 6.

## 4. Results

Classification of the 359 DN2 sound bytes:

| status | bytes |
|---|---|
| VERIFIED | 180 (139 copies, 16 name, 22 selectors, 3 table-mapped scalars) |
| VALIDATED | 10 copies |
| INFERRED | 59 copies |
| DEFAULT | 110 |

### Held-out accuracy

The map built from the six derivation projects alone, run over the three held-out projects:

| metric | result |
|---|---|
| bytes | 2,067,833 / 2,067,840 correct (**99.99966%**) |
| sounds | 1,914 / 1,920 byte-exact (**99.69%**) |
| projects | 1 / 3 byte-exact (`DROWSY_WALK`) |

The 7 wrong bytes were not noise. Each was a field that never left its default anywhere in
the derivation corpus, so nothing could have been learned about it there:

| bytes | diagnosis | outcome |
|---|---|---|
| dn2[161] = 0x73, dn2[167] = 0x2f, dn2[162] = 0x20 | DN1 174..181 (four u16le, default `0x0040`) is copied to DN2 160..167, settling which four of the twelve `0x0040` u16le slots at DN2 144..167 they occupy — the last four | `VALIDATION_COPIES` |
| dn2[182] = 0x32 (x2) | DN1 182..183 is copied to DN2 182..183 | `VALIDATION_COPIES` |
| dn2[332] = 4 (x2) | `dn1[251] = 2` maps to 4; the value never occurs in the derivation corpus | extra `SCALAR_FIELDS` entry |

With those folded in, **all nine projects reproduce byte for byte: 5,760 / 5,760 sounds,
2,067,840 / 2,067,840 bytes.** These entries are marked VALIDATED rather than VERIFIED
because, unlike the rest, they were not confirmed on data withheld from their own
derivation, and the varying ones rest on one or two sounds each.

### What the held-out set independently confirmed

Beyond the 7 diagnosed bytes, the held-out projects exercised parts of the map that the
derivation corpus never reached, and got them right:

- Five interpolated selector values (28, 35, 38, 47, 56 — see section 6) occurred in
  held-out sounds and produced byte-exact output. The interpolation rule was written before
  those sounds were looked at.
- Every one of the 1,920 held-out sounds ran through the name rule, the 59 inferred copies
  and the 110 defaults without a single disagreement.

## 5. The name field

**VERIFIED** DN1 leaves residue after the NUL terminator — the tail of whatever name the
slot held before. DN2 clears it. The rule is: copy bytes up to the first NUL, zero-fill the
rest of the 16. This holds in 368/368 derivation pairs and 5,760/5,760 overall. Comparing
names as C strings hides this; comparing the 16 raw bytes does not.

## 6. Selector fields

**VERIFIED** Twenty-two DN2 bytes hold an index into some device-internal list whose DN2
numbering differs from DN1's. Each is a pure function of one DN1 byte, and all twenty-two
share **one** table — 8,096 observations, zero conflicts between fields, 22 of the 49 entries
corroborated by more than one field.

| DN2 | DN1 | | DN2 | DN1 |
|---|---|---|---|---|
| 54 | 42 | | 284 | 222 |
| 56 | 44 | | 287 | 225 |
| 254 | 192 | | 290 | 228 |
| 257 | 195 | | 293 | 231 |
| 260 | 198 | | 296 | 234 |
| 263 | 201 | | 299 | 237 |
| 266 | 204 | | 302 | 240 |
| 269 | 207 | | 305 | 243 |
| 272 | 210 | | 308 | 246 |
| 275 | 213 | | 311 | 249 |
| 278 | 216 | | | |
| 281 | 219 | | | |

The last twenty are the third byte of the twenty 3-byte records running from DN2 252 /
DN1 190. What they select is **not established**. The shape — one byte per record, drawn
from a list of about 70 entries — is consistent with a modulation destination or a parameter
id. If it is a parameter id, the same table probably applies to pattern parameter locks; that
is a hypothesis, not a finding.

`SELECTOR_TABLE` (DN1 -> DN2), 49 entries:

```
 0->0    1->1    2->2    3->5    4->6    5->9    9->17  10->18  11->21
15->29  16->30  17->33  18->34  19->35  20->36  21->37  22->38  23->39
24->40  27->43  29->45  30->46  32->48  34->50  42->58  43->59  44->60
45->61  46->62  49->65  51->74  52->75  53->76  54->78  55->79  57->81
58->83  59->84  60->87  61->89  62->90  63->91  64->104 65->95  66->96
67->94  68->93  69->92  73->66
```

The map is a constant +16 shift through the middle of its range but is **not monotone at the
top** (64 -> 104 sits above 65 -> 95, and 67..69 descend). So no arithmetic rule fits, and
values above the last table entry cannot be extrapolated.

**Interpolation.** For a value absent from the table, if the nearest mapped neighbour below
and the nearest above share the same delta, the value takes that delta. That covers 25, 26,
28, 31, 33, 35..41, 47, 48 and 56, all inside +16 or +24 runs. Five of those fifteen — 28, 35,
38, 47 and 56 — occurred in held-out sounds and produced byte-exact output. Everything else
(6..8, 12..14, 50, 70..72, and anything above 73) is passed through unchanged and reported as
a warning by `convertDn1SoundToDn2Detailed`.

**Coverage over the wider corpus.** Across the 1,102 distinct DN1 sounds in all 53 DN1
projects there are 24,244 selector slots: 24,207 map directly, 34 by interpolation, and 3
are unmapped — the values 12 and 13, which fall in the one region where the neighbouring
deltas disagree (11 -> 21 is +10, 15 -> 29 is +14). Those 3 slots live in 3 sounds, 0.27% of
the corpus.

## 7. Table-mapped scalars

**VERIFIED** Three more DN2 bytes are a function of a single DN1 byte through their own table.

| DN2 | DN1 | table | domain coverage |
|---|---|---|---|
| 174 | 128 | `0->3, 1->0, 2->1, 3->0` | complete — `dn1[128]` only ever takes 0..3 in all 53 projects |
| 245 | 128 | `0->4, 1->4, 2->4, 3->1` | complete, same reason |
| 332 | 251 | `0->0, 2->4, 6->9, 8->12, 9->13, 10->14, 11->16, 12->17, 13->18, 14->19, 15->20` | 10 of the 16 values `dn1[251]` takes across the 53 projects |

The `2->4` entry came from the held-out set. The six missing values (1, 3, 4, 5, 7) occur in
8 of the 1,102 wider-corpus sounds; they are passed through unchanged and reported.

## 8. Inferred copies

**INFERRED** 59 DN2 bytes hold the same single value as a specific DN1 byte throughout the
paired corpus, so the data cannot distinguish "copied" from "DN2 default that happens to
match". Two structural rules pick them out:

1. **u16 high byte.** Parameters are a u16le array from offset 28. Wherever an even DN1
   offset `i` copies to an even DN2 offset `j`, the high byte `i + 1` is completed to
   `j + 1`. Every proven pair in the corpus obeys this — `[86, 58]`/`[87, 59]`,
   `[176, 130]`/`[177, 131]`, `[212, 166]`/`[213, 167]`, and so on — with no counterexample.
2. **Modulation triples.** DN2 `252 + 3k` for k in 0..19 copies from DN1 `190 + 3k`. Nineteen
   of the twenty first bytes and six of the second bytes are proven copies; the remaining
   fifteen positions are completed to the same shape.

Applying these produces byte-identical output on every one of the 5,760 pairs, so they are
free on observed data and preserve information for DN1 sounds outside the corpus. Two of the
59 carry real risk, because their DN1 source *does* vary across the wider 53-project corpus
and no matched pair exercises it:

| entry | risk |
|---|---|
| dn2[229] <- dn1[173] | `dn1[173]` takes 0 or 32 across the 53 projects; 115 of 1,102 sounds (10.4%) are affected. If the u16-pair rule is wrong here, those sounds get a wrong DN2 byte instead of a lost one. |
| dn2[270] <- dn1[208] | `dn1[208]` takes 0 or 56; a handful of sounds affected. |

## 8a. Audited against the whole corpus, 2026-07-26

Scanning all **29,509 named sounds** in the 53-project corpus — every kit slot and every pool slot —
exactly **two** DN1 bytes vary without feeding any DN2 offset: `dn1[284]` taking {0, 2} and `dn1[286]`
taking {0, 1}, the two already listed below. Every other byte that varies anywhere in the corpus has a
destination.

That closes a question worth asking: the **arpeggiator settings live inside the sound**, on both devices
— the DN1 manual says "arpeggiator settings are part of the Sound and saved together", and the DN2 the
same. So they could in principle have been classified as constants and dropped. They were not:
`002 MORNING_JAM` uses arpeggios heavily and is one of the matched pairs, and its sounds reproduce
Elektron's conversion byte for byte, so whichever bytes hold MODE, SPD, RNG, LEN and OFFSET are among the
mapped ones already.

## 9. UNEXPLAINED

**UNEXPLAINED** Two DN1 bytes carry data that no DN2 offset is known to receive, and the
converter drops them:

| DN1 offset | values across 53 projects | sounds affected |
|---|---|---|
| 284 | 0, 2 | 1 of 1,102 |
| 286 | 0, 1 | 3 of 1,102 |

Structurally they would sit at DN2 327 and 329, by extension of the stride-2 run
`dn1[281,283,285,287] -> dn2[324,326,328,330]`. Both are zero throughout the paired corpus,
so this is a guess and is not applied.

**UNEXPLAINED** DN1 112..127 — eight u16le holding `40 00` — has no destination. Its natural
home is the eight remaining `0x0040` u16le slots at DN2 144..159, by analogy with the
DN1 174..181 -> DN2 160..167 finding of section 4. It is not asserted, because those sixteen
bytes hold `40 00` in all 1,102 DN1 sounds, so writing them changes nothing and the
hypothesis cannot be tested either way.

**UNEXPLAINED** The DN2-only defaults. DN2 34 = `0x70`, 42 = `0x03`, 50 = `0x40`, 90 = `0x40`,
144..159 = six u16le `0x0040`, 198 = 1, 204 = `0x7f`, 222 = 1, 249 = 1. These are constant in
all 5,760 pairs and correspond to no DN1 field, so they are DN2 features the DN1 does not
have. What they are is unknown; the values are what Elektron writes on import.

## 10. Full offset table

Source column is the DN1 offset. All offsets are relative to the start of the sound object.

<!-- generated table -->
| DN2 offset | source | rule | status | evidence |
|---|---|---|---|---|
| 0 | - | constant 0xbe | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 1 | - | constant 0xef | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 2 | - | constant 0xba | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 3 | - | constant 0xce | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 4..6 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 7 | - | constant 0x02 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 8 | dn1[8] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 24 values |
| 9 | dn1[9] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 49 values |
| 10 | dn1[10] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 51 values |
| 11 | dn1[11] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 35 values |
| 12 | dn1[12] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 13 | dn1[13] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 14 | dn1[14] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 15 | dn1[15] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 16 | dn1[16] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 17 | dn1[17] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 18 | dn1[18] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 19 | dn1[19] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 20 | dn1[20] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 21 | dn1[21] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 22 | dn1[22] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 23 | dn1[23] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 24 | dn1[24] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 25 | dn1[25] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 26 | dn1[26] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 27 | dn1[27] | name byte | VERIFIED | copy up to the NUL, residue cleared; 368/368 |
| 28..29 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 30 | dn1[30] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 63 values |
| 31 | dn1[31] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 104 values |
| 32 | dn1[32] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 67 values |
| 33 | dn1[33] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 96 values |
| 34 | - | constant 0x70 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 35..37 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 38 | dn1[34] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 24 values |
| 39 | dn1[35] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 40 | dn1[36] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 23 values |
| 41 | dn1[37] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 42 | - | constant 0x03 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 43..45 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 46 | dn1[38] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 37 values |
| 47 | dn1[39] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 48 | dn1[40] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 33 values |
| 49 | dn1[41] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 50 | - | constant 0x40 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 51..53 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 54 | dn1[42] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 28 values |
| 55 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 56 | dn1[44] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 35 values |
| 57..61 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 62 | dn1[46] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 7 values |
| 63 | dn1[47] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 64 | dn1[48] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 7 values |
| 65 | dn1[49] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 66..69 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 70 | dn1[50] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 23 values |
| 71 | dn1[51] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 72 | dn1[52] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 23 values |
| 73 | dn1[53] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 74..77 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 78 | dn1[54] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 5 values |
| 79 | dn1[55] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 80 | dn1[56] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 5 values |
| 81 | dn1[57] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 82..85 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 86 | dn1[58] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 62 values |
| 87 | dn1[59] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 111 values |
| 88 | dn1[60] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 65 values |
| 89 | dn1[61] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 112 values |
| 90 | - | constant 0x40 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 91..93 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 94 | dn1[62] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 8 values |
| 95 | dn1[63] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 96 | dn1[64] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 18 values |
| 97 | dn1[65] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 98 | dn1[66] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 31 values |
| 99 | dn1[67] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 100 | dn1[68] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 3 values |
| 101 | dn1[69] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 130 values |
| 102 | dn1[70] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 48 values |
| 103 | dn1[71] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 117 values |
| 104 | dn1[72] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 79 values |
| 105 | dn1[73] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 99 values |
| 106 | dn1[74] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 80 values |
| 107 | dn1[75] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 108 | dn1[76] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 96 values |
| 109 | dn1[77] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 110 | dn1[78] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 5 values |
| 111 | dn1[79] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 112..113 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 114 | dn1[82] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 51 values |
| 115 | dn1[83] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 116 | dn1[84] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 88 values |
| 117 | dn1[85] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 118 | dn1[86] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 76 values |
| 119 | dn1[87] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 120 | dn1[88] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 97 values |
| 121 | dn1[89] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 122 | dn1[90] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 43 values |
| 123 | dn1[91] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 124 | dn1[92] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 97 values |
| 125 | dn1[93] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 126 | dn1[94] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 75 values |
| 127 | dn1[95] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 128 | dn1[96] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 82 values |
| 129 | dn1[97] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 130 | dn1[98] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 15 values |
| 131 | dn1[99] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 132 | dn1[100] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 133 | dn1[101] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 134 | dn1[102] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 135 | dn1[103] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 136 | dn1[104] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 16 values |
| 137 | dn1[105] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 138 | dn1[106] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 139 | dn1[107] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 140 | dn1[108] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 141 | dn1[109] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 142 | dn1[110] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 3 values |
| 143 | dn1[111] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 144 | - | constant 0x40 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 145 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 146 | - | constant 0x40 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 147 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 148 | - | constant 0x40 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 149 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 150 | - | constant 0x40 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 151 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 152 | - | constant 0x40 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 153 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 154 | - | constant 0x40 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 155 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 156 | - | constant 0x40 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 157 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 158 | - | constant 0x40 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 159 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 160 | dn1[174] | copy | VALIDATED | from held-out diagnosis; 0 mismatches over 5,760/5,760; source values 64 |
| 161 | dn1[175] | copy | VALIDATED | from held-out diagnosis; 0 mismatches over 5,760/5,760; source values 0/115 |
| 162 | dn1[176] | copy | VALIDATED | from held-out diagnosis; 0 mismatches over 5,760/5,760; source values 32/64 |
| 163 | dn1[177] | copy | VALIDATED | from held-out diagnosis; 0 mismatches over 5,760/5,760; source values 0 |
| 164 | dn1[178] | copy | VALIDATED | from held-out diagnosis; 0 mismatches over 5,760/5,760; source values 64 |
| 165 | dn1[179] | copy | VALIDATED | from held-out diagnosis; 0 mismatches over 5,760/5,760; source values 0 |
| 166 | dn1[180] | copy | VALIDATED | from held-out diagnosis; 0 mismatches over 5,760/5,760; source values 64 |
| 167 | dn1[181] | copy | VALIDATED | from held-out diagnosis; 0 mismatches over 5,760/5,760; source values 0/47 |
| 168 | dn1[274] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 16 values |
| 169 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 170 | dn1[275] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 19 values |
| 171 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 172 | dn1[276] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 13 values |
| 173 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 174 | dn1[128] | table (4 entries) | VERIFIED | functional, 368/368 pairs; source takes 4 values |
| 175 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 176 | dn1[130] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 101 values |
| 177 | dn1[131] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 168 values |
| 178 | dn1[132] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 80 values |
| 179 | dn1[133] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 131 values |
| 180 | dn1[134] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 67 values |
| 181 | dn1[135] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 114 values |
| 182 | dn1[182] | copy | VALIDATED | from held-out diagnosis; 0 mismatches over 5,760/5,760; source values 0/50 |
| 183 | dn1[183] | copy | VALIDATED | from held-out diagnosis; 0 mismatches over 5,760/5,760; source values 0 |
| 184 | dn1[136] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 35 values |
| 185 | dn1[137] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 186 | dn1[138] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 79 values |
| 187 | dn1[139] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 188 | dn1[140] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 56 values |
| 189 | dn1[141] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 190 | dn1[142] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 58 values |
| 191 | dn1[143] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 192 | dn1[277] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 21 values |
| 193 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 194 | dn1[144] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 59 values |
| 195 | dn1[145] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 32 values |
| 196 | dn1[146] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 63 values |
| 197 | dn1[147] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 198 | - | constant 0x01 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 199..201 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 202 | dn1[148] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 47 values |
| 203 | dn1[149] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 204 | - | constant 0x7f | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 205 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 206 | dn1[150] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 76 values |
| 207 | dn1[151] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 208 | dn1[152] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 78 values |
| 209 | dn1[153] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 210 | dn1[154] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 83 values |
| 211 | dn1[155] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 150 values |
| 212 | dn1[166] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 53 values |
| 213 | dn1[167] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 82 values |
| 214 | dn1[164] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 51 values |
| 215 | dn1[165] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 63 values |
| 216 | dn1[162] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 69 values |
| 217 | dn1[163] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 83 values |
| 218 | dn1[158] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 26 values |
| 219 | dn1[159] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 220 | dn1[160] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 56 values |
| 221 | dn1[161] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 89 values |
| 222 | - | constant 0x01 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 223 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 224 | dn1[168] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 11 values |
| 225 | dn1[169] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 226 | dn1[170] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 227 | dn1[171] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 228 | dn1[172] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 7 values |
| 229 | dn1[173] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 230..235 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 236 | dn1[156] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 74 values |
| 237 | dn1[157] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 89 values |
| 238..244 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 245 | dn1[128] | table (4 entries) | VERIFIED | functional, 368/368 pairs; source takes 4 values |
| 246 | dn1[188] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 4 values |
| 247 | dn1[189] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 248 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 249 | - | constant 0x01 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 250 | dn1[279] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 4 values |
| 251 | dn1[280] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 8 values |
| 252 | dn1[190] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 20 values |
| 253 | dn1[191] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 254 | dn1[192] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 15 values |
| 255 | dn1[193] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 14 values |
| 256 | dn1[194] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 257 | dn1[195] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 10 values |
| 258 | dn1[196] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 9 values |
| 259 | dn1[197] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 260 | dn1[198] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 7 values |
| 261 | dn1[199] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 4 values |
| 262 | dn1[200] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 263 | dn1[201] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 2 values |
| 264 | dn1[202] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 5 values |
| 265 | dn1[203] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 266 | dn1[204] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 4 values |
| 267 | dn1[205] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 3 values |
| 268 | dn1[206] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 269 | dn1[207] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 3 values |
| 270 | dn1[208] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 271 | dn1[209] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 272 | dn1[210] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 1 values |
| 273 | dn1[211] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 274 | dn1[212] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 275 | dn1[213] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 1 values |
| 276 | dn1[214] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 34 values |
| 277 | dn1[215] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 3 values |
| 278 | dn1[216] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 24 values |
| 279 | dn1[217] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 28 values |
| 280 | dn1[218] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 281 | dn1[219] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 17 values |
| 282 | dn1[220] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 21 values |
| 283 | dn1[221] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 3 values |
| 284 | dn1[222] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 18 values |
| 285 | dn1[223] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 10 values |
| 286 | dn1[224] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 3 values |
| 287 | dn1[225] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 7 values |
| 288 | dn1[226] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 3 values |
| 289 | dn1[227] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 290 | dn1[228] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 3 values |
| 291 | dn1[229] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 292 | dn1[230] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 293 | dn1[231] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 2 values |
| 294 | dn1[232] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 295 | dn1[233] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 296 | dn1[234] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 2 values |
| 297 | dn1[235] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 298 | dn1[236] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 299 | dn1[237] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 2 values |
| 300 | dn1[238] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 15 values |
| 301 | dn1[239] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 302 | dn1[240] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 14 values |
| 303 | dn1[241] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 14 values |
| 304 | dn1[242] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 305 | dn1[243] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 12 values |
| 306 | dn1[244] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 9 values |
| 307 | dn1[245] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 308 | dn1[246] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 8 values |
| 309 | dn1[247] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 6 values |
| 310 | dn1[248] | copy | INFERRED | both sides 0x0 in 368/368; structural rule; 53-project source values 0 |
| 311 | dn1[249] | SELECTOR_TABLE | VERIFIED | functional, 368/368 pairs; source takes 6 values |
| 312..323 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 324 | dn1[281] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 4 values |
| 325 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 326 | dn1[283] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 327 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 328 | dn1[285] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 329 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 330 | dn1[287] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 2 values |
| 331 | dn1[250] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 5 values |
| 332 | dn1[251] | table (11 entries) | VERIFIED | functional, 368/368 pairs; source takes 10 values |
| 333 | dn1[252] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 4 values |
| 334 | dn1[253] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 28 values |
| 335 | dn1[254] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 12 values |
| 336 | dn1[255] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 18 values |
| 337 | dn1[256] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 25 values |
| 338 | dn1[257] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 5 values |
| 339 | dn1[258] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 11 values |
| 340 | dn1[259] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 12 values |
| 341 | dn1[260] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 11 values |
| 342 | dn1[261] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 9 values |
| 343 | dn1[262] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 9 values |
| 344 | dn1[263] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 9 values |
| 345 | dn1[264] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 8 values |
| 346 | dn1[265] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 6 values |
| 347 | dn1[266] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 10 values |
| 348 | dn1[267] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 6 values |
| 349 | dn1[268] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 8 values |
| 350 | dn1[269] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 3 values |
| 351 | dn1[270] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 7 values |
| 352 | dn1[271] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 6 values |
| 353 | dn1[272] | copy | VERIFIED | unanimous, 368/368 pairs; source takes 3 values |
| 354 | - | zero fill | DEFAULT | zero in 368/368 and 5,760/5,760 |
| 355 | - | constant 0xba | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 356 | - | constant 0xce | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 357 | - | constant 0xf0 | DEFAULT | one value in 368/368 and 5,760/5,760 |
| 358 | - | constant 0x0c | DEFAULT | one value in 368/368 and 5,760/5,760 |

---

## 11. Reproducing this

```
npx tsx --test test/soundmap.test.ts
```

The test re-extracts every sound pair from the three held-out project files, runs
`convertDn1SoundToDn2` over each DN1 sound and asserts byte equality with the DN2 sound
Elektron produced. It also asserts that the mapping classifies each of the 359 DN2 bytes
exactly once and that no DN1 byte feeds two DN2 fields.
