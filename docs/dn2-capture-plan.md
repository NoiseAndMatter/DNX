# Digitone II capture plan

A test table for the device, aimed at the fields the matched pairs can never explain.

## Why this exists

Fourteen DN1 projects sit beside Elektron's own DN2 conversions of them, and that pairing
solved almost everything. But a matched pair only ever shows **what the importer does** — never
what a field *means*. Every remaining unknown is one the corpus cannot reach:

- Bytes no DN1 field explains, because the DN1 has no such feature.
- Codes whose numbering differs between the devices, where the DN1 value says nothing about
  the DN2 one.
- Whole regions Elektron's importer never touches.

## The method: one file, many known values

The obvious approach is one capture per change — the discipline the `emnyeca` corpus used, and
the one `docs/capture-protocol.md` describes. It is also slow, and mostly unnecessary here.

**If every parameter is set to a value no other parameter has, a single dump maps them all at
once.** The diff shows which bytes changed; the value in each byte says which parameter put it
there. Fourteen captures collapse into one, and the work at the device drops from an evening
to a few minutes.

This holds wherever the changed things are independent and the values are distinguishable.
Three cases break it, and each has a cheap fix:

| Problem | Why | Fix |
|---|---|---|
| **Toggles and short enums** | An on/off field can only be 0 or 1, so two of them are indistinguishable by value | Capture a **second file with the complementary pattern** — the byte that flips in both is the one that belongs to the toggle you flipped in both |
| **Long enums** | The value next along the list stores as `1`, which dozens of other fields also hold | Choose a value **far down the list**. The compressor's sidechain source runs COMP, NOT COMP, TR1 … TR16, INLR — nineteen entries — so `TR13` or `INLR` stores a byte nothing else in the capture will |
| **Rescaled fields** | Some values are transformed on the way in — one FX field is stored at roughly x201.57 of its UI value, so "73" never appears in the bytes | Set the parameter to its **maximum** and record what the display shows. The stored byte is then the field's top value, which collides with nothing, and displayed-max against stored-max gives the scale |
| **Wide fields** | A `u16` holding 300 writes two bytes, one of them 0 | Prefer values **between 1 and 127** so each lands in a single byte, and reserve larger values for fields known to be wide |

Two more rules make the result unambiguous:

- **Avoid the defaults.** Never assign 0, 64, 100 or 127 — those are what the untouched fields
  already hold, so a byte carrying one tells you nothing.
- **Always capture the baseline first**, unchanged, so the diff has something to be relative to.
- **Build every other capture by copying the baseline**, then applying that experiment's changes on top.
  Each capture must carry identical trigs; only settings may differ. A capture that omits a trig the
  baseline has reports it as a removal, burying the records the experiment exists to read — and since the
  trigger array is allocated in edit order and freed in place, a removed trig leaves a hole that shifts
  nothing back.

## Reading the result

```bash
npm run diff -- --chain captures/<Experiment>/
```

Offsets inside a 99,840-byte pattern payload are named automatically — `track 3 settings +0x0d
track length in steps`, not `0x4f8d`. A byte landing in a region marked unidentified is a new
finding, and the value in it says which parameter you set.

---

## 1. Trig conditions — one file, fourteen trigs

**Target:** the code tables for the two condition arrays at track `+0x100` and `+0x180`. We can
copy a DN1 trig's condition through an observed table but cannot author one, and no public
capture exercises these arrays at all.

The arrays are indexed by step, so one pattern can carry every condition at once: put a trig on
each of the first fourteen steps of track 1 and give each a different condition.

| Step | Condition | Step | Condition |
|---|---|---|---|
| 1 | FILL | 8 | 2:2 |
| 2 | FILL inverted | 9 | 1:4 |
| 3 | PRE | 10 | 3:4 |
| 4 | PRE inverted | 11 | 1:8 |
| 5 | NEI | 12 | 1% |
| 6 | 1ST | 13 | 50% |
| 7 | 1:2 | 14 | 99% |

One dump, and the step index gives the mapping for every code.

**The negation list has a principled hole.** The device offers no `not 1:2` and no `not 2:2`, confirmed
on hardware 2026-07-26. Both are already expressible: over a two-cycle, *not the first* is exactly `2:2`
and *not the second* is `1:2`. Elektron omits a negation wherever the complement is itself a single
`A:B`, which happens only at B=2 — from B=3 up the complement spans several plays and cannot be written
as one ratio, so all of those exist. Worth knowing before authoring a condition code: the value space is
smaller than the 35 x 2 the notation suggests.

## 2. The kit FX bytes no DN1 byte explains

**Target:** kit+5858, kit+5860 and kit+5878 — Elektron writes them, no single DN1 kit byte
predicts them, and they are the last of the FX residue.

FX parameters are one value each per kit, so a single file does it — and it should set **every** one of
them, not a sample. Any of them could be the source of the three unexplained bytes, and a parameter left
at its default says nothing.

The pages, from the manual's chapter 12: **Delay** TIME, X, WID, FDBK, VOL, HPF, LPF, REV; **Reverb**
PRE, DEC, FREQ, GAIN, VOL, HPF, LPF; **Chorus** DPTH, SPD, HPF, WDTH, VOL, DEL, REV; **Compressor** THR,
ATK, REL, MUP, VOL, RAT, SCS, SCF, DRY/CMP — thirty-one in total.

**When the assigned value will not go in, use the parameter's maximum and record the reading.** That
covers three cases that all break the assigned-value method: a range too small for its prime (compressor
MUP is 0-24 dB), a display that skips values, and a parameter shown in units rather than numbers. The
maximum is safe in all of them — it stores the field's top value, which nothing else in the capture will
occupy, and displayed-max against stored-max yields the scale.

**A parameter that skips values is telling you it is scaled.** Delay FDBK moves 14, 15, 17, 18, 20 — no
16, no 19 — which is what a smaller stored range looks like when displayed across a wider one; roughly
two displayed integers in three are reachable, consistent with 128 stored steps shown as 0-198. So an
assigned value cannot be trusted to appear in the bytes, and might land on one another parameter is
already using. Set any such parameter to its **maximum** and note the reading.

Two of those names mislead. Delay **X is ping-pong**, an on/off, not a time multiplier. Compressor **VOL
is Pattern Volume**, the kit's overall level, which makes it a candidate for `kit+5860` — a byte holding
only 0 and 100. Bipolar parameters take a **negative** value, since a negative byte stands out against a field of
positive primes — but not merely the negative of the assigned one. Until A3 says whether bipolar fields
are two's complement or offset from centre, a negative must avoid a collision under either reading:
`-17` is 239 as two's complement and 47 as offset, and 47 is already assigned. `-9`, `-13`, `-25` and
`-39` are clear both ways.

Two compressor parameters were missed at first and are worth naming, since both are candidates for the
unexplained bytes: **SCF** is the sidechain filter *frequency*, bipolar -64 to 63 rather than the enum it
was taken for, and **DRY/CMP** is the dry-to-compressed mix, 0-127.

Assign values from the **primes**: 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73,
79, 83, 89, 97, 101, 103, 107, 109, 113, 119. No prime is a multiple of another, so a field that turns
out to be rescaled still points back at exactly one parameter — which the ordinary ramp does not
guarantee. `X`, `RAT` and `SCS` are selectors and take the next setting along instead.

**There is no compressor on/off.** The page is THR, ATK, REL, MUP, VOL, RAT, SCS, SCF and the effect is
always in the path, so the originally planned "compressor off" capture is impossible. The second file
instead copies the first and moves only the four **selectors** — ping-pong, RAT, SCS, SCF. That isolates
the enum and toggle fields, which is what the pair was for: `kit+5878` holds only 0 or 1 across the whole
corpus, so something switch-like writes it.

## 3. The per-track array at kit+10264

**Target:** sixteen 5-byte entries whose default is `00 00 81 20 00`. Elektron writes
non-default values into individual entries; we never write it at all.

Per-track, so one file can carry a different change on each track:

- Track 2: a different machine — `[FUNC] + [SYN]` opens the MACHINE menu
- Track 3: assign a **MIDI machine**, which is how a track becomes a MIDI track
- Track 5: muted in **PATTERN MUTE** mode, `[FUNC]` + double-press `[TRK]`
- Track 7: a third machine, distinct again

**Pattern mute, not global mute.** The device has both, and only the pattern-scoped one can live in the
pattern or its kit; a global mute belongs to the project and would not appear in this comparison at all.

Machine type is the strongest candidate — the DN2 has selectable machines and the DN1 does
not, which is exactly the shape of a field no DN1 byte can explain.

Then one complementary file with all four reverted, since these are enums and toggles rather
than free values.

## 4. `dn2[54]` in the MIDI track record

**Target:** one byte taking 0, 41 and 42, with no DN1 source.

Configure MIDI track 5 with distinct values in one go: channel 3, program change 5, bank 7,
plus aftertouch and pitch bend enabled. The eight CC assignments are already mapped, so
anything else that moves is the answer. A second file with aftertouch and pitch bend disabled
separates the two toggles.

**Not every bipolar parameter is a byte.** `DEP` on MOD page 1 runs -128 to +127.98, so it is a 16-bit
fixed-point value rather than a byte. The device offers steps as fine as 0.01, and the display shows only
two decimals of something finer, so the scale is not safe to infer from the UI — sweeping the **smallest
available step** either side of zero against `1.00` gives it directly: the raw value of the smallest step
is the quantum, and its ratio to 1.00 is the multiplier.

Using the smallest step is also what makes the sentinel test work. A lock record stores two bytes per
step and `0xFFFF` means *unlocked*. If `DEP` is two's complement, the smallest negative step is raw -1 =
`0xFFFF`, colliding with the sentinel — so either bipolar locks are stored offset rather than signed, or
that value cannot be locked at all. A merely small value like -0.02 would be raw -2 and would pass the
collision untested, which is the trap this note exists to avoid.

**The byte-sized bipolar range is -64 … +63, not -64 … +64.** Elektron's manual gives `VFAD` as `-64–64`, which
would be 129 values and cannot fit a byte; the device offers +63, confirmed on hardware 2026-07-26. So
these are plain signed bytes and the `+64` step of the sweep goes unused. The manual is wrong here, in
the same way `libdigitone` was wrong about packing — the device is the authority, not the document.

## 5. Parameter-lock ids — one pattern names them all

**Target:** the parameter id table. A lock record is `{parameter id, track, value per step}`, and
we can copy an id through an observed DN1-to-DN2 table but cannot say what any of them *is*.
`docs/dn2-pattern-format.md` §4 lists this as unknown, and the manager needs it: "lock
parameter 19 to 40" is not something to show a user.

The lock table is the index here, exactly as the step arrays were for conditions. **Lock a
different parameter on each step of one track**, in a known order, and each produces its own
record — one dump maps every id at once.

The Digitone II has eight knobs per page, so one pass over the pages is 8 locks each:

| Steps | Page | Steps | Page |
|---|---|---|---|
| 1-8 | SYN page 1, knobs A-H | 33-40 | AMP |
| 9-16 | SYN page 2, knobs A-H | 41-48 | FX |
| 17-24 | SYN page 3, knobs A-H | 49-56 | MOD page 1 |
| 25-32 | FLTR page 1 | 57-64 | MOD page 2 |

Give each lock a **different value** as well as a different step, from the ramp in the method
above. Then the record's id says which parameter, its step says which knob, and its value
confirms the pairing independently.

Two passes cover the rest: a second pattern for SYN page 4, FLTR page 2, MOD page 3 and the
TRIG pages, and a third with a **different machine selected**, since the SYN knobs are machine
dependent and their ids may or may not move with the machine — which is itself worth knowing.

### Ruled out: the ids are not NRPN numbers

Worth recording so nobody spends the evening on it. Elektron's manual (Appendix C) gives every
parameter an NRPN LSB, and the observed DN2 lock ids 73-79, 89-96 and 104 line up suspiciously
well with the SYN pages' NRPN numbering, which is eight consecutive values per page.

It does not hold. The same corpus locks ids 30 to 41, and those NRPN numbers belong to the
**audio input mixer** — parameters a converted DN1 project cannot possibly have locked, since
the DN1 has no audio inputs. The resemblance in the 70s and 90s is a coincidence of two
schemes that both allocate eight consecutive numbers per page.

## 5a. The chord library — the one the corpus can never answer

**Target:** wherever the Digitone II keeps its chord library. The DN1 has no such feature, so Elektron's
importer never writes those bytes and no comparison of converted projects will ever reveal them. That
makes it structurally different from every other gap here, and the most valuable for a future manager.

Set up a distinctive chord and record exactly what was done — slot, chord, notes. If chords can be
assigned per track, use a different one on two tracks: a per-track structure announces itself in a diff.

### The arpeggiator: transferred already, but not understood

Both devices have one and its settings live inside the preset ("part of the Sound and saved together",
per the DN1 manual). `002 MORNING_JAM` uses arpeggios heavily, is one of the matched pairs, and converts
byte for byte — so MODE, SPEED, RANGE, N.LEN, LEN and OFS are demonstrably among the mapped bytes
already. See `docs/sound-mapping.md` §8a for the audit across all 29,509 corpus sounds.

**That is enough for the converter and not enough for the manager.** Fidelity and comprehension are
different goals: we can copy a byte perfectly while being unable to tell a user what it does, and an
editor cannot offer "MODE: UP, SPEED: 1/16" without knowing which byte is which. Nothing in the corpus
can say, because both sides simply agree.

So capture one preset with every arp parameter at a distinctive value, and a second differing only in
MODE — two presets one parameter apart isolate that field outright, and confirm the settings are per
preset rather than per pattern.

## 5b. Machines and filter types — use tracks as the axis

The Digitone II has four machines and six filter types; the Digitone 1's engine is now FM TONE and its
filter is Legacy LP/HP. The SYN knobs are **machine dependent** and the FLTR page is **type dependent**,
so their meaning changes with the selection and one capture cannot label them all.

**Sixteen tracks, each with its own preset, is the cheap axis.** Four machines fit on four tracks of one
pattern; six filter types on six tracks of another. The same value ramp can be used on every track, since
each preset is a separate object — nothing collides. Two patterns cover both selectors and both sets of
parameter layouts.

Start with page 1 of each. It identifies the selector byte and answers the structural question — whether
the machines share parameter offsets and reinterpret them, or each carries its own — which decides how
much work the remaining pages are.

## 6. Sound parameters — the long game

**Target:** the parameter map inside the 359-byte DN2 sound object, and with it the
parameter-lock id table. This is the largest unknown left, and the one that unlocks the
manager: "lock parameter 19 to 40" cannot be shown to a user as anything but "parameter 19"
until it is done.

Same method, at scale. One sound, every parameter on the SYN, FLTR, AMP and FX pages set to a
distinct value from a ramp, one dump. A second file with the toggles and enums in their
complementary positions.

The pages, from Elektron's manual chapter 11, are TRIG 1-2, SYN 1-4, FLTR 1-2, AMP, FX and
MOD 1-3, at eight knobs each. That is the order to walk, and combined with section 5 the same
capture serves twice: the sound object shows where each value landed, and the lock records say
what the device calls it.

**Sources.** Elektron's own manuals are the reference for parameter names and order —
[Digitone](https://www.elektron.se/wp-content/uploads/2024/09/Digitone_User_Manual_ENG_OS1.41_231108.pdf)
(OS 1.41) and
[Digitone II](https://elektron.se/wp-content/uploads/2024/10/Digitone-2-User-Manual_ENG_OS1.00A_241023.pdf)
(OS 1.00A). Third-party guides are useful for cross-checking but their text stays out of this
repository.

---

## What to send back

The `.syx` files, numbered, in a folder per experiment. Nothing else: the diff tool reads the
dumps directly and names the offsets itself.

---

## Naming the p-lock parameter ids — planned, not yet captured

A lock record stores a parameter **id**, and nothing yet says which id is which control.
`lockvalue.ts` can decode a slot three ways but cannot choose, so no editor can display a lock
value. This is the gate for the editor and for the manager's parameter views.

### What is already known

Two ids fell out of the A3 capture, which locked known parameters on track 3:

| Id | Parameter | Confidence |
|---|---|---|
| 9 | `VFAD` or `FADE` | the sweep shape matches both; A3 asked for `VFAD`, `FADE` and `DEP` in that order and only two records exist, so one was skipped |
| 29 | `DEP` | the fine-resolution sweep, unambiguous |

`VFAD` is on **TRIG page 2** and `FADE` on **MOD page 1**, so they are different controls on
different pages rather than alternatives — but the stored value cannot tell them apart, since
both are bipolar `-64…+63`. The capture below settles it.

### The pages, from the DN2 manual chapter 11

Machine-independent, so one capture covers every track:

| Page | Parameters |
|---|---|
| TRIG 1 | NOTE, VEL, LEN, PROB, LFO.T, FLT.T, FILL, COND |
| TRIG 2 | RTRG, VFAD, LEN, RATE, PTIM, PORT |
| FLTR 2 | DEL, KEY.T, BASE, WDTH, BW.RT, RSET |
| AMP | ATK, HOLD, DEC, SUS, REL, RSET, MODE, PAN, VOL |
| FX | BR, OVER, SRR, SR.RT, DEL, REV, CHR, OD.RT |
| MOD 1 / 2 / 3 | SPD, MULT, FADE, DEST, WAVE, SPH, MODE, DEP — once per LFO |

Roughly 61 controls. **Machine-dependent pages are excluded**: the SYN pages vary by SYN
machine (appendix A.2) and **FLTR page 1 varies by FLTR machine** (appendix A.3), so those need
one pass per machine and are a separate, larger job.

These lists were extracted from the manual mechanically and **three entries are suspect** —
`FREQUENCY`, `AMPLITUDE` and `TIME` appear as axis labels on the page's diagrams, not as
controls, and have been dropped above. Check the page against the device before capturing.

### The capture: one parameter per step

Do **not** give each parameter a distinct value. Give each one its own **step**, and let
position carry the identity:

> On an unused pattern, track 1, put a trig on steps 1…61. On step *n*, parameter-lock **only**
> the *n*th parameter in the list above, to any value that is not its current one.

Each lock record then has exactly one locked step, and that step's index names the parameter.
Reading it back needs no value table and no guesswork about rescaling, and a mis-entered value
cannot corrupt the identification — only a mis-entered *step* can, which is far easier to see.

61 records fits inside the 80-record table with room to spare. A pattern needs to be 64 steps
long to hold it, which is `LEN` = 64 on the pattern, not the track.

This also settles id 9: `VFAD` and `FADE` land on different steps.

### Mode-gated parameters — found mid-capture, 2026-07-26

**Not every control on a page is always present.** The AMP page's envelope depends on `MODE`:
in the default `ADSR` there is no `HOLD`, and in `AHD` there is no `REL`. So `HOLD` cannot be
locked in the same pass as the rest of the AMP page.

The step-per-parameter design absorbs this without rework. A record identifies itself by its
own locked step, so **skipping a step costs one record and nothing else** — the numbering of
every later step is untouched. The instruction is therefore "skip it and carry on", never
"change the mode and continue", because it is not known whether the device drops locks for
parameters that are invalid in the current mode, and finding out mid-capture would cost the
whole pattern.

Mode-gated controls go in a short follow-up pattern with the mode set appropriately.

**The selector itself has to go with them.** `AMP MODE` is on the same page as the controls it
gates, so locking it in the same pattern means moving the value that decides whether `HOLD`,
`SUS` and `REL` exist — with locks for those already entered on nearby steps. Skip it too.

The rule this gives, worth applying to any future sheet: **a selector that changes which other
controls exist must not share a pattern with the controls it gates.** In this list `AMP MODE`
is the only one. The MOD pages' `MODE`, `WAVE` and `DEST` select behaviour without adding or
removing controls, so they are safe in place.

For the 2026-07-26 run that means skipping `p2·6` (`HOLD`) and `p2·11` (`MODE`), and
capturing both in the follow-up.

**This raises a question worth answering deliberately.** If `HOLD` in `AHD` occupies the knob
position that `SUS` holds in `ADSR`, the two may share one parameter id — meaning the lock
table stores a **knob slot** rather than a named parameter, and an editor could not interpret a
lock without also knowing the track's `MODE`. The follow-up capture settles it: if `HOLD`
returns the same id as `SUS`, they are slots; a new id means they are distinct parameters.
Either answer changes what an editor has to model, so it is worth capturing before building one.

---

## The machine pages — capture by position, not by name

The last gap in the lock table. Ids **32..76** are unaccounted for and are almost certainly the
SYN pages and FLTR page 1, which change with the selected machine.

### Identify controls by page and knob

Earlier sheets named each control, which made them only as good as a parameter list pulled out
of a PDF — and that list was wrong twice. The manual's block diagrams contribute their labels
(`FM DRUM` page 1 absorbed thirteen of them), and `FM TONE` page 2 extracts incomplete however
the regex is tuned.

So this sheet asks for **page and knob** — "SYN page 1, knob A" — and leaves a column for the
name **the device shows**. The capture becomes its own source of truth for names, and a wrong
guess on my part costs nothing.

### One pattern, one machine per track

A lock record carries its track, so several machines can be captured at once and the records
stay separable. All four tracks reuse the same step numbers.

| Track | Machine | Pages | Locks |
|---|---|---|---|
| 1 | SYN `FM TONE` | 1-4 | 32 |
| 2 | SYN `WAVETONE` | 1-3 | 24 |
| 3 | FLTR `MULTI-MODE` | 1 | 8 |
| 4 | FLTR `COMB-` | 1 | 8 |
| 5 | AMP `MODE` = `AHD` | AMP | 1 — `HOLD` |
| 6 | AMP `MODE` = `ADSR` | AMP | 1 — `MODE` |

74 locks, inside the 80-record table.

### What it settles

**Whether the table stores a named parameter or a knob slot.** Compare the id for track 1 SYN
page 1 knob A against track 2's. Same id means the lock table addresses a *slot*, and no editor
can interpret a lock without also knowing the track's machine — a materially different model to
build. Different ids mean each machine has its own, and the table is simply larger.

Tracks 5 and 6 ask the same question of `HOLD` against `SUS`, which is already known to be
**90**, and confirm or break the two INFERRED ids `HOLD=88` and `MODE=97`.

Tracks 5 and 6 are separate on purpose: the gating selector is never moved on a track whose
gated control is being captured.
