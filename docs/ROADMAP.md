# Roadmap and progress

Living record of what is done, what is next, and why. Updated as work lands.

Companion documents: [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for defects and gaps,
[expansion-design.md](expansion-design.md) for the decisions behind the expander, and the
format notes in this folder for the byte-level detail.

---

## Scope

Two things, and everything is judged against them:

1. **A 1:1 Digitone 1 → Digitone II translation.** Whatever the source project holds should
   arrive on the DN2 unchanged. Where we cannot yet transfer a field, that is a gap to close,
   not a licence to improvise.
2. **Expansion** — the one deliberate departure from 1:1: sounds crammed onto the DN1's four
   tracks by sound-locking get their own tracks on the DN2's sixteen.

A **project / pattern / track / sound manager** is the third thing, and is where editorial
features belong. As of 2026-07-27 it is the active phase. The distinction matters when judging a
proposal: conversion is a *transplant* and should not clean anything up, while a manager is
exactly where a user asks for changes and can be shown what changed. Tidying the sound pool,
re-laying-out tracks by tag, and merging libraries all sit on the manager side of that line.

The manager works on **both devices**, but conversion stays one-directional: **DN1 → DN2 only**.
DN2 → DN1 is out of scope and nothing should be designed to accommodate it.

The DN1 → DN2 workflow is not a separate tool from the manager — it is the reason the project
exists. Sketch on the DN1, finish on the DN2 with more tracks, more voices and better arrangement
tools. It is **built and hardware-validated**, so it becomes the manager's first entry point
rather than a later phase.

---

## Where things stand

Reading and writing both formats is solved and validated on hardware. Conversion reproduces
Elektron's own importer byte-for-byte. Expansion works.

**The mapping phase is finished.** As of 2026-07-27 there is no format work blocking a user
interface: parameter locks can be named and decoded, every machine's parameters are resolved,
and the sound object's bytes have meanings rather than only sources. What remains is the
interface itself.

| | Status |
|---|---|
| SysEx container, both devices | done |
| Project container, LZ4 codec, CRC check field | done |
| DN1 project format — patterns, tracks, kits, sound pool, tail | done |
| DN2 project format — patterns, tracks, kits | done |
| DN1 to DN2 sound conversion | done, byte-exact on 5,760 sound pairs |
| Parameter-id and trig-condition tables | done, 58/58 and 35/35 |
| Writing project files | done, **loaded by a real Digitone II** |
| Pattern librarian (DN1) | done, **hardware-validated** |
| Expansion planning, rules, pins | done |
| DN1 to DN2 conversion | done, byte-identical to Elektron's importer |
| Expansion writer | done, **hardware-validated** |
| Compact per-pattern allocation | done, opt-in (`--compact`) |
| Aggregate sounds by name onto shared tracks | done, opt-in (`--aggregate`) |
| Reusing unused DN1 source tracks | done, on in compact mode |
| Hardware test sheet generator | done (`npm run sheet`) |
| Kit FX, mixer and external input | done, every DN1 FX byte placed |
| Machine selector (`sound+244`) | done, **hardware-validated** |
| Parameter-lock ids, fixed pages | done |
| Parameter-lock ids, machine pages | done, all ten machines |
| Sound object semantics | done, 54 offsets named and decodable |
| Remaining field transfers | see KNOWN-ISSUES — nothing blocking |
| Web UI | first version done — load, plan, export |
| Manager — pattern move/copy/swap/clear, batched, both devices | done (CLI), **hardware-validated** on DN2 |
| Manager — captured blank patternKit | done, DN1 and DN2, **hardware-validated** |
| Manager — convert/expand as entry point one | done (`--as-dn2`) |
| Project identity minted on authoring | done |
| Manager — storage-version and song guards | done |
| Manager — session model, undo/redo | done (`librarian/session.ts`) |
| Manager — UI, first slice (open, rearrange, undo, export) | done (`/manager.html`) |
| Manager — track operations inside a pattern | done (DN2), `librarian/trackmove.ts` |
| WebMIDI device transfer | not started — must be **multi-device**, see §3d |
| Transfer mode, DN1 → DN2 with two devices | idea, deferred (§3d) |
| Micro-timing features for the expander | idea, deferred (§3e) |
| GitHub Pages and CI | not started |

315 tests pass. `npm test` runs them; corpus-dependent tests skip cleanly without one.

---

## Done

**Formats.** Both SysEx and project containers, the LZ4 linked-block codec, the CRC check
field, and the internal layout of DN1 and DN2 patterns, tracks, kits and sound pools. The
Digitone II product ID `0x15` was established here and appears in no public source.

**Conversion.** `convertProject` reproduces Elektron's own importer byte-for-byte across all
fourteen matched projects, outside two residue regions and 146 bounded parity bytes.

**Expansion.** `planExpansion` decides which sound-locked sounds get promoted; the writer
moves their trigs, clears their locks, splits the parameter-lock table, switches claimed
MIDI tracks to synth and carries per-track settings and levels across. Verified by sound
identity: every trig still plays the same sound, 3,342 checked across three projects.

**Librarian.** Pattern copy between slots, banks and projects with minimal sound-dependency
resolution. Hardware-validated: a pattern copied into another project loaded and played
correctly, carrying exactly the four sounds it needed and no others.

---

## Next

Roughly in order of value.

### 1. Hardware validation — passed

`MORNING_JAM_EXPANDED.dn2prj` loads on a real Digitone II, tracks 9-16 carry their sounds and
honour their own per-track lengths, and every check run from the generated test sheet cleared
on the machine. The largest unproven assumption in the project is closed.

Still worth running when convenient: the same pass over the **compact** build, whose
per-pattern layout no Elektron file resembles.

`npm run sheet` generates a per-pattern test sheet from a converted file — positions named
as the device names them, A1..H16 and page·step — so a hardware session has something to
follow. Regenerate it after every build; every build stamps its time into the project name
so the device says which one is loaded.

### 2. Finish the field transfers

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md). The kit MIDI track records — the largest gap, and the
one that most plainly broke the 1:1 promise — are **done**: channel and CC configuration now
transfer, and the sixteen inherited track names with them, taking that region from 10,112
bytes per project to about 3. Pattern metadata is **also done** and now matches byte for
byte. What is left is the kit FX residue (~152, down from
397), the kit gap at 10252 (~117) and the tail project settings (~19).

### 3. Web UI — first version done

`npm run web`. Loads a `.dnprj` and a template, shows the plan, exports a stamped `.dn2prj`.
Entirely in the browser, publishable as static files.

Making it work forced a split worth knowing about: `container.ts` mixed the pure payload
format with ZIP decompression, so importing it in a browser pulled in `node:zlib` and failed
at load. The ZIP wrapper now lives in `projectfile.ts` and the browser brings its own, built
on `CompressionStream`. `test/web.test.ts` walks the import graph from the app entry point and
fails if anything reachable needs Node, so the boundary cannot rot.

Still to do here: pinning and reordering by hand, a per-pattern preview like the hardware test
sheet, and remembering the template between sessions.

### 3a. A device-authored test project, to crack what the corpus cannot — PLANNED

The table is written: [dn2-capture-plan.md](dn2-capture-plan.md).

**Queued by the user for straight after the first UI.** Build a DN2 project on the device in
which sounds and parameters are set to deliberate, known values from a test table, dump it,
and diff against a baseline. It is the `emnyeca` single-variable method, run for our own
purposes and aimed at the fields the matched pairs can never explain, because a matched pair
only shows what the *importer* does — never what a field *means*.

It is the only remaining tool for the residue we keep hitting:

- kit+5858, kit+5860, kit+5878 — the FX bytes no DN1 byte predicts.
- `dn2[54]` in the MIDI track record.
- The 16 x 5-byte per-track array at kit+10264.
- The 500-byte kit gap and the ~98,800 unidentified bytes of the DN2 tail.
- What the DN2 trig-condition codes at `+0x100` and `+0x180` actually mean.

The wider point is the right one: knowing what we clone is worth more than the bytes it fixes,
because it turns a transplant into an editor and unlocks the manager.

The plan uses **one capture carrying many distinct values** rather than one capture per change.
If every parameter holds a value no other parameter has, a single dump maps them all — the
changed bytes say where, the values say which. That collapses an evening of captures into
minutes, and `npm run diff` now names every offset in a pattern payload, so a clean capture
reads as a sentence. Blocked only on the Digitone manuals, which are needed to enumerate the
parameters of each page.

### 3b. The manager — REFINED 2026-07-27, active

The plan has been through two refinement rounds with the user: [ui-plan.md](ui-plan.md). The
paradigm, the first slice, the cuts and the scope are agreed.

**The paradigm: one project open and being edited at a time.** Within it — move patterns between
slots, replace kits, build kits, assign sounds to tracks. New material arrives through
**explorers, which are read-only sources rather than a second editable project**. Copying between
two projects comes later.

That paradigm settles a question an earlier draft left open: because you load once, operate many
times and export once, there is no chain of `MORNING_JAM(7).dn2prj` files, and where exports land
stops being a design problem.

**The first slice: open one project, move patterns between slots, export a verified result.**
Nothing else. CLI first, UI second, the way everything hardware-validated here was built.

**Conversion and expansion are entry point one, not a later phase.** An earlier draft filed the
DN1 → DN2 workflow under "cross-device, needs design", which conflated two different things. Whole
-project conversion with expansion is **done and hardware-validated** and already runs in the
browser; it should land the user in the editor on its result. What genuinely remains undesigned is
narrower — copying *one* DN1 pattern into an *existing* DN2 project, where the destination pool is
already populated and `planExpansion` allocates across a whole project rather than into a pattern
whose tracks may be occupied.

**A correction worth keeping.** The plan's first version claimed the manager was "buildable today,
nothing missing", citing `src/librarian/copy.ts`. That module is **DN1 → DN1 only**, so the
product's central operation did not exist for half its subject matter. The real preconditions:

| Precondition | State |
|---|---|
| DN1 pattern copy with sound-lock resolution | done, hardware-validated |
| DN2 pattern move | missing — a port, not research |
| One device-agnostic librarian over both | missing |
| Rewriting `slotIndexOffset` on every move | missing |
| Tolerating DN2 pattern record **version 2** | missing — the reader pins version 3 |
| Song guard on the move path | DN1 only — see 3c |
| Verify-after-write | missing |

Intra-project moves are *easier* than cross-project copies: the pool is shared, so sound-lock
indices stay valid and no remapping is needed. `planPatternCopy` already supports same-image copy.
The risk moves to `slotIndexOffset` — the record stores the slot it believes it occupies, DN1 in
`PATTERN.slotIndexOffset` and DN2 at meta+0x1C — and to version 2: the factory `PRESETS.dn2prj`
uses it and all 128 of its patterns fail our check, so **the untested case is the one a manager
meets first, a project the device itself wrote.**

**Cut from early work**, with reasons in the plan: the pattern inspector, the Overbridge knob-page
visual grammar, and side-by-side drag between two projects. **Kit work is near the front**, not
cut — in a single-project paradigm it *is* the project editor. What is genuinely blocked is
narrower: saving a standalone kit to the +Drive, and sourcing sounds from the device library.

**The device's own sound library is canonical** for kit building; project-derived sounds are the
fallback. Reading it needs SysEx, which is why WebMIDI moved earlier.

### 3b-i. The spine — DONE (CLI), 2026-07-27

`npm run rearrange`. Three modules, one job each:

| Module | Job |
|---|---|
| `librarian/shuffle.ts` | a reordering as pure data — where things move, and how to repair references to them |
| `librarian/device.ts` | one interface over both families, reporting differences rather than hiding them |
| `librarian/rearrange.ts` | plan, apply and **verify** a rearrangement inside one project |

27 new tests, 172 total.

**The full operation set: swap, move, copy, clear and keep** — all batch-capable except swap,
which has no single obvious meaning for many sources against many targets.

**Vacating a slot needs a blank, and the blank is captured, not invented.** `blank.ts` and the
generated `blankdata.ts` hold an empty patternKit taken from a device-initialised project, RLE
-compressed. `npm run extract-blank` regenerates them and **refuses any project whose empty
patterns disagree with one another** — the test that separates a device's initialisation
default from an importer's idea of empty. Measured: in `EMPTY.dn2prj` all 128 patternKits are
identical once the slot index and kit name are normalised, and two blanks in that file differ
by exactly one byte. In a *converted* project they differ by 13,811.

**Collisions require confirmation.** Any landing on an occupied slot, or the emptying of one,
is destructive; `plan.destructive` lists each with what replaces it, and `applyRearrange`
refuses without `confirmOverwrite`. The CLI equivalent is `--confirm`, and the UI equivalent
is a dialog listing exactly that array.

**Three guards, each earned:**

1. **The record knows its own slot** — DN1 `PATTERN.slotIndexOffset`, DN2 meta+0x1C. Moving
   bytes without rewriting it leaves a pattern that disagrees about where it lives. The
   verifier asserts it rather than trusting the writer.
2. **Storage version.** Measured, not assumed: `PRESETS.dn2prj` is version 2 in all 128
   records while the other 23 DN2 projects are version 3 throughout. An unsupported record
   is reported and refused, never parsed on regardless. See `dn2-format.md` §8a.

   **Likely a firmware question rather than a parsing one** — the hypothesis is that the
   version tracks the OS, and 1.10D's chord library is what bumped it. If so the right
   long-term behaviour is elk-herd's: fail when a project is newer than the instrument, warn
   when it is older because loading it should upgrade it. That needs the device's version,
   so it lands with WebMIDI. Refusing to edit an unparsed version stays correct until then.
3. **Songs**, via a tri-state rather than a boolean — `empty`, `occupied`, `unknown`. The DN2
   returns `unknown` because its song table has never been located, which warns instead of
   claiming a safety we cannot demonstrate.

### 3b-i-a. The hardware pass — PASSED, 2026-07-27

Digitone II, firmware 1.10E. `npm run hwtest` built a baseline and an operations file; both
loaded, and **all nine operations behaved correctly** — copy, move and swap in same-bank and
cross-bank form, batch move, batch copy and delete. Pattern names travelled intact. Full
results in [hardware-test-rearrange.md](hardware-test-rearrange.md).

**The baseline round-tripped byte for byte: 0 differing bytes in 12,889,604.** The device read
a project of 126 captured blanks and wrote back exactly what we gave it, in the header, all
128 pattern records, all 128 kit records and the 109,572-byte tail. That is a stronger claim
than "it loads" — our image is what the device itself would produce — and it retires the risk
behind the whole blank-capture exercise, since a synthesised blank could have loaded and still
been subtly wrong.

Three findings came out of the round-trip rather than the checklist:

1. **Header `0x18` is an identity/revision token, and we inherit it from the template.** Not a
   checksum: two projects with unrelated contents share a value. Everything we build from
   `EMPTY.dn2prj` claims to be `EMPTY`. Harmless so far, deliberately unfixed — see
   `KNOWN-ISSUES.md` for the experiment that decides it.
2. **An empty kit name is legitimate.** The device supplies `KIT <slot + 1>` lazily, when it
   loads a kit, so our blank clearing the name is correct.
3. **The project does not store the selected pattern.** Both files opened on `D1`; the
   zero-byte baseline diff proves no such field was written, so it is device state.

**The one row that failed was ours, not the device's.** The sheet said *"A13 and A14 have
exchanged"*, which at the hardware cannot be checked — both slots play, and without knowing
which started where there is nothing to compare against. Expectations are now **per slot and
name the pattern**, the generator refuses seeds that share a name, and it re-reads the file it
wrote to confirm every claim before printing. A wrong sheet is worse than no sheet, because
the tester reports our mistake as a hardware failure.

Not covered: the DN1 (the librarian handles it, but only the DN2 has been on hardware), songs,
and cross-project sound-pool references.

### 3b-i-b. Convert/expand re-homed as entry point one — DONE, 2026-07-27

The DN1 sketchpad workflow was built, hardware-validated, and stranded at the end of its own
command, producing an intermediate file you fed to a second command by hand. That made
conversion look like a **destination**. It is not — it is how a DN1 project *enters* the
manager, and `librarian/open.ts` makes that the shape of the code.

```
npm run rearrange -- --project sketch.dnprj --as-dn2 --expand
npm run rearrange -- --project sketch.dnprj --as-dn2 --expand --move A4 --to C5 --apply --out done.dn2prj
```

One command: convert, expand, land on the occupancy grid, rearrange, export. The grid header
says how the project got there, so nothing has to be re-derived downstream.

**Opening a `.dnprj` does not convert it by default**, and that is deliberate. The librarian
handles both families, and rearranging a DN1 project *as* a DN1 project is a real workflow —
someone tidying their Digitone has no use for a DN2 file. Converting silently would take that
away and hide a lossy, one-way step behind an innocent verb. There is no DN2-to-DN1 direction
and there should not be: sixteen tracks do not fit in four.

**The template is located rather than named** — `DN_TEMPLATE`, then `DN_CORPUS`, then a sibling
checkout — which removes `--template` from every invocation of the main workflow. It cannot be
bundled: the only honest source is a project a real device wrote, and those are the author's own
music. Not finding one is an error that lists where it looked.

`open.ts` is Node-only and listed in `tsconfig.web.json`'s exclude, beside `projectfile.ts` and
`zip.ts`. Anything here the UI eventually needs has to move down into a platform-free module
taking a `Uint8Array` rather than a path.

### 3b-iii. Next: undo/redo

Keeping whole images would cost 12.9 MB per step on the DN2,
so the affordable form is a **record-level snapshot**: store the previous contents of only the
slots an operation wrote. A swap costs ~200 KB, and the worst case — a 128-slot `--keep` — is
bounded by one image, which argues for a cache bounded by total bytes rather than step count.
`Undo.elm` has now been read — see the cross-check below. Its whole-model snapshot does not
transfer, but its `Tag` and `combiningTag` do.

**Track operations inside a pattern — DONE (DN2), 2026-07-28.** `librarian/trackmove.ts`, the
same move/copy/swap/clear, batch-capable, one level down.

It turned out to be a different shape from pattern moves, and the difference is the whole
module. A pattern is one contiguous `patternKit`; a **track** is six regions across two
records, and two of them do not move at all:

| What | Where | Part | How |
|---|---|---|---|
| track record — flags, conditions, probability, sound locks, length, speed | pattern `+0x0004 + t·1187` | sequence | copied |
| preset | kit `+60 + t·359` | preset | copied |
| MIDI record | kit `+5964 + t·268` | preset | copied |
| track level | kit `+0x1C + t·2` | mix | copied |
| **trigs** | flat 8,192-slot pool, each slot naming its own track | sequence | **rebuilt** |
| **parameter locks** | 80 records, each naming a track | sequence | **rebuilt** |
| **MIDI-track mask** | kit `+10,260`, one *bit* per track | preset | **rewritten bitwise** |

The DN2 keeps one trig pool per pattern where each slot carries a `track` byte, so a move that
copied bytes and stopped would leave every trig behind, naming a track that now holds something
else — the `sound+244` failure in a new place.

**Both tables are rebuilt rather than renumbered**, because renumbering is right for move and
swap and wrong for copy, which must duplicate. One rule covers all four: *a touched track ends
up with copies of whatever its source held; everything else is untouched.* A copy can exhaust
the 80-record lock table, which is refused rather than truncated.

**DN2 only.** The DN1 splits its tracks into synth and MIDI, so a move across that boundary is
not meaningful; it is refused with a reason rather than guessed at.

**The lock table's track byte is not where the trig pool's is.** A trig slot is
`track | step | note | …`; a lock record is `parameter | track | …`. The first version treated
byte 0 as the track in both, which matched the wrong records *and* overwrote each surviving
lock's parameter id with a track number — a lock on CUTOFF became a lock on parameter 3. Its
own test encoded the same assumption, so nothing caught it. Both tables now go through one
descriptor that names where the track byte sits. Fixed 2026-07-28.

**The synth/MIDI mask is carried, not disclaimed.** The module used to warn that the byte
deciding synth-or-MIDI "has never been located". It had been — kit `+10,260`, `u16be`, one bit
per track — and the warning was covering for the fact that the mask was in no region at all, so
a moved MIDI track arrived as a synth track keeping a MIDI record it would never use. It is now
rewritten bit by bit with the presets, and verification reads it back. Fixed 2026-07-28.

### 3b-ii. What elk-herd's Digitakt II support gave us


`00_References/elk-herd` (BSD 2-Clause) supports the Digitakt II, which is the **same storage
family** as the DN2 — its `patternStorage_sizeof` for version 3 is 89,088, exactly our DN2
pattern size, and three more of its offsets are ours unchanged (`dn2-format.md` §8a).

Adopted, with attribution in the module headers:

- **`Shuffle`** as a description of movement separated from its application, with
  `rereference` for repairing anything that points at a slot. It generalises: the sound pool
  is where reference repair stops being theoretical, since sound locks address it by index.
- **`patternKit`** as the unit of movement — pattern and kit together, the same pairing that
  makes a project pattern a SysEx pattern payload.
- **Blocker / warning / pass** instead of a boolean `ok`, because most of what a manager has
  to say is neither "fine" nor "impossible".
- **Blank data must be captured, never synthesised.** elk-herd embeds a compressed blank per
  version precisely because it "contains many fields elk-herd doesn't manage or decode" —
  the never-invent rule, reached independently.

Worth reading before the next phase: `Elektron/Digitakt/Related.elm` (dependency resolution)
and `Project/Selection/Bank.elm` for multi-select.

#### Cross-checked against elk-herd, 2026-07-27

After the hardware pass, every recent finding was held against elk-herd. Three confirmed, two
have no counterpart there, one changes the undo/redo plan.

**Confirmed — the blank.** `Elektron/Digitakt/Blank.elm` stores a compressed blank patternKit
**per storage version**, for our reason in almost our words: the structure "contains many
fields elk-herd doesn't manage or decode", so it "needs a binary copy". Same design, reached
independently, now validated on hardware at our end.

**Confirmed, and sharpened — versions track firmware.** This was the user's hypothesis; elk-herd
has the table. `Elektron/Instrument.elm` maps a device **build string** to
`{ projectSettings, patternAndKit }`:

| Digitakt II OS | Build | `patternAndKit` |
|---|---|---|
| 1.02 – 1.03A | 0035–0041 | 0 |
| **1.10, 1.10A** | 0048, 0053 | **3** |
| 1.15, 1.15A | 0065, 0069 | 4 |

Our Digitone II runs 1.10E and its pattern records read **version 3**. So the DN2 and DT2
share not just the storage family but the version numbering and roughly the firmware that
bumps it — and OS 1.10 being the bump point on the DT2 supports the chord-library
explanation for our version 2 corpus file rather than undermining it.

The comment beside the table settles our upgrade policy too: *"It can load older versions, but
will always produce these versions."* Fail on newer, warn on older, exactly as planned.

**A warning taken from the same place.** elk-herd keys this off the opaque build string and
says what it costs: an unseen build "is deemed incompatible, which always leaves people
hanging for me to update elk-herd when a new OS comes out". We should not copy that shape
without a graceful degradation — read-only rather than refuse, say.

**No counterpart — the project file.** elk-herd never opens a `.dtprj`; it works over SysEx
and the +Drive. The ZIP container, the LZ4 chain, the CRC and the image header are ours alone,
so header `0x18` gets no cross-check — not a contradiction, a gap where we are ahead.

**No counterpart — kit names.** elk-herd does not model them, so the `KIT <slot + 1>` default
stands on our own round-trip evidence.

**Changes the plan — `Undo.elm`.** It keeps **whole-model snapshots** in a list bounded by
*step count*. That is affordable in Elm, where persistent data structures share everything the
operation did not touch; a snapshot of our flat `Uint8Array` really is 12.9 MB. So the
record-level snapshot bounded by **bytes** stays right. Two ideas are worth taking, though:

- **`Tag`** — every undo entry is named with what the user did, for the drop-down. Cheap, and
  it turns undo from a stack into an account of the session.
- **`combiningTag`** — consecutive operations of the same kind collapse into one undo step, so
  a rename undoes as a rename and not a keystroke at a time. Note the detail that an undo or
  redo cancels an entry's ability to combine.

**Also worth knowing: elk-herd has no pattern editor.** `Project/` is Base, Import, Selection,
Update, Util and View — a librarian, not an editor. Track-level operations inside a pattern
have no precedent to borrow, so that phase is ours to design.

### 3e. Two micro-timing features for the expander — IDEA, deferred

**Recorded 2026-07-27 by the user, for after the manager and the UI work.** They are
deliberately antagonistic — a user would pick one — and both are per-project switches now that
would be better as **per-group** settings later, applied to `HH` but not `CP`. That per-group
shape is the real destination; `aggregateByName` already gives it the grouping to hang off.

**1. Micro-timing as a way to fit several sounds on one trig.** Used extensively by hand in
these projects: place trigs on the steps *surrounding* an occupied one and micro-time them all
the way towards it, then change the notes they play. Three instruments then sound as one hit.
The cost is that the surrounding steps are consumed, so it trades sequencer real estate for
simultaneity and cannot be applied blindly.

This is the natural successor to the clash rule shipped with `aggregateByName`, which
currently just leaves the losing trig where it is. `routing.blocked` already reports exactly
the trigs this would rescue, so the feature has a ready-made input and a measurable target —
20 trigs across the current corpus.

**2. Undoing whole-step micro-timing during expansion.** The inverse: a trig micro-timed a
whole step away from where it reads gets moved to the step it actually sounds on, and its
micro-timing cleared. Expansion is the moment to do it, since the trig is being rewritten
anyway and the DN2 has the tracks to hold the result honestly.

Note the tension with the 1:1 rule in **Scope**: conversion is a transplant and should not
tidy anything. Both of these are *editorial*, so they belong to the manager side of that line
and must stay opt-in, off by default, and reported — never applied silently to a conversion
someone expects to be faithful.

### 3c-i. A track is a sequence *and* a preset — SETTLED 2026-07-28

**Raised by the user 2026-07-27; answered by reading the DN2 manual, as they asked.** The
answer was better than the question: the device already implements the split, and it names both
halves. §16 KEY COMBINATIONS lists four copy/paste/clear units, of which two are the halves of
a track:

| Unit | Keys | What it carries |
|---|---|---|
| **TRACK SEQUENCE** (all trigs on the track) | `[FUNC]` + `[RECORD]`/`[STOP]`/`[PLAY]`, in grid recording | trigs, conditions, lengths, p-locks |
| **PRESET** | `[TRK]` + `[RECORD]`/`[STOP]`/`[PLAY]` | the track's sound |
| SEQUENCER PAGE | `[PAGE]` + … | 16 steps of one track |
| TRIG | `[TRIG]` + … | one step *with its parameter locks* |

**There is no whole-track operation on the hardware at all.** Moving both halves together is
ours, so `TrackScope` is `"sequence" | "preset" | "both"` — the device's two units, plus our
composite.

#### The vocabulary is the device's, not ours

From §5 and §9, quoted structurally rather than verbatim:

- a **pattern** contains a kit, sequencer data (trigs and parameter locks) for the 16 tracks,
  and the TRIG-page defaults, BPM, length, swing and time signature;
- a **kit** contains 16 presets, the track and pattern LEVEL settings, compressor and master
  distortion, send FX, track layering and pattern transpose;
- a **preset** contains the SYN, FLTR, AMP, FX and MOD parameter pages (MOD but no FX for MIDI
  presets), plus the PRESET SETUP and ARPEGGIATOR menus;
- a **track** is one of 16 sequencer tracks, audio or MIDI **according to its SYN machine** —
  there is no separate "kind" setting a user picks;
- a **page** is 16 steps of display. Up to 8 pages, so 128 steps. It is an editing unit, not a
  stored one — nothing in the format is per-page.

So the DN2's word for the sound half of a track is **preset**. The DN1 called it a *sound*, and
`soundmap.ts` and the corpus keep that name for DN1 things; DN2-side code says preset.

#### Two consequences that were not obvious

**LEVEL is in the kit but not in the preset**, so the device's own PRESET paste leaves it
behind. `scope: "preset"` therefore does too, and only the composite carries it. That is why
`TrackPart` has three values and not two — `mix` is neither half.

**Parameter locks are sequence-side but machine-dependent.** §16 confirms the ownership —
*"copy the trig with it's parameter locks"* — and `machineplock.ts` shows ids 33..76 and 78..81
mean different knobs on different machines. So a sequence landing on a track whose preset is a
different machine keeps locking id 58 while 58 now addresses something else. The bytes are all
correct and the meaning is wrong: the `sound+244` class of failure. `planTrackMove` reports it
as a warning and does not attempt a repair — rewriting ids across machines is a translation
problem, not a librarian's.

The composite scope cannot hit it, because the preset travels with the sequence.

#### Both surfaces, 2026-07-28

`npm run track` mirrors `npm run rearrange` one level down — same four operations, same dry-run
default, same `--apply --out` rule — plus `--pattern` and `--scope`. Its preview is
scope-aware, which took a second pass: printing the source's summary for the destination read
plausibly and described an operation the tool does not perform, because under `--scope
sequence` the preset never moves.

In the manager, selecting one DN2 pattern offers **Tracks…**, which drills into its 16 tracks.
The same selection model, the same four buttons, the same undo. `state.trackFor` is the only
new idea: one flag, not a second view, because a track move *is* a shuffle and only what it
indexes changes.

`librarian/tracksummary.ts` is what both read — the same reason `device.summarise` exists one
level up. A second implementation of "is this track empty" is a second answer waiting to
disagree.

**Two things the first cut got wrong, both found by the user opening the page.**

The drill-down was only reachable from a button that stays disabled until exactly one pattern
is selected, so it read as a feature that was not there. Double-clicking a pattern now opens
its tracks, and the button says what it wants when it is disabled.

Worse, **`hidden` did nothing** for `.tabs`, `.grid` and `.legend`. The attribute works by a UA
rule of `display: none`, which any author rule setting `display` beats — and each of those
classes sets one. Bank tabs rendered above an empty page, and the pattern grid stayed on screen
underneath the track grid. `[hidden] { display: none !important }` restores it once for the
whole page. `test/web.test.ts` now fails on any hidden element whose class carries a `display`,
which found the two pre-existing cases as well as the one that prompted it.

And a project could not be replaced without reloading the browser: the dropzone is the empty
state and is hidden for good once a project opens. **Open another…** sits in the top bar and
warns when there is undo history to lose, since nothing has been written to disk.

#### What this did not change

Sound locks were the other suspected hazard: they are sequence-side and reference the sound
pool. They turn out to be safe for track operations, because the pool is per **project** and a
track move stays inside one pattern — the indices remain valid. They would matter for a move
*between* projects, which is the transfer mode in §3d.

#### The drag now says what it will do — DONE 2026-07-28

The user's second piece of feedback on the same UI. The gesture worked, but one amber outline
served all three actions, so the destination said only *that* something would happen and the
*what* lived in the status bar at the far end of the page. The hovered cell now takes a hue per
action — blue moves, green copies, amber exchanges — and draws the word across itself.

The decision lives in `dragrules.ts` as `dropHint`, pure and tested, for the reason the rest of
that module is: *"does Ctrl over a batch draw SWAP?"* has a right answer, and finding it by
dragging things with a mouse is not a test anyone runs twice. It does not — a batch swap is
refused, and a refusal draws **nothing**, leaving the browser's own "no" cursor to say so.

Two things it needed that the plan had not anticipated, both written up in `docs/ui-plan.md`: a
modifier can change **without the mouse moving**, so `dragover` never fires and document-level
key handlers repaint the hovered cell instead; and a cell's own child labels fire `dragleave` on
it, which made the decoration flicker until `.slot > span { pointer-events: none }` stopped them
receiving drag events at all.

`test/web.test.ts` now reads `DropAction` out of the source and fails if any action lacks a
`.slot.target.<action>` rule. A fourth action would typecheck, name itself correctly, draw its
label — and be styled like nothing at all, because a missing CSS rule is not an error.

### 3c-ii. Taking track operations to the device — BUILT 2026-07-28, not yet run

`npm run trackhwtest` builds the artefacts. Nothing at track level has been near a device, and
two of the bugs PR #33 fixed are ones only a device can settle: the lock table's **parameter
ids** (a lock on CUTOFF became a lock on parameter 3) and the **MIDI mask** (a moved MIDI track
arrived as a synth track). Our reader agreeing with our writer is all the evidence there is.

#### One pattern per operation, and the reference stays in the file

Sixteen tracks is not enough room to keep thirteen operations from stepping on each other, so
the region an operation gets is a whole **pattern**: each step works on its own copy of the same
reference, and the reference itself sits untouched in `A1`. That is the pattern test's layout
moved up a level, and it buys something that test did not have — the tester flips back to `A1`
and reads the *before* off the device rather than off the sheet.

For the same reason there is **one file, not two**. The pattern test kept a separate baseline
because everything downstream depended on whether our captured blanks load at all, and that
session answered it. Here the reference has to be in the same project, or the tester is
switching projects to compare a preset name.

#### The scope split is what makes it falsifiable

A track has no name of its own, so identity is read from four things the device shows directly:
the **preset name**, the **trig count**, the **lock count**, and whether the track is **MIDI**.
The three scopes of the same move come first on the sheet because each isolates one half:

| Scope | The destination gets | The destination keeps |
|---|---|---|
| `sequence` | trigs, locks | its own preset name |
| `preset` | preset name, machine, MIDI bit | its own trigs |
| `both` | both, and the track LEVEL | nothing |

A bug that moves too much or too little shows up in one of those three rows. A test that only
ran `both` could not tell a working split from a composite pretending to be one. The `preset`
scope in particular has no precedent in anything tested so far.

#### Seeds are chosen from real content, and refused when they would not bite

A test aimed at empty tracks passes on a mover that does nothing. `chooseSeeds` requires two
differently named synth tracks with trigs, parameter locks on one of them, and two **adjacent**
empty synth tracks to land on — adjacent because a batch puts its second source at `to + 1`, and
spares picked independently would have the sheet claim an arrival on a track the batch never
writes. Running without `--pattern` surveys the project and ranks the candidates, since the
requirements are specific enough that guessing a slot is a bad way to discover them.

A missing MIDI track is **not** a refusal — they are rare in a sketch and eleven of thirteen
rows still earn a session — but the two mask rows are dropped and the sheet says so on its face
rather than quietly shipping eleven rows where thirteen were expected. Same for a pattern whose
tracks all share a LEVEL: that column then proves nothing, and the sheet admits it.

#### The expectations are a second statement of the rule, deliberately

`expectedAfter` restates the scope rule from scratch instead of sharing the CLI's preview or
calling the mover. An expectation derived from `applyTrackMove` would agree with
`applyTrackMove` whatever either did, and the generator's guard — *does the built file actually
show what the sheet is about to claim?* — would check nothing. It is the `fixtures-must-not-
come-from-the-code-under-test` lesson applied to a whole artefact rather than to one test.

It paid immediately. The guard refused the first build over seven rows, and the reason was a
format fact nobody had written down: **an emptied track is named, not nameless.** The captured
blank calls each track's preset `PRESET 1` … `PRESET 16`, by track number, so a cleared `T2`
comes back as `PRESET 2`. Recorded in `docs/dn2-format.md` §5. The sheet is better for it — the
tester now reads a concrete name off the screen instead of judging what counts as blank.

#### What elk-herd could not help with, for once

First time. It has no pattern editor at all, so there is nothing at track level to check against:
`Related.elm` is project-level cross-referencing between patterns, samples and sounds. The
manual remains the reference here.
### 3c-iii. Pattern rename — DONE 2026-07-28, batch schemes deferred

Asked for by the user, with batch renaming — by position, by selection order, from a base name,
or by some other rule — explicitly held back for later. `npm run rename`, plus **Rename…** and
<kbd>F2</kbd> in the manager. Both devices: each keeps a 16-byte name in the pattern record.

**It is the device's own operation.** DN2 manual §13.3.1, SETTINGS > PATTERN > RENAME. And the
field is already hardware-validated from the other end: every expectation on the pattern
rearrangement sheet was *"slot A13 should read `250423`"*, read off the device's screen and
checked. The name we write is the name it shows.

#### The librarian takes a map, though only one entry is ever passed today

`planRename` / `applyRename` take `slot -> name`. A batch scheme produces one of those and
nothing else, so every future rule lands downstream of a writer that has already been verified,
and the first scheme is a naming function plus zero new plumbing.

**A rename is deliberately not a `Shuffle`.** A shuffle answers *what ends up where* and every
operation on it moves whole records; a rename moves nothing and edits sixteen bytes in place.
Forcing it into that vocabulary would mean inventing a move that is not a move. Nothing needed
it: `Session.apply` takes any image-to-image function, so undo, redo and history worked with no
change at either layer. That is the seam being right rather than luck — it was built to store
images, not operations.

#### The alphabet came from the corpus, because the manual does not give one

§6.5 describes the naming screen and not its character set, so 13,488 pattern and preset names
were scanned. **Not one lowercase letter** anywhere. So input is upper-cased rather than
refused: the device has no lowercase to show, and rejecting `kick` while the hardware simply
types `KICK` is pedantry about a form with one meaning.

Preset names use **all 16 bytes with no terminator**, so the field is 16 characters, not 15.
(`writeProjectName` truncates to 15 for the *project* name, where the corpus never shows the
last byte in use. A real difference, not an inconsistency to tidy away.)

Beyond A-Z and the digits the corpus shows space, `!`, `%`, `&`, `-`, `_` and `Å Æ Ç Ö Ü`.
Anything printable in Latin-1 is allowed rather than exactly that list, which could only ever
record what nobody happened to type. A character the screen renders oddly is visible and fixed
by renaming again; a tool that refuses `#` for no statable reason is not.

Every transformation is **reported**, never silent — upper-casing, truncation, a dropped
character. Someone who types twenty characters and gets sixteen back should be told rather than
left to notice on the device.

#### Two things the tests found

A dropped character can expose a space that was in the middle a moment ago: `INTRO 😀` was
becoming `INTRO ` with a trailing space, because the trim ran before the filter. It now runs
after truncation too, which cutting mid-word can do the same way.

And `verifyRename` checks that the write touched **sixteen bytes per slot and nothing else**.
Re-reading the name is only our writer agreeing with our reader; the byte diff asks whether the
offset, the layout and the record slicing agreed as well. A stray byte would be invisible to a
name check right up until the device refused the project.

### 3d. Transfer mode — two devices at once, DN1 to DN2 — IDEA, deferred

**Recorded 2026-07-27 by the user, to be built when the project is more mature.** Not a
near-term task; here so the idea is not lost and so nothing built before it makes it harder.

Connect **both** a Digitone and a Digitone II to the computer. Browse the DN1's project list,
tick the ones you want, and push them to the DN2 — **converting and expanding on the way**.

The shape is deliberately smaller than the manager's: **no project is opened.** You are not
editing two projects as peers, you are reading one device's catalogue and writing to another.
That keeps it clear of the one-project-open paradigm rather than contradicting it. Selecting
several and transferring them is the same batch-with-a-queue-and-collision-report design the
librarian already uses; the collisions here are destination slots on the DN2's +Drive.

**Three things it implies for work that comes first:**

1. **WebMIDI must not be built single-device.** The obvious API — connect *the* instrument,
   then talk to it — makes this feature a rewrite rather than an addition. elk-herd is
   single-instrument by design and is not a guide here. Two sessions, each with its own
   identity, storage versions and firmware, held at the same time.
2. **The conversion runs on the computer, not on the device.** Pushing a `.dnprj` to the DN2's
   +Drive would simply leave it marked *needs upgrade*, and the device's own upgrade does not
   expand. So the flow is read DN1 → `convertProject` + `planExpansion` here → write a DN2
   project. That is exactly what the byte-identical converter is for, and this is the feature
   that makes it load-bearing rather than a convenience.
3. **It is the scenario that makes minted project identities matter.** Pushing five converted
   projects onto one +Drive is precisely the case flagged in `KNOWN-ISSUES.md` when we were
   inheriting a single identity from the template. Fixed before the feature needs it, which is
   the right order.

**Unknown, and the thing to research first:** whether the +Drive file API lets us enumerate and
read whole projects over SysEx. elk-herd's `Elektron/Drive.elm` models a drive as a tree of
entries with hashes and sizes, and `Instrument.elm` lists file-operation commands
(`dirCreate`, `dirDelete`, `fileDelete`, `itemRename`), which is strong evidence the transport
exists. Reading a *project* rather than a pattern dump is the part to confirm.

### 3c. Songs — deferred by the user, with a constraint to remember

Song mode and a song editor come **after** the pattern, kit and sound workflows. Recorded here so
the constraint is not rediscovered.

Moving patterns inside a project *is* rearrange mode, and the risk is a song referencing pattern
slots by index.

- **DN1: guardable today.** The song table is located — `dn1tail.ts`, `0x2efc`, 17 records of
  2,560 bytes, 99 rows of 21. `isSongTableEmpty()` exists and is **called by nothing**; wiring it
  into the move path is a day-one job.
- **DN2: not guardable.** The DN2 song table has never been located; `dn2-format.md` puts song
  mode among the ~98,800 unidentified tail bytes. **We cannot currently prove a DN2 pattern move
  is safe with respect to songs.**

Since songs are deferred, the manager ships with the limitation **stated in the UI** rather than
silently. Locating the table is one capture of the kind that has worked four times — build a short
song on the device, export, diff a baseline — and it becomes a prerequisite the moment song
support is real.

### 3c. The mapping phase — DONE, 2026-07-26/27

Four device-authored captures closed everything that blocked an editor. Written up in
`dn2-pattern-format.md` §4a/§4b, `dn2-format.md`, and `dn2-capture-plan.md`.

| Capture | What it settled |
|---|---|
| Trig conditions, p-locks, FX | the condition table, bipolar encoding, coarse/fine lock slots, the kit FX block |
| Machine pages | ids 33-81 are **machine-relative** — the same id means a different parameter on a different machine |
| Sound object | 54 offsets named, and its encodings match the lock table's |
| Follow-ups | `HOLD`, `AMP MODE`, `FTUN`, `HARM`, `FX BR` |

**Three lessons worth keeping**, because each cost time:

1. **Capture by position, not by name.** Parameter lists came from a PDF and were wrong four
   times — block-diagram labels read as controls, a stale OS version, an incomplete page. Asking
   for "SYN page 1, knob A" and letting the device supply the name removed the dependency.
2. **Give each control its own step or its own value, never both implicitly.** Every capture that
   identified controls positionally survived gaps, skipped controls and mis-entered values. A
   name-based sheet would have been ruined by any one of them.
3. **Use a blank project.** The sound capture used a converted one, so tracks carrying original
   music differed from the baseline in bytes nobody touched. Named offsets were confirmed by
   value match and are safe, but unmatched bytes proved nothing.

What is still open is small and blocks nothing: lock ids `32`, `63..65` and `86` are unclaimed,
and the four SYN 3 switches are ordered by inference rather than measurement.

### 4. WebMIDI — moved earlier, because three features now depend on it

Elektron's Transfer protocol over USB, so projects move without files. Larger than it
sounds; file-based I/O should still ship first, but this is no longer last.

**4a. Read the device's sound library.** The user considers the library on the connected Digitone
the **canonical** sound source for kit building — sounds recovered from project files are a
fallback. The library is not in the project file and its format is unknown, so this needs SysEx
sound-dump requests. Research.

**4b. The Kit request `0x62` / response `0x52`.** elk-herd documents this as family-wide. If the
DN2 answers it, **the response body is the standalone kit format** — the missing piece for "save
this kit to the +Drive as a named object", which is the kit builder's most wanted operation and
the one it currently cannot do. It is the only route to that format we know of, since kits do not
appear in a project file outside patterns. Cheap to try: send the request and see.

**4c. Sound preview, using the connected Digitone as the player.** Audition a sound by sending it
to the device and triggering a note, rather than synthesising anything ourselves. Requested by the
user; plausibly inexpensive once WebMIDI exists, and it is the feature that turns a file manager
into something usable for actually building a set. The open question is which slot or buffer a
sound can be pushed to **without disturbing the user's project**, and not disturbing it is the
hard requirement.

### 5. Publish

GitHub Pages plus a build and test workflow. Deliberately last — a few hours of well-trodden
work with no unknowns.

---

## Deferred, with reasons

**Rearrange mode** — letting the user re-lay-out tracks by tag rather than preserving the
DN1 order. Blocked on the DN1 song-row layout: the tail contains per-track references whose
position is unknown because every corpus row is empty. Moving a sound from track 2 to track
11 could desync a song. Preserve mode is also the only mode that can be verified against
Elektron's output, so it stays the default regardless.

**A promotion-ranking metric better than trig count** — 44 of 53 projects expand with no
overflow at all, so ranking rarely matters. The comparator is isolated for the day it does.

**DN2 pattern record version 2** — the factory `PRESETS.dn2prj` uses it and our reader
assumes version 3. Not blocking for conversion, which always targets version 3. It **is** a
prerequisite for the manager: the moment it opens a native DN2 project it may meet a version
2 record, and `checkDn2PatternRecord` currently fails on all 128 of that project's patterns.
Cheap to do properly — version the struct the way elk-herd does rather than branching inside
the reader.

**Manager prerequisites, so they are not discovered late.** Beyond version 2: any operation
that moves a track between indices must refuse when the song table is non-empty, because the
eight per-track bytes inside a 21-byte song row are located but not identified, and must
refuse when the 1,024-slot DN1 array is occupied, because its outer dimension may be the
track. `isSongTableEmpty()` and `isSlotArrayEmpty()` exist for exactly this and are currently
called by nothing — wiring them into the manager's guard path is the first thing to do, not
the last.

**Sound-pool clean-up** — collapsing byte-identical duplicates in a project's 128-slot pool.
`002 MORNING_JAM` holds 64 named slots and 57 distinct sounds, one of them repeated across
seven consecutive slots, so the saving is real. Deferred to the **manager**, not the
converter: conversion is a transplant and Elektron's own importer copies the duplicates too,
so doing it during conversion would be an unrequested edit.

The feature is only safe once **every** reference to a collapsed slot is repointed, and the
honest position is that we can enumerate the references we know about, not all of them:

- **Sound locks** address the pool by index and are fully enumerable — this part is easy.
- **Kit sounds are stored inline**, not referenced, so they are unaffected.
- **The DN1 tail holds no pool references at all** — verified across the 53-project corpus,
  `docs/dn1-tail-format.md` §0.
- **The DN2 tail's ~98,800 unidentified bytes are not ruled out.** Nothing says the device
  does not keep a reference there, and we cannot yet say it does not.
- **The 1,024 × 11-byte DN1 slot array** is UNKNOWN and empty in 50 of 53 projects; its
  populated values look like note numbers rather than pool indices, but that is a reading,
  not a proof.

So: collapse rather than compact (a duplicate's references move to the surviving copy, every
other slot keeps its index), and guard with `isSlotArrayEmpty()` the way rearrange mode is
guarded. Report what was removed rather than doing it silently.

---

## How to pick this up cold

1. Read [KNOWN-ISSUES.md](KNOWN-ISSUES.md) first — it names the traps that have already cost
   time.
2. `npm install && npm test`. Without a corpus, 26 tests pass and the rest skip; that is
   correct, not a failure.
3. The format documents in this folder tag every claim verified / inferred / speculative /
   unknown. Trust the tags: several sections exist to record what was ruled out.
4. The technique that solved almost everything: hold a DN1 value against the DN2 byte
   Elektron's importer produced, across the fourteen matched pairs, and keep only
   correspondences that hold for every sample. Parameter ids, trig conditions, track levels,
   track settings and kit FX were all derived that way.
