# Hardware test — pattern rearrangement

The librarian can move, copy, swap and clear patterns, and it verifies its own output. That
verification is our code agreeing with itself. **Nothing here has been loaded by a device.**

This is the session that closes that gap. It follows the method that has worked four times
already: build one artefact carrying many distinct, positionally-identified changes, load it,
and read the device rather than the file.

## Method

**Seed a clean project first.** A corpus project has patterns everywhere, which makes "did
this move?" hard to answer at a glance. Reduce it to two known patterns in bank A, then use
the empty banks as workspace:

```
npm run rearrange -- --project "MORNING_JAM.dn2prj" --keep A1 A4 \
  --apply --confirm --out "REARRANGE_TEST.dn2prj"
```

That leaves `A1` and `A2` holding the two patterns and blanks the other 126. **Load this on
the device first and confirm it is sane before doing anything else** — if a project of 126
captured blanks does not load, nothing after it means anything, and that is itself the single
most valuable result of the session.

Then apply the operations below to that project, one output file per step so a failure
localises. Stamp each filename.

## What to run

Each operation is checked in-bank and across banks, because the bank boundary is the obvious
place for an off-by-sixteen to hide.

| # | Operation | Command | Expect on the device |
|---|---|---|---|
| 1 | Baseline | (the seeded file) | `A1`, `A2` play; every other slot empty |
| 2 | Copy, same bank | `--copy A1 --to A5` | `A1` **and** `A5` play the same thing |
| 3 | Copy, across banks | `--copy A1 --to C1` | `A1` and `C1` both play it |
| 4 | Move, same bank | `--move A2 --to A8` | `A8` plays it, `A2` is empty |
| 5 | Move, across banks | `--move A1 --to D16` | `D16` plays it, `A1` is empty |
| 6 | Swap, same bank | `--swap A1 A2` | the two exchange |
| 7 | Swap, across banks | `--swap A1 E1` | the two exchange |
| 8 | Delete | `--clear A1 --confirm` | `A1` empty, and **selectable without a hang** |
| 9 | Batch move | `--move A1 A2 --to F1` | `F1`, `F2` in that order; `A1`, `A2` empty |
| 10 | Batch copy | `--copy A1 A2 --to G3` | `G3`, `G4`; sources still play |
| 11 | Chained | several operations, exported once | the single-project paradigm holds up |

## What to check, beyond "it plays"

The trigs are the easy part. These are the things that would fail quietly:

- **The pattern name** the device shows for the slot. It travels inside the record, so a
  wrong name means we moved bytes without moving identity.
- **The kit.** Every track should keep its sound and its machine — `sound+244` travels with
  the kit, so a move that dropped the kit would leave the right notes on the wrong sounds.
- **Sound locks.** Pick a source pattern that has them. Within one project the pool is shared
  and indices should stay valid, so a lock playing the wrong sound would disprove that.
- **Per-track lengths.** If a source pattern uses them, they must survive the move.
- **Tempo and pattern length**, which live in the metadata block beside the slot index.
- **The cleared slot is genuinely blank**, not merely silent — select it, check the kit reads
  as an initialised one, and try recording a trig into it.
- **Re-export after loading.** Save the project on the device, pull it back, and diff against
  what we wrote (`npm run diff`). Any byte the device changed on load is a field we got wrong
  or a field it normalises — either is worth knowing, and this is the only way to see it.

## The one thing to be careful about

**Do not use a project that has a song.** `docs/ROADMAP.md` §3c has the detail: the DN1's song
table is located and guarded, the DN2's has never been found, so a DN2 rearrangement cannot be
checked for song references. The tool warns about this on every DN2 operation. Rearranging a
project whose songs matter would be the one way this session could cost real work.

If a song *is* present and you want to know what happens, that is a legitimate experiment —
but do it deliberately, on a copy, and treat the result as the first evidence about where the
DN2 song table lives.

## Recording the result

Fill in the outcome per row. A failure is more useful than a pass, so record what the device
actually did rather than what it should have done — the wrong name, the wrong sound, the
silent slot. Feed anything unexpected into `docs/KNOWN-ISSUES.md`.

If everything passes, the line to add to `ROADMAP.md` is that pattern rearrangement is
**hardware-validated**, which is the claim we cannot make today.
