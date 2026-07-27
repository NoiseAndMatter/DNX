# Hardware test — pattern rearrangement

The librarian moves, copies, swaps and clears patterns, and verifies its own output. That
verification is our code agreeing with itself.

**Run on a Digitone II, firmware 1.10E, 2026-07-27. All nine operations passed, and the
baseline round-tripped through the device byte for byte.** [Results](#results-2026-07-27) is
at the bottom; the rest of this document is how to run it again.

## Building it

```
npm run hwtest -- --project "<a project with two good patterns>" --keep A1 B5 \
  --out <corpus>/99_HardwareTest
```

Three files, all stamped with the build time so the device says which build is loaded — a
hardware test that validates the wrong build is worse than no test:

| File | What it is |
|---|---|
| `HWTEST_BASE_<hhmm>.dn2prj` | the two seed patterns, and 126 captured blanks |
| `HWTEST_OPS_<hhmm>.dn2prj` | every operation applied, each in its own region |
| `HWTEST_<hhmm>.html` | the check sheet — a **form**, not a printout |

The outputs contain your music, so they live in the private corpus. `99_HardwareTest/` is
gitignored for that reason.

**Choose seeds that carry sound locks.** The generator prints what it picked
(`A1 "250319" 28 trigs, 15 sound locks`) and puts it on the sheet, because moving a pattern
with no sound locks proves nothing about pool references.

## One artefact, not eleven

The obvious design is a file per operation so a failure localises. That is the wrong trade:
eleven loads on a Digitone is an evening, and the method that has worked four times on this
project is the opposite — **one artefact carrying many changes, each identified by its
position**. A wrong result in bank C is a broken cross-bank copy regardless of what else is
in the file.

Hence two files rather than one. The baseline is separate because it answers the question
everything else depends on.

> **Load `HWTEST_BASE` first.** It is the seed patterns and 126 captured blank patterns and
> nothing else. If it does not load, or the empty slots misbehave, stop — no result from the
> operations file would mean anything. **That result alone is worth the session**, because
> every move and delete we can make depends on those blanks being right.

## The layout

`A1` and `A2` hold the seed patterns and are **never written after seeding** — they are the
reference everything else is read against. Each operation then lands somewhere no other
operation touches, so one failing cannot explain another.

Writing `P1` for the pattern seeded at `A1` and `P2` for the one at `A2` — on the sheet these
are the patterns' **real names**, for the reason below.

| # | Operation | Slot → should be | | | |
|---|---|---|---|---|---|
| 1 | Copy, same bank | `A1` P1 | `A5` P1 | | |
| 2 | Copy, across banks | `A1` P1 | `C1` P1 | | |
| 3 | Move, same bank | `A3` empty | `A9` P1 | | |
| 4 | Move, across banks | `A4` empty | `D16` P2 | | |
| 5 | Swap, same bank | `A13` P2 | `A14` P1 | | |
| 6 | Swap, across banks | `B1` P2 | `E1` P1 | | |
| 7 | Batch move | `F1` P1 | `F2` P2 | `F5` empty | `F6` empty |
| 8 | Batch copy | `G3` P1 | `G4` P2 | `A1` P1 | `A2` P2 |
| 9 | Delete | `H1` empty | | | |

Every operation appears in both a same-bank and a cross-bank form, because the bank boundary
is where an off-by-sixteen would hide. `test/hardwaretest.test.ts` asserts that, along with
the disjointness of the steps and the untouchability of the references — if someone edits the
layout and breaks those properties, the suite fails rather than the session silently becoming
unreadable.

## Expectations name the pattern

The first run of this sheet said *"`A13` and `A14` have exchanged"*. At the device that is
**unfalsifiable**: both slots play, and without knowing which pattern started where there is
nothing to compare against. The tester has to take the swap on trust — which is exactly the
claim the test exists to check. It came back as the only unanswerable row on the sheet.

So every expectation now names the pattern the device should display in each slot, or says
the slot must be empty: `A13 → "250423"`. That can be read off the screen and be wrong. It
also tests **identity** rather than just audio, since the name travels inside the record — a
step that moved the right bytes to the wrong slot now fails visibly.

Two consequences worth knowing:

- The generator **refuses to build** if the two reference patterns share a name or have none.
  Name-based expectations would look precise and check nothing.
- Before printing the sheet, the generator re-reads the file it just wrote and checks every
  claim against it. `applyRearrange` verifying each step is our code agreeing with our code;
  this asks whether the file being shipped actually shows what the printed sheet says. **A
  wrong sheet is worse than no sheet**, because the tester reports our mistake as a hardware
  failure.

## What to check, beyond "it plays"

The name is now in the table. These still fail quietly:

- **The kit** — every track keeping its sound *and its machine*. `sound+244` travels with the
  kit, so a move that dropped it would leave the right notes on the wrong sounds. A correct
  name with a wrong kit is precisely what the table alone would miss.
- **Trig count.** A truncated copy would keep the name and lose the notes.
- **Sound locks.** The pool is shared within a project, so indices should stay valid. A lock
  playing the wrong sound would disprove that.
- **Per-track lengths**, if the seeds use them.
- **Tempo and pattern length**, which live in the metadata block beside the slot index.
- **The cleared slot genuinely blank**, not merely silent — select it, check the kit reads as
  initialised, and record a trig into it.

## Last, and only if the rest passed

Save the project on the device, export it, and diff against what we wrote (`npm run diff`).
Any byte the device changed on load is either a field we got wrong or one it normalises. Both
are worth knowing, and this is the only way to see them.

## The one real risk

**Do not run this on a project whose songs matter.** The DN1's song table is located and
guarded; the DN2's has never been found, so a DN2 rearrangement cannot be checked against
songs, and patterns are referenced by slot. The tool warns on every DN2 operation.

If a song *is* present and you want to know what happens, that is a legitimate experiment —
do it deliberately, on a copy, and treat the result as the first evidence about where the DN2
song table lives.

## Recording the result

**The sheet fills itself in.** Every tick is a real control and every note a real field; the
button at the bottom writes `DNX_RESULTS_<hhmm>.md`, which is the deliverable — hand that file
over as it is. Answers are kept in the browser as you go, so a reload mid-session costs
nothing. `src/sheet/resultsform.ts` builds all of it, and the whole page is self-contained:
no network, no dependencies, opens from disk.

This replaced a printed table and a second pass retyping results into a chat window. That is
where detail was being lost, because **nobody retypes the row that passed** — and the rows
that passed are what make the next round-trip diff readable.

Three properties of the form worth preserving if it is edited:

- **Unanswered is a state.** A row left blank exports as `-`, never as a pass, and the export
  header counts what is still blank. A form that defaults to "fine" invents evidence.
- **Markdown, not JSON**, because the export has two readers — a person skimming it and
  whatever consumes it next. A results file nobody can read is one nobody checks.
- `test/resultsform.test.ts` ties the emitted control ids to the selectors the export script
  reads them back by. Nothing in the type system connects those, and a mismatch would fail
  silently at the hardware, after the session is over.

**A failure is more useful than a pass**, so write what the device actually did — the wrong
name, the wrong sound, the silent slot — not what it should have done. Anything unexpected
goes in `docs/KNOWN-ISSUES.md`.

If everything passes, pattern rearrangement becomes **hardware-validated** in `ROADMAP.md`.

---

## Results, 2026-07-27

Digitone II, firmware 1.10E. Build `1629`, seeded from `MORNING_JAM` with `A1` "250319"
(28 trigs, 15 sound locks) and `B5` "250423" (59 trigs, 32 sound locks).

**Both files loaded. All nine operations passed.**

| # | Operation | Result |
|---|---|---|
| 1 | Copy, same bank | pass — `A1` and `A5` play the same, both present |
| 2 | Copy, across banks | pass — `A1` and `C1` play the same |
| 3 | Move, same bank | pass — `A9` plays, `A3` empty |
| 4 | Move, across banks | pass — `D16` plays, `A4` empty |
| 5 | Swap, same bank | **unreadable** — both slots played, but the sheet gave no reference to compare against |
| 6 | Swap, across banks | pass — `B1` and `E1` exchanged |
| 7 | Batch move | pass — `F1` then `F2` in order, `F5` and `F6` empty |
| 8 | Batch copy | pass — `G3` then `G4`, `A1` and `A2` still play |
| 9 | Delete | pass — `H1` empty, selectable, accepted a new trig |

Pattern **names transferred correctly** throughout. Row 5 is the sheet's failure, not the
librarian's, and is what drove the naming change above.

### The baseline round-tripped byte for byte

Loaded `HWTEST_BASE_1629`, saved it back from the device, exported it:
**0 differing bytes out of 12,889,604.** Not one byte in the header, the 128 pattern records,
the 128 kit records or the 109,572-byte tail.

This is a much stronger result than "it loads". The device read a project of 126 **captured
blanks** and two real patterns, and wrote back exactly what we gave it — so our image is not
merely acceptable to the device, it is what the device itself would produce. It also retires
the worry behind the whole blank-capture exercise: a synthesised blank could have loaded and
still been subtly wrong, and this shows ours is not.

### The operations file came back with 198 bytes changed

`HWTEST_OPS_1629` was played with before saving, so its diff mixes device behaviour with the
tester's edits. Every difference is accounted for:

| Where | Change | Reading |
|---|---|---|
| 127 of 128 pattern records | **identical** | every rearranged pattern survived the device untouched |
| Pattern `H1` | 3 bytes | the tester recorded a trig into the deleted slot, as step 9 asks |
| Tail, 109,572 bytes | **identical** | the device rewrote nothing there — including, wherever it lives, song data |
| Header `0x18`–`0x1b` | 4 bytes | see below |
| 13 kit records | kit name filled in | see below |
| 114 kit records | 1 byte at kit `+0x16b0` | `0x40` → `0x00`, inside the unidentified 160-byte gap after the last sound. Benign; unexplained |

Occupancy matched our own expectation in all 128 slots.

### Header `0x18` is a project identity token, and we inherit it

Previously recorded as *speculative: a hash/id*. Two observations settle what it is not:

- **Not a content hash.** `EMPTY.dn2prj` and `MORNING_JAM_EXPANDED.dn2prj` have entirely
  different content and share `743a3f5b`.
- **Not recomputed on save.** The baseline round-trip preserved our (inherited) value exactly.

Across 32 DN2 projects there are 19 distinct values, and every duplicate group is explained
by copying: Windows file copies, or **our own output inheriting it from its template**.
Everything the converter builds from `EMPTY.dn2prj` claims to be `EMPTY`. The device changed
it only on the file whose contents had changed, which fits a revision or identity token
bumped on a modifying save.

The device accepted an inherited value without complaint, so nothing is broken today. But
several generated projects on one +Drive all asserting the same identity is a latent problem,
and minting a fresh value when we author a project is what the device appears to do.
**Deferred deliberately**: our converter reproduces Elektron's importer byte for byte, and
changing this field would break that guarantee unless Elektron's importer also mints one.
Settle that first — see `KNOWN-ISSUES.md`.

### Kit names default from the slot, lazily

Our blank clears the kit name. The device fills in `KIT <slot index + 1>` — `A1` → `KIT 1`,
`B1` → `KIT 17`, `H1` → `KIT 113` — and the rule held for all 13 kits it wrote.

It does this **lazily**: the baseline's 126 unnamed blank kits came back still unnamed, so
the default is materialised when the device loads a kit, not when it saves a project. Our
empty name is therefore legitimate and needs no change.

### Both projects opened on `D1`

Noted by the tester, and the round-trip answers it: the baseline changed **zero** bytes, so
the device wrote no current-pattern field anywhere in the file. The selected pattern is
device state that survives a project load, not something the project carries. **[inferred]**

### What this did not test

- **DN1.** The librarian handles both families; only the DN2 has been on hardware.
- **Songs.** Still the standing risk — the DN2 song table has never been located.
- **Sound-lock pool references across projects.** Everything here was one project.
