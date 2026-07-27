# Hardware test — pattern rearrangement

The librarian moves, copies, swaps and clears patterns, and verifies its own output. That
verification is our code agreeing with itself. **Nothing here has been loaded by a device.**

This is the session that closes the gap.

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
| `HWTEST_<hhmm>.html` | what to check, slot by slot, with room to write results |

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

| # | Operation | Look at | Expect |
|---|---|---|---|
| 1 | Copy, same bank | `A1` `A5` | `A5` matches `A1`, and `A1` still plays |
| 2 | Copy, across banks | `A1` `C1` | `C1` matches `A1` |
| 3 | Move, same bank | `A3` `A9` | `A9` plays it, `A3` empty |
| 4 | Move, across banks | `A4` `D16` | `D16` plays it, `A4` empty |
| 5 | Swap, same bank | `A13` `A14` | the two exchange |
| 6 | Swap, across banks | `B1` `E1` | the two exchange |
| 7 | Batch move, two sources | `F1` `F2` `F5` `F6` | `F1` then `F2` in order; sources empty |
| 8 | Batch copy, two sources | `G3` `G4` `A1` `A2` | `G3` then `G4`; sources still play |
| 9 | Delete | `H1` | empty, selectable, accepts a new trig |

Every operation appears in both a same-bank and a cross-bank form, because the bank boundary
is where an off-by-sixteen would hide. `test/hardwaretest.test.ts` asserts that, along with
the disjointness of the steps and the untouchability of the references — if someone edits the
layout and breaks those properties, the suite fails rather than the session silently becoming
unreadable.

## What to check, beyond "it plays"

The trigs are the easy part. These fail quietly:

- **The pattern name** the device shows. It travels inside the record, so a wrong name means
  we moved bytes without moving identity.
- **The kit** — every track keeping its sound *and its machine*. `sound+244` travels with the
  kit, so a move that dropped it would leave the right notes on the wrong sounds.
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

The sheet has a column for it. **A failure is more useful than a pass**, so write what the
device actually did — the wrong name, the wrong sound, the silent slot — not what it should
have done. Anything unexpected goes in `docs/KNOWN-ISSUES.md`.

If everything passes, pattern rearrangement becomes **hardware-validated** in `ROADMAP.md`,
which is the claim we cannot make today.
