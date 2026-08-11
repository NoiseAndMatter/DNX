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

### 3c-ii. Track operations on the device — PASSED 2026-07-28, Digitone II firmware 1.10E

**24 of 25 rows answered, 0 failing.** All thirteen operations across all three scopes behaved as
the sheet claimed. Track operations are hardware-validated.

Both regressions PR #33 fixed are confirmed gone:

- **The MIDI mask.** Moving a MIDI track onto a synth track made the destination MIDI and left the
  source an initialised synth track; swapping a MIDI and a synth track crossed the bit both ways
  at once. Rows 4 and 5.
- **The lock table.** See below — the one row left blank turns out to be the strongest evidence on
  the sheet.

#### The blank row was a pass, and the tester's note is what proves it

Row 1 (`A2`, move `T2` onto `T1`, scope `both`) went unanswered: *"don't understand what the 4
locks should be. The first step is holding the track sound and has locked note, LEN, and 4 params
in MOD2: speed, MUL, DEST and DEP."*

Read against the file, that observation **is** the check:

| id | parameter |
|---|---|
| 2 | MOD 2 (LFO 2) **SPD** |
| 6 | MOD 2 (LFO 2) **MULT** |
| 14 | MOD 2 (LFO 2) **DEST** |
| 30 | MOD 2 (LFO 2) **DEP** |

Four locks, all on step 1, and the device showed exactly those four parameters on exactly that
page. Had the lock bug survived, byte 0 of each record — the parameter id — would have been
overwritten with the track number, collapsing all four onto id 0, and a vacated track would have
shown a phantom lock on parameter 255. Neither happened, and **no plausible wrong answer looks
like a coherent set of four MOD 2 parameters.**

**Why the count disagreed with the screen:** `note` and `LEN` are **trig-record** fields —
`track | step | note | velocity | noteLength | microTiming` — not parameter locks. Six things
looked locked and exactly four of them are p-locks. The next sheet should say so, because it
claims "4 locks" while the device highlights six knobs.

#### What the bytes settle without a tester

Diffing the reference kit against the moved one, the **only** kit bytes a `scope: both` move
changed were inside the two sound slots (`+68…+767`, within `+60 + t·359`) and six bytes of one
MIDI record. That answers three of the sheet's own quiet-failure items outright:

- **Send FX and track LAYERING did not move.** They live in the kit outside the preset, and no
  byte outside the sound slots changed. No tester check needed.
- **The unknown array at `kit +10,264` did not move** — disclosed rather than moved, as designed.
- **The MIDI mask at `+10,260` did not change** for a synth-to-synth move, which is correct.

Trig by trig, the moved track carried **everything**: sound locks 43, 26 and 17, probabilities 50%
and 75%, notes 59/65/62, note length 110, and the four p-locks — byte-identical to the source,
with the destination left completely empty.

#### The sheet asked for things without saying where they were

The tester's other note was *"give me a few key steps and params to check"* for microtiming,
trig conditions, send FX and layering. Fair, and my first reading of it was wrong: I assumed the
seed had no microtiming to check. It has — `T1` steps 44 and 60 at +23, and the MIDI track's
step 33 at +4. **Three of `T1`'s 36 steps, unmarked on a sheet that asked the tester to find
them by ear.** That is a search, not a check.

So the sheet now carries a **Where to look** table: every trig on the moved tracks that holds
anything beyond a plain note, **rarest first** — microtiming, then p-locks, then trig
conditions, with the repetitive sound-lock trigs summarised rather than listed. Attention is
the scarce resource in a hardware session, and listing forty sound locks in step order buries
the two microtimed trigs that were the point.

Two more wordings changed for the same reason:

- The lock item now says the count is **p-locks only**, and that `note` and `LEN` will also
  look locked on the device because they live in the trig record. That mismatch is precisely
  what stopped row 1 being answered.
- The retrig item now says retrigs are **not decoded by this build**, so the sheet cannot
  predict them and the tester should report rather than verify.

#### One observation still open

The project opened on **G2**, the pattern the test was seeded *from*, though the built file puts
its reference at `A1`. The tail is inherited from the source project **verbatim** — 0 differing
bytes of 109,572 — so a stored current-pattern would have come from `008 JAM.dn2prj`; but 97
appears at no stable tail offset across the corpus, and the header differs from the source only in
the project name. Unresolved, and settled by one behavioural test rather than more searching: load
another project, move to a different pattern, reload this one. Returning to G2 means the file
carries it; otherwise it is device state, which is what we already believed.

### 3c-ii-a. How the test was built — BUILT 2026-07-28

`npm run trackhwtest` builds the artefacts that produced the pass above. It was written when
nothing at track level had been near a device, and two of the bugs PR #33 fixed were ones only
a device could settle. The design notes below are kept because the next sheet — trigs, then
kits — should be built the same way.

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

### 3c-iv. WebMIDI — the protocol layer, and a wrong assumption caught by the probe

**Corrected 2026-07-28, on hardware.** The section below originally opened by announcing that
§3d's flagged unknown was *"answered: yes, whole projects can be read off the +Drive"*. **That
was wrong for the Digitone II**, and the way it was wrong is worth more than the code.

The +Drive filesystem API is real — elk-herd uses it — but elk-herd supports the **Digitakt II**,
and the claim was generalised across the storage family without evidence. The family shares a
*storage format*; it does not follow that it shares a *protocol surface*.

#### What the device said

The first probe of a real Digitone II, firmware 1.10E, build 0050:

| | |
|---|---|
| Product id (API space) | **43** — matching what `src/sysex/devices.ts` already recorded |
| Firmware / build | **1.10E / 0050** — the string the storage-version question waited on |
| Advertised messages | `0x01 0x02 0x03 0x04 0x06 0x07 0x09` and `0x50`–`0x5e` |

**None of the nine file-API codes are present**, and `DirList` timed out — two independent
signals agreeing.

#### And then the Digitone 1, probed alongside it

The user had both machines to hand, which turned a one-device observation into a family one.
A Digitone 1 on 1.42A, build 0097:

| | Digitone 1 | Digitone II |
|---|---|---|
| Product id (API space) | **20** | **43** |
| Firmware / build | 1.42A / 0097 | 1.10E / 0050 |
| API messages | `0x01 0x02 0x03 0x04` | `0x01 0x02 0x03 0x04 0x06 0x07 0x09` |
| Dump band | `0x50`–`0x5d` | `0x50`–`0x5e` |
| +Drive file API | **none** | **none** |

Product id **20** confirms what `src/sysex/devices.ts` had only inferred, so both halves of that
table are now hardware-checked.

Four things follow:

- **The file API is a Digitakt thing.** Two Digitones, two firmware generations, neither has it.
  elk-herd having it says nothing about this family — which is exactly the inference that went
  wrong above, now closed off properly rather than by one counterexample.
- **`0x03` and `0x04` are family-wide and old**, present since the first Digitone and named by
  no source we hold. That makes them the standing lead.
- **`0x06`, `0x07` and `0x09` are Digitone II only.** `0x09` is `Query`, so the obvious way to
  ask a device what `0x03` and `0x04` do is unavailable on exactly half the hardware.
- **Build numbers are per product line.** The older machine reports the higher number — DN1
  0097 against DN2 0050. elk-herd calls build "an increasing number", which is true within a
  line and misleading across two.

So: **the Digitone family has no +Drive file API.** Data moves by **dumps**, the `0x50` band, of
which we already parse `0x50` PATTERN_KIT byte-exactly and hold native captures.


#### Why this is the probe working, not the probe failing

The whole reason to build the smallest thing that needs hardware, before the thing that needs it
badly, is to find out which assumptions are wrong while they are still cheap. Had the transfer
layer been written first, this would have surfaced as a chunked read loop against a device that
never answers.

It is also why `Device` returns `supportedMessages` at all, and why reading it was worth doing
rather than assuming. `src/device/capabilities.ts` now turns that list into answers, and the
probe **checks before it sends** — a message the device does not implement produces a stated
refusal rather than a two-second timeout that reads like our bug.

#### What is left unexplored

`0x03`, `0x04`, `0x06` and `0x07` are advertised and appear in **no source we have**, elk-herd
included. On a device with no file API they are the only unexamined *messages*, so they are the
next thing to look at — possibly via `0x09` Query, which elk-herd implements and which answers
by key. Ten dump types in `0x55`–`0x5e` are uncatalogued, but that is a different question:
almost certainly dumps, of data we have not named.

#### The wire format, which was right



```
F0 00 20 3C 10 00 <8-in-7 encoded payload> F7

payload:  u16be msgId    a counter the caller allocates, echoed in the response
          u16be respId   0 in a request; the request's msgId in a response
          u8    code     0x01 Device, 0x02 Version, 0x10 DirList, 0x30/31/32 file reads
          …           arguments for that code
```

Header byte `0x10` selects the API. It is **device-independent**, unlike the dump protocol's
per-product byte (`0x0D` Digitone, `0x15` Digitone II), and the device identifies itself in a
`Device` response instead — in *a different product-id space*: elk-herd reads 12 Digitakt and 42
Digitakt II, while `src/sysex/devices.ts` records 20 Digitone and 43 Digitone II. Two spaces for
two protocols; conflating them is an afternoon.

**A response's code is the request's code + `0x80`.** `buildApi id … (id + 0x80)` — invisible
until nothing ever matches.

The 8-in-7 encoding is the one `src/sysex/codec.ts` already implements and has tested against
real Digitone dumps, confirmed identical to elk-herd's `ByteArray.SevenBit` including bit order
and the trailing partial group.

Strings are **Windows-1252**, NUL-terminated — not Latin-1. They agree except at `0x80`–`0x9F`,
and five of those 32 positions are *undefined*, so the table needs holes in it. It matters
because these strings are **paths**: a filename decoded wrongly is a file we then fail to open,
with the error blaming the device.

#### Read-only, deliberately

`FileWrite`, `FileDelete`, `DirCreate`, `DirDelete` and `ItemRename` all exist in the protocol
and **none are implemented**. A first cut that can delete files off someone's +Drive is a bad
first cut, and nothing we want needs writing until reading has been proven against a device.
A test asserts they are absent, so the gap stays a decision rather than becoming an oversight.

#### Multi-device is in the shape, not in a later refactor

`api.ts` is stateless — every function takes bytes and returns bytes. `DeviceSession` holds
everything that would otherwise have been global: the id counter, the in-flight table, the
timeout. **One per device**, and two sessions share nothing, which is the §3d requirement made
structural rather than remembered. elk-herd keeps all three at module level, so this is the one
place its design is deliberately not copied. There is a test that delivers one device's reply to
the other's session and checks it does not settle.

Ids start at 1: `respId` of 0 means *this is a request*, so a request numbered 0 would be
answered by something indistinguishable from one.

#### What is unproven, and what settles it

None of this has met a device. `web/probe.html` (`npm run web`, then `/probe`) is the smallest
thing that needs one — read-only, asks `Device`, `Version` and `DirList /`, prints what comes
back. It answers three open questions in one sitting:

1. **The storage version.** `Version` returns the build string that §8a of `dn2-format.md` has
   been waiting on since the v2-vs-v3 question was raised.
2. **What a DN2 actually implements.** `Device` returns `supportedMessages`, so we stop assuming
   a Digitone II speaks what a Digitakt II speaks.
3. **Whether the +Drive listing works as read.** One round trip.

One thing is **disclosed rather than assumed**: `FileRead` returns `start`, `end` *and* `length`,
and whether `end` is exclusive or inclusive is not established — elk-herd names the field and
never relies on it. Asserting the wrong one would fail every read on real hardware while looking
like a device fault, so it is carried through untouched and the payload is checked against
`length` instead. One session with a device settles it in a line.

### 3c-v. Reading a whole project by request — PASSED 2026-07-29, Digitone II

Transfer mode's read half. Individual requests are verified on both machines (§5c of
`dn2-format.md`); this turns one request into a plan of 257 and paces them.

> [!success] **First run: 257 of 257, zero silences, zero bad checksums**
> 14,662,233 bytes, every payload exactly its predicted size. Object numbers echo the request.
> Against last night's front-panel dump of the same project: **127/128 patternKits and 119/119
> sounds byte-identical, and ProjectSettings identical**. Full detail in `dn2-format.md` §5c.
>
> Two of the three questions below were answered as hoped, one better than hoped, and the
> 128th pattern turned out to be last night's bad checksum — see *What the run answered*.

`src/device/readplan.ts` says what a project is made of. `src/device/dumpreader.ts` executes a
plan. **Read project** on `/probe` is the page around them. Two files rather than one because
*what a project consists of* is format knowledge and *how to pace a request stream* is a transport
concern, and neither has anything to say about the other.

#### Per object, not `0x6f` — and the Digitone 1 decided it

elk-herd reads a whole Digitakt project with a **single** `0x6f` WholeProject request, then takes
the arrival of ProjectSettings as the end of the stream (`Project/Update.elm`, `receiveDump`). One
message out instead of 257. It was the obvious thing to copy and it is the wrong choice here:

1. **A Digitone 1 project dump carries no sound pool.** Verified in §5c — 128 PatternKit and one
   ProjectSettings, no `0x53` at all. The pool is exactly what the expander exists to unfold, so
   on the machine this project's whole workflow *starts* from, a whole-project dump is
   structurally incomplete. Asking for the 128 pool slots by number is the only way to get them.
2. **`0x6f` has never been sent to either machine.** The five per-object requests have, twice
   over, on both. That is the difference between a feature that works on the next hardware session
   and one that needs the session after it.
3. **A plan can be a subset.** "Read pattern A1" and "read the whole project" become the same code
   path with a different list — which is what transfer mode actually needs. `0x6f` is
   all-or-nothing at 14.6 MB every time, since §5c measured the device sending all 128 patterns
   regardless of occupancy.

The cost is 257 round trips instead of 1. At the observed USB throughput that is seconds.

#### Paced by completion, not by a clock

One request in flight; the next goes when the previous answer lands. A fixed delay would have to
be tuned to the slowest case and would still be wrong for anything slower than that. The wait
itself is sized from the payload, using elk-herd's own throughput figures — 200 B/ms for a
Digitakt, 800 for a Digitakt II — adapted with attribution and used the other way round, to decide
how long an answer of a given size may take rather than how fast to send one. A 3-second floor
sits under it, because a Digitone II PatternKit at 800 B/ms is 143 ms and no silence that short
means anything.

#### Three failures it is shaped around

1. **A silence must not stop the run.** A device may answer nothing for an empty slot. Aborting on
   the first one throws away the two hundred answers after it — the same lesson the probe's query
   sweep already paid for: the interesting result is a *mixture*, and only a run that continues
   can show one.
2. **A late answer must not be filed against the next step.** If step *n* times out and its answer
   arrives while step *n+1* is waiting, matching on dump type alone puts it against the wrong
   object and **every step after it is off by one** — silently, with all the bytes present and
   every checksum good. So an answer whose object number belongs to a step already given up on is
   counted `late` and the wait continues. A non-zero `late` count also names its own cause: the
   transport is slower than the wait, which on a Digitone means SYSEX DUMP is on USB+MIDI rather
   than USB (manual §13.4.2, ~3 kB/s on DIN).
3. **We do not know whether a response echoes the requested object number.** It should. It has
   never been checked for a *requested* object, and strict matching would turn that unknown into a
   hang. So a mismatch resolves the step and is reported — which makes the first run the
   experiment that settles it. If the count comes back non-zero, any rebuild must go by send order
   rather than by the number in the message, exactly as §5c already requires past 128 objects.

**No retries**, deliberately. A retry doubles the chance of failure 2 and buys little against a
timeout already sized from the payload. A silent step is reported as silent, and a second pass
over just those steps is a better tool than a retry because it is visible.

#### What the run answered — 2026-07-29, Digitone II 1.10E

Four questions went in, deliberately, and the report card was laid out to state them rather than
to celebrate a total. All four came back in one run of 14.6 MB.

1. **Does a requested response echo the object number?** **Yes** — `0`–`127` in request order on
   all three response types. So a reassembly may trust the number in the message, and the
   send-order rule §5c requires past 128 objects never bites inside a request stream, because a
   request cannot address past 127 in the first place.
2. **Does the device answer for an empty pattern slot?** **Yes, every one.** Zero silences in 257,
   blank patterns and empty pool slots included. Requesting behaves as dumping does.
3. **Does `0x63 n` reach the project sound pool?** **Yes — and it enumerates more of it than a
   dump does.** All 128 slots answered: 0–118 named, **119–127 empty**, and 119 is exactly how
   many `0x53` messages the front-panel dump sends. A dump carries the *occupied* pool; a request
   walks the whole table. Anything sizing a pool from a dump would have sized it 119.
4. **Was `G11`'s bad checksum a glitch?** **Yes, and now provably.** Tonight's 257 checksums are
   all good, and the only pattern that differs from last night's dump is `G11` — index 106, 6,433
   bytes. The corrupt copy is the old one.

And the result none of the four asked for, which is the one that matters most: **requesting and
dumping return the same bytes.** 127/128 patternKits, 119/119 sounds and ProjectSettings all
byte-identical across two independent acquisition paths. `0x60` returns the stored record, not a
live or re-serialised view of it.

The generalisable lesson is in question 4. The checksum caught the corruption, a re-read fixed it,
and a transfer that trusted a single pass would have written 6,433 wrong bytes into a project.
**A read is not finished until its checksums are** — so whatever rebuilds a project from a capture
must verify per message and be able to re-ask for just the failures. The `silent`-step report is
already the right shape for that; it needs a bad-checksum list beside it.

The bytes land in a `.syx` byte-identical in form to the 419 corpus captures, so every existing
tool reads it the moment it is saved. **Rebuilding a project file from one is a separate job** and
deliberately not started: reading had to be shown correct first, and now it has been.

### 3c-vi. Rebuilding a project from a capture — DONE 2026-07-29, both families on real captures

`npm run rebuild`. A `.syx` read off a device becomes a `.dn2prj` / `.dnprj`.
`src/project/rebuild.ts` plans, applies and verifies; the CLI has the shape the other tools use —
look first, `--apply --out` to commit, never overwrite an input.

Proven end to end on both machines:

- **Digitone II**: the 257-message read rebuilt to a project that opens, lists its 14 occupied
  patterns and their trig counts, and passes the payload check.
- **Digitone 1**: the 133-message read **plus** a 93-message front-panel pool send rebuilt to
  98.03% from the wire — and `npm run plan` resolves **31 distinct sounds** through its sound
  locks, exactly the 31 pool slots the patterns reference. The locks resolve, so the pool landed
  in the right slots.

#### A capture is 99.5% of a project, and the rest comes from a donor

Measured, with the placements in `dn2-format.md` §5c. On a Digitone II, 12,825,984 of 12,889,604
bytes are on the wire. The **63,620 that are not** are the image header (project name and the
identity token), the tail before the pool, and everything after the settings record — where the
**song table and slot array** live.

So this is a *restore onto a donor*, not a reconstruction from nothing, and the report **names**
what the donor supplied rather than counting it. "63,620 bytes came from elsewhere" tells nobody
anything; "the song table came from elsewhere" tells them whether to care. The default donor is
the template, because a device-authored blank contributes an *empty* song table rather than
another project's.

**A new identity is minted**, for the reason PR #26 established: a rebuild authors a project, and
inheriting `0x18` made everything built from `EMPTY.dn2prj` claim to be `EMPTY`.

#### Three refusals, each earned

1. **A bad checksum is never written.** `G11` is the whole argument — one message in 248 with
   6,433 wrong bytes and nothing else out of place. A rejected record leaves the donor's bytes in
   place and is named.
2. **More records of one kind than there are slots.** A +Drive soundbank of 182 or 256 sounds
   would place its first 128 and then overwrite all of them with the saturated remainder. The
   refusal costs something honest, and the cost is stated: a read *plus a repair pass* also
   exceeds the count and is indistinguishable from the bytes, so both are refused.
3. **A Digitone 1's sound records, until told what they are.** See below.

#### The DN1 ambiguity, found by being challenged

A Digitone 1 sends **kit track sounds and pool sounds under the same dump type** — both `0x53`,
both numbered, both 302 bytes. Placing a request's four kit sounds as pool slots 0–3 would
overwrite sound-lock targets with whatever the tracks happened to be using: silent corruption of
exactly the data a DN1→DN2 expansion depends on.

It was caught because the user asked whether we had really understood that a DN1 project *does*
have a 128-slot pool. It does, and the rebuilder was about to write into it on a guess. It now
refuses until told, and a DN2 needs no such flag because `0x63` is the pool there either way.

`--pool <file.syx>` is the workflow that follows from the hardware: give it the project read and
the panel pool send, and it drops the project capture's own `0x53` records — which are kit sounds
already carried inside their patternKit — before merging.

#### How the DN1's `0x63` was pinned down, four ways

Worth recording, because the first reading was asserted on one piece of evidence and the user was
right to push twice:

1. **Count.** Four answers where the pool holds 93.
2. **Silence on occupied slots.** The project's locks reference 31 distinct slots up to 91; the
   device answered none of them.
3. **Contents at matching indices.** Pool slots 0–3 are `VBASS HZ-DAFT`, `GNARLY_PUNCH`,
   `-- BASS 6 MF`, `BASS 1 MF`. `0x63` returned `CZ NE`, `MOVEMENT`, `TROLLEY TK`, `CATHARSIS`.
   No overlap.
4. **Index alignment with a kit.** Each matched one pattern's track slots in order — sound 0 to
   track 1, sound 3 to track 4.

Three of the four are absent from the pool entirely, and that is the *normal* case rather than an
oddity. On a Digitone 1 a sound can be assigned to a track **straight from the +Drive sound
library**, and it then lives only inline in that kit. The pool is the project's own quick-access
store, and its other job is the one that constrains us: **a sound lock can only point into the
pool.** So a track sound need never appear there, and `MOVEMENT` is in both only because it was
loaded into the pool as well.

**Which is why a two-capture restore is complete.** The `0x50` records carry every track sound
whatever its origin, library or pool; the panel pool send carries every lock target. Between them
nothing a DN1 project can hold is unreachable — which is what the expansion depends on, since
sound-locked sounds are exactly what it unfolds onto their own tracks.

#### What is deliberately not done

Rebuilding **into** a device — that is the write half, and it is §3c-vii below.

### 3c-vii. Writing to a device — WORKS, verified on a Digitone II 2026-07-29

> [!success] **The null round trip verified, first attempt**
> Pattern `A1` written back to slot `A1`, then requested: **99,840 bytes, byte-for-byte identical,
> both checksums good.** The device returned exactly what was sent, so writing works on this
> family — and since the bytes were identical to the slot they came from, nothing on the
> instrument changed.
>
> Verified **offline from the saved capture**, because the page was still eating its own verdict at
> the time. The capture holds both reads of `A1` — the original and the read-back — so the proof
> did not depend on the UI working. `KNOWN-ISSUES.md` has that story; the short version is that
> **the evidence outlived the bug**, which is the argument for capturing raw bytes rather than
> rendering conclusions.

The first thing in DNX that can destroy someone's work. `docs/device-probing.md` gained a
**Writing** section *before* any of this was written, and the parts that belong in code rather than
prose are in `src/device/dumpwrite.ts` — because a rule that lives only in a document is a rule
that holds until somebody is in a hurry.

#### Why now, and not before

Not because it was the remaining box. Because **reading made it verifiable**. Until a device could
be read by request, "did that write land correctly?" could only be answered by looking at the
instrument's screen. It can now be answered exactly: write a record, request it back, compare the
bytes — the same round trip that caught `G11`.

So the rule in code is: **a write is not finished until it has been read back and compared.** Not
"the device did not complain" — the device does not complain. A device that stored the bytes, one
that ignored the message, and one that stored them in the wrong slot are indistinguishable from
the sending end.

#### The first write is the one that cannot change anything

`nullRoundTrip` sends a record **back to the slot it came from**, identical bytes to the same
place. If the write path works, nothing changed. If it is broken, nothing changed either. If the
bytes land somewhere else, the read-back shows it while the original is still in the capture.

It is deliberately the least interesting write imaginable, and it is a named function rather than a
comment on a general one so that it is the *easy* thing to do.

The page enforces the same order: **Write back** stays disabled until a device has been probed
*and* something has been captured, because a record can only be sent back to where it came from if
it came from somewhere.

#### Five guards, each refusing rather than warning

1. **Payload size must equal the record's size for that family.** A short payload is not a partial
   write to tolerate; it is a different message.
2. **Object number range.** One byte stands between the intended slot and somebody's work.
3. **Storage version must match a witness** — a record actually read from the target device in this
   session. Checking against a firmware table would only test our belief about the firmware;
   checking against the device's own bytes tests the device. An unversioned record reads as
   `unknown` and fails rather than passing silently.
4. **`0x54` ProjectSettings needs a stated reason.** It is global state, not one slot — on a DN1 it
   is everything up to the song table.
5. **A Digitone 1's `0x53` needs one too.** Its *read* direction turned out ambiguous — kit track
   sound or pool slot — so its write direction is unproven, and an unproven write is not the place
   to find out.

#### What is unknown, and is treated as unknown

- **Does a write reach the +Drive project or the active copy in RAM?** §5b's round-trip evidence
  points at the active copy, which would mean a write needs a manual save to persist — a safety
  feature if true. It is not established, so the code assumes the write is permanent.
- **What happens writing to an occupied slot.** Prompt, overwrite, refusal — unknown. Which is why
  the first non-null write should go to an empty one.

#### The hardware session, in order

1. Export every project that matters. Confirm the exports parse.
2. Load a **scratch** project. Read it, so there is both a capture and a witness.
3. **Write back** — the null round trip. Verify.
4. Only then: write a record to an *empty* slot, and read the whole project again to confirm
   nothing else moved.

### 3c-viii. Writing to a chosen slot — PASSED 2026-07-30, Digitone II

> [!success] **A pattern copied into an empty slot, exactly**
> `A1` written to `H16`. Read back and compared against the whole earlier capture: **`H16` is
> byte-identical to `A1` across all 99,840 bytes except one** — the slot-index byte at `0x15AF0`,
> which correctly reads 127. **No other slot in the project changed.**
>
> A write is surgical, the restamp works, and the device accepts a pattern into a slot it did not
> come from.

#### Where a write lands — and why the obvious test is worthless

**[verified]** This section originally proposed power-cycling without saving to find out whether a
write reaches the +Drive. **That test cannot answer the question**, and the user said so:

> *"DN1 and DN2 allow you to work on them and if you just switch them off without saving, when you
> switch them on they restore themselves to the exact same state."*

The working state is **itself persistent across power cycles**, so surviving a reboot is consistent
with *both* answers. The experiment as designed produced a result that meant nothing — a reminder
that a test has to be able to come out both ways before it is worth running.

The discriminating test is switching projects:

> *"if I change projects it will tell me there are unsaved changes, and if I disregard and don't
> save, then open the modified project again, it will not contain the change."*

**So a write lands in the device's active project state, not in the +Drive project file.** It
survives power loss and does not survive loading another project. The device's own **SAVE PROJECT**
is the commit step.

#### What follows, and it is mostly good news

- **A write is not permanent until the user saves.** A real safety property, and a stronger one
  than anything in our code: the undo for any live edit is *don't save, load another project*.
- **It is only a safety property if the user knows.** A live manager that writes without saying
  "now save on the device" silently loses work at the next project change. That is a **UI
  requirement for §4a**, not a footnote.
- **`0x54` ProjectSettings stays gated.** Nothing here says what a settings write touches, and the
  active-state finding does not extend to it.
- Still unknown, deliberately: **what happens writing to an occupied slot.** `H16` was blank.

#### How it is built

The first write that changes something. `writeToSlot` copies a captured pattern into a different
slot, **restamping the slot-index byte the record carries** — a record written to a slot it does
not claim is one the device may file under its own idea of where it belongs.

The destination is judged against the **captured blank** rather than against our idea of empty.
`looksBlank` ignores the slot index and the kit name, because a blank in slot 5 legitimately
differs from a blank in slot 0 at exactly those places, and counting that as content would call
every empty slot occupied.

This is the experiment that answers the last two unknowns in `device-probing.md`:

**Both** of `device-probing.md`'s open questions were aimed at here; one is answered above, and the
other — **what happens to an occupied slot** — is still open. The control defaults to `H16` and
warns when the destination holds work, so that answer can be obtained deliberately rather than
discovered.

---

## 4. The device-first future — PLANNED 2026-07-30

**Raised by the user**, and it reframes what DNX is: not a file tool that can talk to a device, but
a **device manager** that also reads and writes files. Files stay — as the second option rather
than the only one.

Recorded in full, because the ordering below is not arbitrary: several of these unlock each other,
and one is a much bigger jump than it looks.

### 4a-i. BUILT 2026-07-30 — a device is a source, and files are not demoted

`src/device/deviceproject.ts` and `web/src/manager/devicesource.ts`. **Open device…** reads a whole
project off a connected instrument and opens it exactly as a file opens; **Write to device** sends
back only the records the edits changed.

**Nothing above it changed.** `rearrange`, `trackmove`, `rename` and `convert` all work on a decoded
image and know nothing about MIDI, so every one of them now works on a live device without being
touched. A project read off a Digitone can be exported to a `.dn2prj`, and one opened from disk can
be written to a device — the symmetry is free because the library speaks images, and it is what
keeps files a first-class option rather than a fallback.

The shape, in one line: **edit as an image, transmit as a diff.**

- Reading gives an image because that is what the rest of the codebase speaks.
- Writing an image back would be ruinous — 128 patternKits is 14.6 MB and minutes of transfer to
  change one slot — so `writeChangedRecords` diffs the edited image against the one that came off
  the device. **A move is two messages; a rename is one.**
- The missing 0.49% disposes of itself: those regions are donor-supplied and therefore identical on
  both sides of the diff, so they are never transmitted. An edit that *did* touch them — a song, a
  project name — is **named** rather than silently dropped.

Guards: a transfer-sized change is refused unless asked for deliberately, every send is followed by
`settleMsAfter`, and verification is a **separate call**, because a device acknowledges nothing and
a function claiming to *write and verify* would be reporting one outcome for two operations.

**PASSED on hardware, 2026-07-30 09:21.** A project opened from a Digitone II, patterns moved,
written back, all of it verified — **no file anywhere in the loop**. See `MILESTONES.md`.

#### One thing the device does that could be misread

**The DN2 announces the pattern it has just taken, and shows only the last one.** Write several and
its screen names one. That is the instrument's own UI reacting to the most recent record, not a
report of what arrived — it acknowledges a SysEx write with *nothing at all*, so the message is
neither a confirmation nor a count.

The user checked, and every changed pattern was transmitted. Recorded because **"one message" reads
as "one pattern written"**, and a later session watching that screen could reasonably conclude a
batch had failed when it had not. The only proof remains a re-read.

### 4a. The insight that makes it cheap — live management needs no image

The obvious way to build "manager on a live device" is to read the whole project, edit the image,
write it back. **That is the wrong shape**, and §3c-vi already shows why: a capture is 99.5% of an
image, so a round trip needs a donor for the header, the song table and the slot array — none of
which a pattern move touches.

The right shape is per-record. Moving `A1` to `B5` on a live device is:

```
0x60 read slot 0   →   0x50 write slot 20
```

Two messages, ~230 KB, no image, no donor, no missing 0.49%. **Every manager operation is already
expressible as reads and writes of records the device speaks**, because `shuffle.ts` describes a
rearrangement as pure data — `movesTo` / `cameFrom` / `sourceOf` — and never needed an image to say
what a move *means*. It needed one only to apply it.

So the work is a **second applier**: `rearrange.ts` writes into a `Uint8Array`, the device version
writes into an instrument. Same plan, same verify-after-write shape, different target. This is the
highest-value item on the list and among the cheapest, because the plan layer exists and is already
hardware-validated.

**Answered 2026-07-30 (§3c-viii): a write lands in the active project, not the +Drive.** So live
management is *safer* than it sounds — nothing is permanent until the user presses SAVE PROJECT on
the device, and the undo for any live edit is to load another project without saving.

But that is a safety property only if the user knows about it. **The manager must say so**, at the
moment it writes and not in a help page: a live manager that silently depends on a save is one that
loses work at the next project change. Treat it as a functional requirement of §4a.

### 4b-i. The expansion planner — BUILT 2026-07-30, library only

`src/expand/deviceexpand.ts`. Joins stages that were each already proven: read a DN1, read the DN2,
convert and expand, diff, send only what changed. **Plans and transmits nothing.**

#### The destination device is its own template

`convertProject` transplants into a DN2 project, which until now meant a **file** — found via
`DN_TEMPLATE`, `DN_CORPUS` or a sibling checkout. Reading the **destination** supplies one for free,
and a better one: **its storage version is right by construction**, because it came off the machine
that has to load the result. §8a is a long story about versions differing between firmwares, and a
template read from the target cannot be the wrong version for the target.

It doubles as the **diff baseline**, so expanding onto a DN2 that already holds most of the answer
costs only the patterns that changed rather than 14.6 MB every time.

#### The refusal is the substance

A DN1's pool **cannot be requested** — `0x63` reaches the four kit track sounds, and a project dump
carries no `0x53` at all — and the pool is *exactly* what expansion unfolds, since sound-locked
trigs point into it. Expanding from a DN1 read alone would convert without error, write
successfully, and lose every sound-locked sound.

#### The corpus caught the guard being wrong within a minute

The first version refused on **any** empty referenced slot. `003 AMBZ.dnprj` promptly failed it:
five trigs locked to pool slot 11, which holds a **framed but nameless** sound. That is a dangling
lock in a real project — nothing to do with how it was read, and the file path has always tolerated
it. Refusing would have blocked a project that converts perfectly well.

The guard now separates two failures that look identical from one slot's point of view:

| | Signal | Response |
|---|---|---|
| Dangling lock | some referenced slots empty, pool otherwise populated | **warn** |
| Uncaptured pool | locks exist and **all 128** slots are empty | **refuse** |

**Framing cannot distinguish them** — a real DN1 pool is 128/128 framed with as few as eleven
sounds actually in it. The name field can.

### 4b. Two devices at once — DN1 to DN2 without a file

Already in the architecture rather than waiting on a refactor: `DeviceSession` keeps all state per
instance, one per device, and a test delivers one device's reply to the other's session and checks
it does not settle. That was done in §3c-iv for exactly this.

Every stage now exists and has been proven separately:

```
DN1  --0x60 x128-->  patternKits  --+
                                    +--> convert / expand --> 0x50 x128 --> DN2
     --panel pool send-->  pool  ---+
```

**The one gap is not technical.** A DN1's pool cannot be requested (§5c), so that step needs the
user to press buttons on the DN1. Any "one click, DN1 to DN2" claim must be honest about that — or
wait for one of the nine unidentified DN1 dump types to turn out to be the pool.

### 4c. Sound explorer and kit creator — DN2

`0x62` Kit and `0x63` Sound are verified requests on the DN2, and `0x63` reaches the **project
pool** there, all 128 slots. So a sound explorer over the live pool is largely a UI job on top of
readers that already exist — `soundparams.ts`, `machine.ts`, `soundmap.ts`.

The kit creator needs kit *writes*, `0x52` — the same class as the pattern writes now proven, with
the same guards. Lower risk than it sounds, and it must reuse `dumpwrite.ts` rather than grow its
own send path.

### 4d. Sound Pool editor — DN1

> [!warning] **Corrected 2026-07-30.** This section said the DN1 pool had "no known write path".
> That was wrong in emphasis, and the user caught it: it conflated the *request* code with the
> *data* message.
>
> - **`0x63`** is the request. On a DN1 it is aimed at the kit's four track sounds.
> - **`0x53`** is the data message — and the panel pool send proves the pool **travels as `0x53`
>   with an object number**, straight from the device.
>
> `0x63` being aimed elsewhere says nothing about where a `0x53` *write* lands. If anything the
> evidence points the other way: the device emits pool sounds as `0x53 n`, which makes `0x53` the
> obvious candidate for writing them back. The write path is **untested, not unknown.**

The experiment is cheap and well defined: on a scratch project, write one `0x53` and then dump the
pool from the panel. If slot *n* changed, the pool is writable and the editor is mostly UI. If the
kit changed instead, the ambiguity is real and the editor needs another route.

**A related placement risk, found while re-examining this.** The pool dump numbered its 93 messages
`0`–`92` contiguously, and `rebuild.ts` places them by that number as pool slots. It could equally
be a **send counter over occupied slots** — which is a different placement if the pool has holes.
The end-to-end check does not discriminate: 31 locks resolving to 31 sounds happens either way,
with the wrong names in one case. Testable cheaply — clear one middle pool slot, dump again, and
see whether the count drops to 92 with a **gap in the numbering** (slot) or stays contiguous
(counter).

### 4e. Track editor — trigs, steps, p-locks

The format work is done: `dn2pattern.ts` and `dn1.ts` read trigs, sound locks, p-locks, microtiming
and conditions; `plockparams.ts` and `machineplock.ts` name the parameters, and the
machine-relative lock ids are mapped.

What does not exist is **writing a trig**. Everything built so far moves whole records; this is the
first feature that has to *compose* one. Genuinely a new layer — the lock table is referential and
allocated from a pool, so adding a p-lock is not a byte poke.

Sequence: a read-only step view first, which is nearly free and immediately useful, then editing.

### 4f. Sound editor, with audio from the device

**The biggest jump here, and it is not the editor.** The phrase "sound editor with playback"
bundles two unrelated problems:

1. **Editing a sound** — a UI over the 359-byte record, bounded, with the parameter map largely
   done. **Auditioning is the hard part**: to hear an edit the device must *have* it, so audition
   = **a write** plus a MIDI note. That means either overwriting a real sound to preview it or
   finding a scratch destination. This is a safety design problem, not a UI one, and it should be
   settled before anything is built.
2. **USB audio and an oscilloscope** — a different browser API entirely. Web MIDI carries no audio;
   this is `getUserMedia` against the device's USB audio interface plus Web Audio for the scope.
   Independent of everything else on this list.

   **Settled by the user, 2026-07-30: both Digitones are USB class-compliant and provide audio in
   and out over USB.** No Overbridge driver required, so the browser can open them like any other
   input. This section previously flagged that as unverified and blocking; it is neither. The
   oscilloscope is a real feature, and it can be built at any time because nothing else depends on
   it.

   What remains is a permissions detail rather than a capability one: audio input is a
   `getUserMedia` prompt, so the page needs a secure context — which §3f already requires for Web
   MIDI anyway.

### Suggested order, and why

1. **§3c-viii's two questions** — +Drive vs RAM, occupied slots. Everything below inherits the
   answers, and it is one short hardware session.
2. **4a, the live manager.** Highest value, least new risk, plan layer already built and validated.
3. **4c, sound explorer (DN2).** Reads only, on requests already proven.
4. **4b, transfer mode.** The thing this project was started for.
5. **4e, track view** read-only, then editing.
6. **4d, DN1 pool editor**, once its write path is settled.
7. **4f**, split: the sound editor once audition is designed; the oscilloscope whenever, since it
   depends on nothing else here.

**Files do not go away.** Every item keeps its file path — a file is the only thing that survives a
device being sold, wiped or updated, and the corpus is what every test in this repository runs
against.

### 3f. Getting it to testers — PLANNED 2026-07-28, not started

**Raised by the user**, who has a NAS at home and is willing to run a domain from it so that no
files are shared during early testing. That instinct is right, and it turns out to cost very
little, because of a property the project already has.

#### DNX is already static files

`npm run build:web` emits HTML and JavaScript and nothing else. There is no server-side code, no
database, no session, no upload endpoint. `test/web.test.ts` enforces it: it walks each page's
import graph and fails if anything reachable needs Node.

So the deployment is a directory. The only thing the local server does that a static host cannot
is find `EMPTY.dn2prj` on disk for the template endpoint — and the page already handles a 404
there by showing a file picker, which is exactly the right behaviour when deployed.

**And the user's projects never leave their machine.** Everything runs in the browser: the file
is read locally, converted locally, exported locally. That is not a privacy feature bolted on, it
is a consequence of the architecture, and it removes the entire category of concern that usually
makes distributing a music tool hard.

#### What the NAS actually needs

1. **A domain**, with DNS pointing home. Anything works; a dynamic-DNS name is fine.
2. **TLS.** Non-negotiable, see below. Caddy does automatic Let's Encrypt in about three lines of
   config and renews itself.
3. **Access control**, one of:
   - **HTTP basic auth** — simplest, one shared credential, fine for a handful of trusted testers.
   - **Cloudflare Tunnel with Access rules** — no inbound port on the home network at all,
     per-person email-based access, and it can be revoked individually. More setup, better
     properties, and free at this scale.
4. **The built directory**, served. That is it.

No hosting bill, no accounts to build, no data to protect.

#### HTTPS is a hard requirement, not polish

**WebMIDI requires a secure context.** Chrome will not grant `requestMIDIAccess` — let alone the
SysEx permission — over plain HTTP from anything but `localhost`.

So the certificate is not a nicety to add later: without it, the probe, the capture listener and
any future transfer simply do not work for a tester. It has to be in place from the first
deployment or the feature that most needs testing is the one that cannot be tested.

Worth telling testers up front that **Chrome or Edge is required**, for the reason §3c-iv
records: Firefox implements Web MIDI but gates SysEx behind a separate site-permission add-on and
drops it **silently** when that is missing. A tester on Firefox will report "it does not see my
device", and that report will be true and misleading at once.

#### The encrypted-executable idea — recommended against

The user asked whether the app could be distributed as an encrypted executable. It could, and it
would not do what it is meant to do.

- **It cannot protect the code.** Wrapping a web app in Electron ships the same JavaScript inside
  a bigger download. Anything encrypted client-side must be decrypted client-side, which means
  the key ships with it. This is not a solvable problem, it is a definitional one.
- **It costs a great deal.** Electron means per-platform builds, code signing on two platforms,
  an update mechanism, and a much larger surface to support — for testers who currently need to
  open a URL.
- **It makes testing worse.** Every fix becomes a release the tester has to install, instead of a
  refresh.

If the goal is **controlling who gets in**, authentication on the URL does that properly and
revocably. If the goal is **stopping people copying the code**, nothing delivered to a browser
achieves it, and a private repository plus a small trusted group achieves the practical version.

#### What to be careful about

**Never ship a template.** `EMPTY.dn2prj` must stay out of the deployment, for the reason
`README.md` already gives: a template has to match the storage version the *device* writes, and
shipping one silently makes it the template for every firmware. Testers supply their own.

**Never ship the corpus.** It is the user's music, and `.gitignore` already refuses those
extensions. The build output should be checked for stray `.dnprj`, `.dn2prj` and `.syx` before a
first deploy, and that check is worth automating.

**Version what testers are running.** A bug report against an unknown build is nearly useless.
The hardware sheets already stamp a build time into the project name for exactly this reason, and
the pages should carry the same stamp somewhere visible.

#### If it outgrows the NAS

Static files scale trivially: GitHub Pages, Cloudflare Pages and Netlify all host this for
nothing, and the only reason not to start there is that the repository is private and the user
would rather serve it from home first. Moving later is copying a directory — worth saying,
because it means **choosing the NAS now costs nothing later**.

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

**Answered 2026-07-28, and the answer is no — for this device.** The +Drive file API exists, but
**no Digitone implements it**: neither a Digitone II nor a Digitone 1 advertises any of the
nine file-API codes, and `DirList` times out on both. elk-herd models the drive because it
supports the **Digitakt II**. See §3c-iv.

So transfer mode cannot be built on whole-project file reads. It has to move **dumps** — the
`0x50`-`0x5e` band the device does advertise, of which `0x50` PATTERN_KIT is one we already
parse byte-exactly and hold native captures for. That is a bigger job than copying a file: a
project is assembled pattern by pattern rather than fetched whole, and the sound pool has to be
reconciled rather than coming along for free.

**It also removes a reason the two-device design was urgent.** Reading a DN1 catalogue over the
file API was the cheap version of this feature; without it, transfer mode is a much larger piece
of work and should be re-judged on its merits rather than inherited from a plan whose premise
has gone.

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

## 6. Queued for the expander — raised 2026-08-01, after the structure refactor

**Recorded, not started.** Four items from using the expander against real hardware. They wait
until `docs/STRUCTURE-AUDIT.md` is worked through, so they are built on the tidied code rather than
widening what has to be moved.

### 6a. A connected DN1 as a source — DONE 2026-08-04

The source half of the *In* row now mirrors the destination half: **From file… / Connect a Digitone
1… / Browse its +Drive**, then a slot picker and Open slot.

Three things had to change, and two of them were not where the feature looked like it was.

**It reads the +Drive, not the dump protocol.** Reading the active project record by record needs a
donor for the ~0.49% no dump carries, and for a Digitone 1 that donor has to be a *Digitone 1*
project — which the page cannot produce, which is exactly why the manager refuses that route (§7a).
The stored file needs no donor at all: every byte, any slot, verified byte-for-byte against
Elektron's own export. The DN1 advertises the whole storage band `0x53`–`0x5c`
(`OBSERVED_DIGITONE_1`), and the DN1 project capture in `99_HardwareTest` was read exactly this way.

**`connectDevice` can now be asked for a particular instrument.** It took the single best-named
port pair and failed if that guess was wrong — fine with one device connected and useless with two,
which is this page's entire premise. It now walks every candidate pair in order of confidence, asks
each one who it is, and returns the first that matches; wrong ones are closed on the way past. With
one device connected that is still exactly one request.

**The source type was the quiet blocker.** `state.source` was a whole `LoadedProject` while all
fourteen uses of it read `.image` — so a source had to arrive with a manifest and a payload, which
a file has and an instrument does not. Narrowing it to an image and a label is most of what made
the device route possible at all.

> A type that demands more than its readers use is a constraint nobody chose and everybody pays.

### 6b. Drag and drop from DN1 to DN2 does not work — FIXED 2026-08-01

**Only Apply worked**, which made the grids look decorative and the button the real interface.

**The gesture was never broken.** Both grids were bound to the shared `GridDrag`, the drop was
received, the landing slot was set and the plan was recomputed. What was missing was one line:
clicking a destination slot re-rendered the grid, so its marker moved — dropping on one did not.
The only visible effect of a drag was a line of text far down the page, and a gesture that works
invisibly is indistinguishable from one that does not.

Fixed, and made unmistakable rather than merely visible:

- the drop re-renders the destination grid, so the marker follows the drop
- **every slot the merge will write to** is marked, not just the anchor — drag four patterns and
  four cells light up, in a colour that is neither the selection ring nor the drag-hover wash,
  because *"you picked this"*, *"you are over this"* and *"this is what Apply will write"* are
  three different claims and the third has to survive after the cursor leaves
- the status says what will happen and what to press

Apply stays the commit. That separation is deliberate — choosing must not be the same act as
writing — and the bug was never that the drop failed to commit, only that it said nothing.
### 6c. Merged patterns must keep their relative positions — DONE 2026-08-04

**Current behaviour, and it is wrong as a default:** selecting A1, A9, A10 and dropping on A1 writes
them to **A1, A2, A3** — contiguous from the landing slot, discarding the spacing the musician chose.

Wanted:

- **Default — keep relative position.** A1, A9, A10 landing on A1 go to A1, A9, A10. Landing on B1,
  they go to B1, B9, B10: the offset from the first selected pattern is preserved.
- **A toggle, "expand to contiguous patterns"**, for today's behaviour, which is the right one when
  gathering scattered sketches into a block.

Design notes for whoever picks it up.

**Crossing a bank boundary is normal, not an error** — clarified by the user. A1, A9, A10 anchored
at A10 lands A10, B2, B3, and that is wanted: the banks are one 128-slot run, and the offsets are
what carry the musician's spacing. Nothing special happens at a bank edge.

**The one real limit is the end of bank H**, because there is no bank I. A target past slot 127 has
nowhere to go, so the whole placement is **refused before anything is written** — not wrapped to A,
not clamped onto H16. The refusal should name which patterns would fall off the end, since the fix
is usually to pick an earlier anchor.

Relative landing also changes *which* slots are written, so the occupancy warning and
`confirmOverwrite` are computed from the real target list rather than a contiguous run — with gaps,
the patterns in between are untouched and are not reported as overwritten.

The landing slot stopped being a start and became an **anchor**, and the page says so.

#### What it took

**The rule had been written three times** — once in `merge.ts` to decide what gets written, twice
in the page to decide what the grid previews and which cells it marks. Three copies of a rule that
must agree is a preview that can lie about what Apply will do. It lives in `src/expand/landing.ts`
now, and all three call it, so the preview is the same computation as the write.

**Called `landing`, not `placement`.** `src/expand/` already uses *placement* for which **track** a
sound gets — `PlacementRule`, `matchRule`, `placement.test.ts`. A second meaning in the same folder
is a trap for whoever reads it next, and *landing* was already the vocabulary for this question:
`landing`, `landingSlots`, `landingSlotsFor`.

**The overflow check could not stay as arithmetic.** `landing + patterns.length` is only the end of
the run in contiguous mode; three patterns spanning ten slots need ten. The check now runs on the
real destinations, so it neither misses real overflows nor invents ones that are not there.

**The hover hint had the same bug as the write.** It described the drop as `A1…A3` and counted
occupancy across that run — which, with gaps, warns about slots nothing is going to touch. It now
lists the actual destinations, and only calls it a range when it genuinely is one.

### 6d. Navigation between tools, in the title — DONE 2026-08-04

The tool titles become the navigation. **Their order is fixed and never changes**; the current tool
is highlighted, and the page slides.

```
DNX   >EXPANDER<   manager    probe
      ^^^^^^^^^^
```

**Settled by the user against a most-recently-used ordering**, which was the first sketch. MRU
turns the row into a history stack, so a tool's position depends on where you have been — going
back and forth between two tools swaps positions 2 and 3 every time, and the target you just
clicked is not where it was. A fixed row makes each tool a permanent screen position and therefore
muscle memory, which is worth more than expressing recency.

So **all the motion lives in the page**, not in the titles: a lateral carousel displacement,
**smooth but snappy, with easing**. The highlight moves; nothing reflows.

**A keyboard shortcut slides between tools too** — the row is ordered, so previous/next is
meaningful. Combo not chosen yet; see the note below.

#### Choosing the shortcut

The constraint is browser conflicts, which are unforgiving here:

- `Ctrl`+`1`…`9` and `Ctrl`+`Tab` are **taken by the browser's own tabs** in Chrome and Edge.
- `Alt`+`←` / `Alt`+`→` are **back and forward**. Taking them would break history navigation.
- Bare keys (`[`, `]`) are the fastest to reach, but this page is full of text inputs, so they need
  a focus guard: ignore the key whenever the target is an `input`, `select` or `textarea`.

Recommended: **`Ctrl`+`Alt`+`←` / `Ctrl`+`Alt`+`→`** for previous/next, with `Ctrl`+`Alt`+`1/2/3`
jumping straight to a tool — free in every browser we target, and the arrows match the carousel's
direction so the shortcut and the animation say the same thing.

Whatever is chosen, the shortcut must be **discoverable**: show it in each title's `title=`
attribute, since a shortcut nobody can find is a shortcut nobody uses.

#### Built 2026-08-04

`Ctrl`+`Alt`+`←`/`→` as recommended, plus `Ctrl`+`Alt`+`1`/`2`/`3`, both named in every link's
tooltip. Previous/next **stops at the ends rather than wrapping**: the row is a fixed line of three,
and a next that jumps from the last back to the first is how you land on the probe when you meant
to leave the expander.

**`Ctrl`+`Alt` is AltGr on Windows**, which the design note missed. On a Spanish, German or
UK-extended layout `AltGr`+`2` types `@` and `AltGr`+`1` types `|` — so the digit shortcuts collide
with ordinary typing on a page full of text fields. They are ignored while an editable element has
focus, which costs nothing because nobody navigates mid-rename. The arrows need no guard:
`AltGr`+arrow types nothing on any layout.

**The slide animates the arrival only.** Animating the departure means holding navigation until a
transition finishes, and a page left mid-transform when that goes wrong — a blocked navigation, a
back-button restore out of the bfcache — looks broken in a way no user can fix. The browser already
shows the old page until the new one paints, so the arrival alone produces the lateral displacement
that was asked for and cannot strand anything. The direction crosses the navigation in
`sessionStorage`; `prefers-reduced-motion` skips it entirely.

**The rules went in `web/toolnav.css`, not `dnx.css`.** The probe does not link `dnx.css` — it is a
self-contained page with its own `<style>` block — so putting them there would have meant a second
copy on the one page that could then drift. All three link the new file; all three draw the row from
`web/src/toolnav.ts` rather than writing it into their own markup.

## 7. From the hardware session — raised 2026-08-04

Found with a DN1 connected and the server running the current build. **Recorded, not started.**

### 7a. Open Device fails on a missing template, while Browse +Drive works

The manager's *Open device* refuses with:

> No template available, and a device read needs one for the parts no dump carries — the header,
> the song table and the slot array. Open a project file first, or run the local server so it can
> serve EMPTY.dn2prj.

**But the server was running and a device was connected**, and *Browse +Drive* on the same page
works — projects can be listed and opened. So the +Drive path finds what it needs and the dump path
does not.

That asymmetry is the lead worth following, and it points at the template lookup rather than at
MIDI: `fetchServedTemplate` fails or is never called, while `openDeviceProject` needs no template
because a stored file carries every byte. Note the expander gained an **embedded blank project**
(`src/librarian/blankproject.ts`) for exactly this reason — the manager may simply not use it yet,
in which case the fix is to reach for the same fallback rather than to serve a file.

### 7b. Export does nothing after an edit, and there is no SAVE to the device

Two things behind one report. **Export appearing to do nothing is a bug** and comes first.

The second is a real gap: everything the manager does lives in memory, and the only way out is a
file. There is no *write this back to the instrument*, even though the write path is now proven
byte-for-byte (`docs/device-probing.md`). A SAVE would need the same three-way verdict the probe
uses — overwritten, refused, or something else — and the reminder that a write lands in the active
project until the user presses SAVE PROJECT on the device itself.

### 7c. The drop is redundant with Apply, and says too little

Clarified during testing: **the drag works.** It has the same effect as picking a destination and
pressing Apply, which makes the gesture feel like it did nothing.

The ask, in the user's words: once a target is drawn or selected, the destination cells should show
**the name of the future pattern in a darker colour**, becoming the final state once Apply runs.
Today the only indicator is the amber outline from the landing marker.

So the drop should *stage* visibly rather than merely record a slot — a preview of what will be
there, distinct from what is there. Whether the drop should also commit outright is a separate
question and probably a later one: Apply exists because choosing must not be the same act as
writing, and that separation earns its keep as soon as a write can reach an instrument (7b).

### 7d. A connected DN1 still cannot be a source — DONE 2026-08-04

The same item as 6a, recorded twice because it was hit twice in use. Fixed there; see that entry
for what it took, which was mostly not what it looked like.

## 9. Preset pool manager and kit manager — PLANNED 2026-08-06

`docs/SOUND-AND-KIT-PLAN.md` has the design. Three things it settled that are worth knowing without
reading it:

**`/soundbanks` is the +Drive preset library.** Eight banks of 256 is 2,048, exactly the number the
manual gives. What we have been listing and reading all along *is* the library — we had the
device's name for it wrong.

**Our vocabulary drifted from the hardware's.** The device says *preset*, *preset pool*, *preset
lock*, *+Drive preset library*. This codebase says *sound* throughout. New surfaces should say
preset; renaming the existing ones is its own job.

**Kits are on the +Drive, in banks, saved to named slots** — the manual is explicit, and its list of
what a kit contains matches `DN2_KIT` byte for byte. The only thing missing is the storage API's
path for them, which one `List /` on a Digitone II answers.

## 10. Making the four tools look like one app — raised 2026-08-11

### 10a. The chrome moved between tools — DONE 2026-08-11

**Reported:** *"the DNX title and the tools navigation buttons move depending on the tool
selected."*

Three causes, one shape. `.topbar` lived in `dnx.css`, the probe built a bespoke `<header>`
beside it, and `dnx.css` indented `body.page > .topbar` to line up with the centred 78rem column —
so at 1920px the brand and the tool row sat roughly **330px** further right on the expander and the
library than on the manager and the probe. Switching tools moved the control you were aiming at.

`dnx.css` already carried the argument against this: *a row that has to look identical on every page
cannot have two homes.* It had three. The brand and the tool row had been moved to `toolnav.css` —
the only stylesheet every page links — and the bar containing them had not, so they drifted anyway.

The whole bar now lives in `toolnav.css`. The status line keeps its indent, because it is the
page's own commentary and belongs with the content; the chrome does not, because it spans the app
and must not move when the thing underneath it changes shape. Guarded by four tests: every page
carries the shared bar with the brand and tool row inside it, no page restyles it, and `dnx.css`
does not define or indent it. Checked by reintroducing the indent and watching the guard fail.

### 10c. The bar was a different height on each tool — DONE 2026-08-11

**Reported:** *"the height of the navigation bar. Expander, manager and library should share the
same height."*

The third complaint about this row in as many days, after its font size (8c) and its leading edge
(10a). Same shape every time: something a page controlled was allowed to move a thing that must not
move. Here it was the **contents**. The expander and the library already kept commands out of the
bar — their controls live in a `.bar` inside a section — while the manager had ten in it and the
probe about twelve. A button is taller than a badge, so those bars were taller, and the brand and
the tool row sat lower on them.

The manager's controls moved into a `.bar.toolbar` directly beneath the chrome, grouped by what
they are for and in the order the work happens: **Open**, **History**, **Out**. `.topbar` now
states a `min-height`, but that only sets a floor — the rule that actually holds is a test: the
chrome bar may contain no `button`, `select`, `input` or `label`. Checked by putting a button back
and watching it fail.

### 10d. The probe's bar is still a control panel — NOT STARTED

The probe carries roughly twelve controls in its chrome bar — port selects, Rescan, Probe, Listen,
Save capture, a request builder — and it is the one page still on the allowlist in
`test/web.test.ts`.

**The user's instruction is to relocate them into their own sections, grouped per usage**, rather
than to shrink them. The natural grouping is visible in the bar already: *ports* (out, in, rescan),
*session* (probe, listen, save), and *requests* (the object/slot builder and send). Those are three
different activities that happen at three different times, which is why they read as clutter side
by side.

Worth doing with 10b rather than before it: the probe is also the page that re-declares buttons,
selects and labels `dnx.css` already describes, and moving its controls is the moment to decide
whether it links the shared stylesheet.

### 10b. A consistency study across the four tools — NOT STARTED

**Raised by the user in the same breath, and deliberately kept separate**, because it is a design
question rather than a defect:

> *"Later in the development we will need to do a consistency study to try to unify all tools width
> so they look part of the same app and not disconnected utilities."*

What is already known to differ, from fixing 10a and 8c:

| | expander | manager | library | probe |
|---|---|---|---|---|
| body class | `page` | `app` | `page` | its own |
| content width | 78rem, centred | full-width grid, `1fr / 20rem` | 78rem, centred | full-width |
| base font | 13px | 13px | 13px | **14px** |
| stylesheets | `dnx.css` + `toolnav.css` | same | same | **`toolnav.css` only, plus its own `<style>`** |

**The probe is the outlier and the reason is historical**: it was built first, as a self-contained
diagnostic page, before there was a shared stylesheet to link. It now re-declares buttons, selects,
labels and inputs that `dnx.css` already describes — which is why the tool row needed its size
stating twice before it stopped moving.

The study should decide **one** content width rule and whether the probe joins `dnx.css`, and it is
worth doing as measurement first: list every duplicated declaration between `probe.html`'s `<style>`
and `dnx.css`, and every place the two disagree. Those disagreements are the app looking like four
utilities. Do not start it by picking a width.

## 8. From the 2026-08-06 hardware session

Thirteen tests passed, including the first end-to-end proof that a project can be read off a +Drive,
edited, exported and loaded back onto the instrument. Three things came out of it as work.

### 8a. The manager cannot choose between two connected devices — DONE 2026-08-07

**Reported:** *"I'm having an issue with the manager and both devices connected, I have no way to
select what device to load/use."*

**A visible choice, not a smarter guess.** `connectDevice({ want })` was the wrong tool: it names a
*kind* of instrument, which is all the expander needs because its two devices have fixed roles. The
manager has no such asymmetry — either instrument is a legitimate subject, and two Digitone IIs is
not an exotic thing to own — so `want` cannot address one of them.

- `listDevices()` identifies every Digitone on the ports and **closes every one of them**. A picker
  nobody chooses from must not leave two ports claimed.
- `ConnectOptions.port` addresses one instrument by its MIDI input port, which is the only thing
  that separates two of the same model.
- With **one** device connected nothing changes: it is found, used, and no picker appears. With
  **two**, the picker appears with an **empty first option** and every device operation refuses
  until something is chosen. That emptiness is the whole design — a select defaulting to its first
  entry would quietly reintroduce the guess this exists to remove.
- Changing the picker drops the cached +Drive listing and closes the old connection. Slot names
  from one instrument beside bytes read off another is precisely the confusion being fixed.

### 8b. The expander offers +Drive browsing for the DN1 and not the DN2 — DONE 2026-08-07

**Reported:** *"it feels that we should have the same options in the expander for DN1 and DN2
projects. DN2 only offers Connect a Digitone II with no browse its +Drive option."*

The asymmetry is real and the reason for it is not symmetric, which is why this needs a decision
rather than a patch. The DN1 is a **source**, so any stored project will do and the +Drive is the
better route — no donor, any slot. The DN2 is a **destination**, and *Read its project* deliberately
reads the **active** one because that is the only project a write can go back to. A project browsed
off the DN2's +Drive could be merged into and exported, but **not written back** — the manager marks
exactly that case read-only for the same reason.

So the option is worth having, and it must arrive with the write button disabled and a line saying
why. Adding it as a peer of *Read its project* without that would offer a destination the user
cannot send anywhere.

**Built that way.** A fourth destination origin, `drive`, beside `blank`, `file` and `device`. The
read-onlyness is **not a flag**: a write diffs against `handle`, the drive path never sets one, and
the button is already gated on its absence — so there is no state where it is live with nothing to
send. The destination line says *"read from the +Drive — export it as a file; a write would land in
the ACTIVE project"*, because a grey button is a fact and this is the reason, and the two are not
the same thing to read.

The family check happens **after** the read on both sides, source and destination, because the
listing does not say what family a stored project is — only the payload does.

### 8c. The probe's tool row is a different size from the other two — DONE 2026-08-07

**Reported:** *"In probe the text of the page names seems bigger than in the other 2."* The probe
does not link `dnx.css` — it is self-styled — so it inherited its own base font size while
`toolnav.css` set none of its own: 14px on the probe against 13px elsewhere.

`.toolnav` now states its size. Absolute rather than `rem`, because `rem` would still track a root
size any one page could change, and the point of the row is that each tool is a permanent screen
position — a font size that varies moves it.

### Confirmed working, and worth not re-litigating

**The AltGr guard does what it was built to do.** Reported as *"in probe, cursor in PATH,
Ctrl+Alt+2 doesn't navigate, the arrows do"* — which is the designed behaviour exactly:
`Ctrl`+`Alt` is `AltGr`, the digits are how several layouts type `@` and `|`, so they are ignored
while an editable element has focus. The arrows need no such guard and keep working.

## 5. A device analytics view — IDEA, 2026-07-31

**Not planned yet, and deliberately recorded before it is.** Raised while designing the drag-and-drop
merge, and worth capturing so it does not get half-built as a side effect of something else.

The idea: a view showing what is actually on and happening to your instruments.

- **Per device**, keyed by something stable — serial number, or the 4-byte identity `0x03` returns
  (`device-storage.md` §4), which is device-scoped and constant across project loads. That question
  is already answered for the DN1 and one click away for the DN2.
- **What is on it**: projects used and free, pool occupancy per project, sounds per bank, how much
  of the +Drive is write-protected. Every one of those is a `0x53` listing away — `Entry.occupied`
  and `Entry.writable` already decode it.
- **What has been done to it**: expansions run, patterns moved, merges applied, sounds appended.

### The part that needs designing rather than building

**Persistence.** Everything DNX does today is stateless and in-browser — no upload, no server, and
that is a feature people can verify by reading the page. History means storing something, and where
it is stored decides what the tool *is*:

- `localStorage` / IndexedDB — survives a reload, invisible to anyone else, lost on a browser
  reset, and per-browser rather than per-person.
- A file the user saves and reloads — explicit, portable, and one more thing to remember.
- The local server (`npm run web`) writing beside the corpus — natural for this author, useless for
  anyone running the page as static files.

The honest default is probably **the second**, with the first as a convenience, because it keeps the
"nothing leaves this page" property that the rest of the tool has.

### Why it is worth having

The statistics are not decoration. *Which projects have free pool slots* decides where a merge can
land. *Which sounds are duplicated across banks* is exactly the question the pool merge answers one
project at a time. *What was expanded when* is what makes a hardware test reproducible — the thing
`MILESTONES.md` does by hand for the project and nothing does for the instrument.

**Blocked on nothing.** It reads what the storage API already gives us. It waits because it is a
feature, not a discovery, and the two open discoveries — the write checksum and which project is
loaded — are worth more first.

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
