# Known issues and open gaps

What is wrong, unfinished or untrusted, and how it was found. Read this before changing the
converter.

---

## Track SPEED was ignored, so 60 patterns had the wrong polymeter — FIXED 2026-09-05

A track's length is not its period. SPEED is a multiple of the pattern's tempo — Elektron's manual:
*"a setting of 1/8X plays back the track at one-eighth of the set tempo"* — so a 12-step track at
3/2x covers its twelve steps in **eight** master steps, and a 16-step track at 1/2x takes
thirty-two. Everything about alignment, resets and where a trig falls happens on the master clock.

Reading raw lengths got **60 of the 352 playing patterns** wrong. **77 have tracks at different
speeds**, which is where it bites.

`GLITCH_EXPLORE` B5 — the example used repeatedly in review — has 12@3/2x, 16@1x, 64@1x and
24@3/2x. It was reported as a **192-step polymeter with two tracks cut** by its 64-step reset. On
the master clock the periods are 8, 16, 64, 16: the polymeter is **64, exactly the reset, and
nothing is cut at all**. The claim was not slightly off, it was inverted.

`masterPeriod` and `masterOffset` are the fix, and grouping moved from lengths to **periods** —
16@1x and 24@3/2x share a period of 16 and never drift apart, which grouping on length split.
Periods are whole numbers of twenty-fourths (the speeds are 2, 3/2, 1, 3/4, 1/2, 1/4, 1/8), so the
least common multiples are computed there and scaled back rather than asking a float for
`lcm(10.666…, 16)`.

Found because the user said the tool should check the speed multipliers.

## Trig conditions are stored, unread, and lengthen the true cycle — OPEN 2026-09-05

A trig can carry a condition — 2:3 plays it on the second of every three passes — and that
**multiplies the musical cycle**: a pattern whose tracks realign every 64 steps does not sound the
same on each of them. **1,388 of the 15,258 note trigs in the corpus are conditional, across 220 of
the 352 playing patterns**, so this is the common case rather than an edge one.

**The code tables are decoded** — `+0x100` was solved on hardware 2026-07-26 with two generating
rules, `+0x180` is the FILL family, and `DNX_CAP_01` A13/A14 then measured the blocks the rules had
only predicted. `dn2-pattern-format.md` §2.3 has both.

What is still open is not the encoding but the arithmetic: **this page does not work out what a
mixture of conditions does to the cycle**, and a percentage condition has no exact answer at all. So
the analysis can say *which* conditions are present and cannot say *how much* longer they make it.

`AnalysisTrig.conditional` is a boolean for exactly that reason, and the page reports the alignment
figure as a **floor** wherever conditions are present. That stays right until the cycle arithmetic
is written; the capture it used to wait on has happened.

> **This entry claimed the tables were unread for six weeks after they were solved**, and the
> Insights page repeated it to users. Corrected 2026-09-07. An issue nobody closes is a claim that
> keeps being made.

## The true cycle ignored PATTERN RESET, and was up to 15x too long — FIXED 2026-09-05

Insights reported the least common multiple of the track lengths as the pattern's cycle.
`MORNING_JA 1640(2)` A2 has tracks of 16, 32, 62 and 64 steps, so it announced **1,984 steps —
12 minutes 24** at 40 BPM. **The device repeats it every 128 steps, which is 48 seconds.**

The sequencer has a **PATTERN RESET** in PER TRACK mode. Elektron's manual, PAGE SETUP: RESET
*"controls the number of steps the pattern plays before all tracks resets and restarts from the
first step on the first page. An INF setting makes the tracks of the pattern loop infinitely,
without ever being restarted."* So the polymeter simply never finishes — every track is pulled back
to step one on the way.

**40 of the 352 playing patterns in the corpus were overstated**, by factors from 3x to 15x. The
number was arithmetically correct and musically false, which is the worst kind: nothing about it
looked wrong.

Found because the user knew the instrument and said so. **No amount of reading our own files would
have caught it** — the LCM is a property of the lengths, and the lengths were read correctly.

`repeatSteps()` is the bounded figure and `cycleSteps()` remains the arithmetic; the page shows the
first as *Repeats every* and names the second when the two differ.

### Still a guess: how INF is stored — OPEN

A RESET field of `1` is taken to mean INF, by analogy with CHANGE at `+0x16`, which
`dn2-pattern-format.md` records as `1 = off`. The corpus is consistent — every per-track pattern
reading 1 is in `017 PRESETS`, whose tracks run 14 to 64 steps and would be shredded by a one-step
reset — but consistent is not confirmed, and it decides whether 90 patterns repeat in seconds or in
minutes. **`Tests_To_Run.html` T41** is the three-save capture that settles it.

The same field also serves two purposes: it is the pattern **length** in PER PATTERN mode and the
**RESET** in PER TRACK mode, because per-track mode has no pattern length at all. Reading it as a
reset in the wrong mode is what produced the overstatement.

## A note length is stored and never decoded, and it blocks three charts — FIXED 2026-09-06

A DN2 trig carries a note-length byte and every track a default. **Nothing maps either to a
duration.** `dn2-pattern-format.md` records the track default at `+0x02` as INFERRED — the name
comes from its position in the Digitone 1 settings block, not from a capture — and no capture has
walked the trig field against what the instrument displays. Measured across every readable pattern
of the 24-project corpus, the track default is `0x0E` in 1,577 of the 1,725 tracks that play a note
— and it takes **24 other values** in real music, which is what says the byte carries something
rather than being a constant.

Three built and tested charts therefore have no honest input and are **not drawn** in the manager:

| chart | what it needs a gate for |
|---|---|
| voice pressure, and the per-track gate lanes | how long each note holds a voice |
| the phase strip's *note length* mode | the width of the bar it draws |
| the phase strip's *overlapping notes* mode | whether one note is still sounding at the next |

`AnalysisSubject.gateLengthKnown` is what stops a caller drawing them: `patternSubject` sets it
false and puts 1 in every gate, and the Insights page prints a card saying which charts are missing
and why. **The temptation to fill this in with a plausible curve is the thing to resist** — it would
produce a voice-count chart indistinguishable from a measured one.

**The capture that settles it is small**: set one trig to each `LEN` value on the instrument, save,
and diff. Worth doing in the same session as the SETUP-page capture that mono/poly and portamento
need.

> **Done, 2026-09-06.** `DNX_CAP_01` A11, A12 and A15 walked the range against the screen and
> `dn2-pattern-format.md` §3.3 has the table: a banded encoding in sixteenths of a step, the
> increment doubling every sixteen bytes, `127` = INF and `255` = no lock. `gateLengthKnown` is now
> true for every Digitone II project, and all three charts draw.
>
> **The resistance was the right call.** A plausible curve fitted to the low end would have been
> wrong above byte 30, where the step size starts doubling, and a voice chart drawn from it would
> have looked exactly as convincing as this one.

## Key analysis asks whether a track has one root, not whether it has one note — OPEN 2026-09-05

`harmonic()` decides which tracks can say anything about key by counting **distinct pitch classes of
each trig's root note**. That is correct for the case it was written against — a hat on one pitch
every step carries no harmonic information and must not be allowed to outvote a melodic line — and it
is what the mockup measured, so the extraction preserved it exactly.

It is arguably wrong for one case: **a track that plays chords over a single root.** Every trig has
the same root, so the track is excluded, even though its voicings are real harmonic content. Counting
every note rather than only the root would include it.

Not changed yet, because it is a **behaviour change** rather than an extraction, and the evidence for
either rule is one synthetic pattern. It needs a real project with a one-root chord track in it
before the rule is moved. `test/analysis.test.ts` pins the current behaviour so the change cannot
happen by accident.

## Writing to a device took no copy, asked nothing and checked nothing — FIXED 2026-08-14

**Write to device** in the manager did this the moment it was pressed: diff the image, send the
records that differ, print `3 pattern(s) written`. No copy of what was in those slots. No question.
No check that the device stored what was sent. The expander's write went through the same function
and asked a generic question that named no slot and no count. The probe's +Drive write was a third
version of the sequence, ending in *"check the slot on the instrument"*.

Everything needed to do better already existed and every piece of it was optional:

| what existed | who called it |
|---|---|
| `verifyWrite`, with a header saying *"a write is not finished until it has been read back"* | the probe page only |
| `readBackRecords` | **nothing, ever** |
| a confirmation naming the destination | the probe's slot write only |

**A guard nobody is obliged to use is documentation.** Fixed by making the obligation structural:
`src/device/safewrite.ts` is the only path, the primitives now require a `WritePermit` that only it
can produce, and `test/safewrite.test.ts` scans the tree for anything reaching around it.

A side effect worth recording on its own: `readBackRecords` declared `layout.patternSize` as the
size it expected, which is what sizes the read timeout. A patternKit is `patternSize + kitSize` —
99,840 bytes on a Digitone II, not 89,088 — so every read-back allowed 89% of the time it needed,
and only the reader's slack covered it. It had never bitten because nothing had ever called the
function. That is the **fifth** fact this codebase had written down twice; a test now pins
`RESPONSE_SIZES[…].patternKit` against `patternSize + kitSize`.

## The probe's null round trip trusted a capture that may have gone stale — FIXED 2026-09-08

Found while fixing the entry below, and fixed the day after rather than folded into it.

`writeBack` sends a captured record to the slot it came from, and its confirmation said *"the bytes
are identical to what the device just sent, so nothing should change"*. That is true at the moment
of the read and not afterwards. Turn a knob on the instrument between the read and the write and the
capture is no longer what is in the slot, so the round trip is a real overwrite of a real edit,
under a promise that nothing would change, with no copy of it anywhere.

It was narrower than the slot write's version: the record on screen *is* a copy of that slot as of
the read, and **Save capture** puts it on disk, so the loss needed somebody to edit on the
instrument between two clicks on the same page.

The fix is the same shape and the same read: ask for the slot before the question, keep the answer
as the copy, and compare it against the capture. `driftSince` in `dumpwrite.ts` is that comparison,
and it is deliberately not `verifyWrite`. They share the arithmetic and answer different questions:
`verifyWrite` asks whether a write landed and stops at the first differing byte, because one wrong
byte is already the whole answer; `driftSince` is read by somebody deciding whether to write at all,
and *three bytes differ* and *half the record differs* are not the same decision.

**The copy is the dull half.** The interesting half is that a null round trip which turns out not to
be null is a **result**, and this page exists to record results. So the drift gets a card of its own
before the question is asked, and it stays up whatever the person then chooses. The confirmation
changes with it: same title and a checked claim when nothing has moved, and *"Slot A1 has changed —
still write the capture over it?"* when something has.

### What this cost the fence

Writing the second one exposed the first one as decoration. `test/safewrite.test.ts` extracted the
function it was checking with `source.indexOf("\n}\n", start)`, which returns **-1** on a CRLF
working copy; `slice` reads that as *one byte from the end* and hands back most of the file. The
ordering assertions were passing on the first `awaitPatternKit`, `askConfirm` and `output.send` in
several hundred lines of unrelated code.

It had been checked against the pre-fix source and had failed there, which is why it looked sound —
but it failed on the one assertion that scans for a *string*, not on the three that compare
positions. A fence that measures the wrong region passes for reasons that have nothing to do with
the code it names. The extractor now matches `/\r?\n\}\r?\n/` and asserts the body came out under
12 KB, and all four assertions fail against the source of two days ago.

## Firmware 1.11 projects are 512 bytes longer, and DNX opened none of them — FIXED 2026-09-14

Found by opening `/projects/4` off a Digitone II that had been updated to OS 1.11:

> Could not open the slot: Error: payload declares 12890116 bytes where a 0059 image is 12889604 — this
> looks compressed, which a +Drive read never is

**It is not compressed.** Every size check in DNX knows one Digitone II image, and 1.11 writes another.

### What 1.11 changed, measured

- **Every stored project was upgraded.** All 18 occupied slots read format `0059` and decode to
  **12,890,116** bytes. 1.10E wrote `0050` and 12,889,604. Nothing was re-saved by hand, so the
  instrument rewrote them itself.
- **The 512 bytes are appended, and nothing before them moved.** Slot 4 (SKETCHPAD), read in stored
  form, against the 1.10E copy of the same project in the private corpus: the header, all 128
  patterns, all 128 kits and the whole old tail are **byte-identical**, and all 4,386 `BEEFBACE`
  objects sit at the same offsets with the same versions.
- The appended block is mostly zero: 68 non-zero bytes, holding **two new objects, both version 2**,
  at `0xc4ae6f` and `0xc4afd6`.

What those objects are is **not established**. The firmware diff for 1.11 adds Outbox 8 and CV
configuration, and a new `projectStorage_v14_t`, which makes project-level I/O settings the obvious
candidate. That is an inference from where the change landed, nothing more.

Also measured on 1.11, and unchanged: the file API advertises the same 22 message codes as 1.10E, a
preset bank lists all 256 slots, and every preset's tags decode.

### Why nothing opens

The image size is used as the family test, and one size per family is assumed:

- `layoutFor` in `src/project/dn2image.ts` recognises an image by its exact length.
- `imageFrom` in `src/device/drive.ts` compares a payload's declared length against one size per
  kind, and calls any mismatch "compressed".
- `src/expand/convert.ts`, `src/expand/deviceexpand.ts` and `src/expand/merge.ts` each assert the
  destination is exactly `DN2_LAYOUT.imageSize`.

### The fix: a second accepted size, not a second layout

Because nothing moved, one layout still describes both firmwares. `ImageLayout` gains `imageSizes`,
every size a family has written, and `fitsLayout` tests membership. `layoutFor`, `imageFrom`, the
converter's template check, the expander and merge destinations, the rearrangement check, the device
write's diff and the rebuild donor all ask that instead of comparing against one number.
`imageSize` stays, meaning the size a blank or template has, and its comment says it is not the only
one.

`imageFrom`'s refusal now names both causes: compressed bytes, or a firmware this build does not
know. The next firmware that changes the size will say so, instead of calling it compression.

**The 512 bytes are carried, not understood.** A 1.11 project opens, edits and writes back with
them untouched; `test/os111.test.ts` rebuilds the payload and checks every byte survives. What they
say is not decoded. The firmware session's type-table diff for 1.11 adds exactly one new storage
type, `BOB::bobConfigStorage_v0_t`, mirrored by `BreakOutBoxSettings`, so the Outbox 8 is the
likeliest owner. The two objects' header version (2) cannot be matched to that `_v0` suffix: across
kits, patterns and sounds, DNX's header versions never equal the type names' suffixes.

A Digitone 1 conversion still starts from the 1.10E blank and produces a `0050` project. A 1.11
instrument upgrades that on load, as it did to all 18 projects on this one.

**Confirmed on hardware**, same session, nothing else on the port: the manager opened SKETCHPAD
from slot 4 of the 1.11 instrument, 12,890,159 bytes, and drew its patterns.

`test/os111.test.ts` checks the sizes without a device, then, against the private corpus, reads the
1.11 SKETCHPAD and its 1.10E copy. The first 12,889,604 bytes are identical, the appended block holds
the two objects where they were measured, a write-back keeps all 512 bytes, and pattern A1 reads.

Evidence: `99_HardwareTest/projects_4_SKETCHPAD_os1.11_stored_139736B.bin` and
`os-1.11-project-image-2026-09-14.md` in the private corpus.

## A partial +Drive listing was shown as the whole drive — FIXED 2026-09-14

Reported from hardware: the library listed preset bank A as **35 of 256** slots. Elektron Transfer was
running on the same machine. With it closed, the same bank listed 256 and `/projects` listed 128.

This is the trap recorded on 2026-09-06, when Overbridge on the same port cut two unrelated replies at
exactly 885 bytes. An 885-byte listing reply holds about 35 preset entries. What was new is that
nothing said so. `parseListing` has reported a short page as `complete: false` since that day, and
`wholeListing` refused one, but only the manager's destination checks called it. The library,
`listProjects` and the backup each listed a directory and took whatever arrived, so a backup taken
with Transfer open would save part of a bank and report it as saved.

`wholeListing` now lives in `src/device/storage.ts` and every caller that decides what is on an
instrument goes through it: the library, `listProjects`, the backup, the manager, and the probe's
destination check before a write. It also refuses a reply with no SysEx end marker, and the refusal
names Transfer and Overbridge, because a reader can close an application.

`test/shortlisting.test.ts` holds the refusals and a fence: any `parseListing(` outside `storage.ts`
fails the suite unless it is the probe's listing card, whose job is to show a partial page as one.
The help's Safeguards page now has a section telling people to close both applications first.

It does not page. Asking for the rest was one of the three wrong turns on 2026-09-06, and a directory
larger than one reply has not been seen once the port was DNX's own.

## The probe's slot write had no backup of its destination — FIXED 2026-09-08

`writeToChosenSlot` on the probe page carried four of the five safe-write rules: it judged the
destination's occupancy against the device's own blank, named it in the confirmation, refused on a
bad record, and read back and byte-compared afterwards. What it did not do is **keep a copy of what
it was about to overwrite**: `existing` came from the capture in memory, not from a fresh read, so
a destination that was never captured had no backup at all — and the confirmation said so
(*"not in the capture — unknown, so assume it holds something"*) rather than fixing it.

It is exempt from the safe path for a real reason, recorded in `test/safewrite.test.ts` beside the
exemption: it writes **one captured record to an arbitrary slot**, which is not an image diff and
cannot go through `safeWriteRecords` at all. So the fix is a probe-page change rather than a
write-path one: one fresh `requestPatternKit` of the destination before the confirmation, which
serves both questions at once — what the slot holds, and what to keep.

Three details are the fix rather than decoration:

- **A silent device is a refusal, not a warning.** If the destination does not answer, nothing is
  sent. That is the sentence `safeWriteRecords` already uses for the same situation: a device that
  has gone quiet is exactly when a copy matters.
- **The order is confirm, copy, send.** `safeWriteFile` settled it for both halves of the reason: a
  backup downloaded for a write somebody then cancels is rude, and a write that began before the
  copy was taken is worse. A save that throws aborts the write.
- **The third outcome got sounder as a side effect.** `writeverdict.ts` separates "the device
  refused" from "the device overwrote wrongly" by holding the read-back against what the slot
  contained *before*. That comparison used to be skipped whenever the capture had no copy of the
  destination — which is precisely the case it exists for. It is now always available.

The copy is the same replayable `.syx` the safe path writes, from the same `buildRecordBackup`, so
sending it back is the ordinary write-back the page already does. `test/safewrite.test.ts` pins the
ordering by reading the function's source, because the whole of it is DOM and MIDI; the fence fails
on the code as it stood the day before.

## With two instruments connected, the probe chose one without asking — FIXED 2026-09-15

At 21:14, during the Digitone 1 release run PROBE-TWO-PORTS, a Digitone II had just been plugged in
alongside it. `PortPicker.render()` ran `bestPair` on every render and preselected whichever pair it
liked best, with nothing on screen distinguishing that guess from the intended device. Two Read
file presses returned `/soundbanks/H/2` and `/soundbanks/H/3` off the Digitone II. Only the file
signature (format `0059`, the image a 1.11 instrument writes) showed the reads had gone to the
wrong machine.

`candidatePairs` already scores a pair by how much of the input and output names it shares. Two
pairs whose names match each other exactly means two instruments are connected, not one guess to
make. `ports.ts` now asks `needsPortChoice` before preselecting anything: when two are connected,
the selects open on an empty "choose the instrument" option, Probe and Listen stay disabled, and
the status line says so. A single plausible pair, or none, still preselects and disables the same
as before. `test/probeports.test.ts` holds the rule with plain `{ id, name }` objects, no DOM
required.

## Every converted parameter lock had its two value bytes swapped — FIXED 2026-08-07

Reported from hardware: *"the expanded sounds showed a pan in the AMP page all the way to the
left."*

A lock slot is a **coarse** byte then a **fine** one (`lockvalue.ts`). `writeLockTable` read the
DN1 pair as a little-endian integer and wrote it back big-endian:

```ts
const value = dn1View.getUint16(from + 2 + step * 2, true);   // [coarse, fine] -> fine<<8|coarse
view.setUint16(to + 2 + step * 2, value, false);              // -> [fine, coarse]
```

So the value landed in the fine byte and **coarse became zero**. For an ordinary 0-127 parameter
that reads as 0 — wrong, but quiet. For a **bipolar** one it is the bottom of the range, and AMP
PAN is bipolar: every pan-locked trig of every converted project played hard left. 15,569 wrong
bytes across the nine matched pairs; after the fix, **6**, all of them the documented cases where
Elektron's own importer rescales a value (`17→25`, `43→51`, `71→89` on parameter 14, `1→0` on 73).

### Why the test suite was blind to it

`test/convert.test.ts` compares our conversion against Elektron's byte for byte, which is exactly
the instrument that should have caught this. It exempted a region as *residue*:

```ts
return within >= 0x4a34 && within < 0x15ad4;   // trigger slots AND the whole lock table
```

The exemption was written for **unused** lock records, whose trailing bytes really are residue.
It was implemented as the whole table. Every used record — all 392 of them — sat inside the
allowance, and the swap hid there for months while the test reported byte-identical output.

Now the lock table is exempt one record at a time, and only when *Elektron's* copy of that record
is unused. A second test compares the slots against the **DN1 source** in the format's own
vocabulary (`track:step:coarse.fine`), so the assertion says what it means. Both fail if the
endianness flips back — checked by flipping it back.

> **An exemption written for a subset must be implemented as that subset.** "Unused records hold
> residue" is true; "the lock table is residue" is not, and the second is what the code said.

---

## Silence proved nothing, and we kept treating it as evidence — FIXED 2026-07-30

**`output.send()` does not throw when another application holds the MIDI output.** It returns
normally and the bytes go nowhere. So a silence means either *the device did not answer* or *we
never spoke* — and the probe had no way to tell those apart while drawing conclusions from
silences for three days.

What it cost:

- **`DirList` timing out** was one of two pillars under *"the +Drive file API does not exist on a
  Digitone"*. The API exists. If Transfer was running at the time, that request may never have been
  sent — so `0x10` was **untested**, not absent.

  **Retested 2026-07-30 with a proven link: genuinely absent.** No reply in 4 seconds, and the
  device answered `Device` immediately afterwards. So the original conclusion about `0x10` was
  *correct* — and had been held for three days on evidence that could not support it. **Being right
  by accident feels identical from the inside to being right on purpose**, which is the whole
  argument for the link check rather than an argument against it.
- **A run of unknown-code silences** (`0x65`, `0x66`, `0x67`, `0x6c`–`0x6e`) was recorded as "not
  implemented" while Transfer held the port. Every one is void.

**Fixed** with `linkIsAlive()`: before any silence is interpreted, send `Device` — which every
Elektron answers, which takes no arguments — and match the reply to *our* message id, since
Transfer polls `Device` too. A negative is now reported as **verified** or **void**, and a void one
says plainly not to record it.

elk-herd has had a `LoopbackProbe` in `SysEx/Client.elm` all along. It was read on day one and
filed as housekeeping.

> **A tool that cannot tell whether it spoke has no business drawing conclusions from silence.**

## "No template available" while the server was serving one — FIXED 2026-08-04

Reported at the hardware: **Open Device on the manager refused with *"No template available"*, with a
Digitone 1 connected, the local server running, and Browse +Drive working on the same page.** Three
separate faults stacked up behind that one sentence, and each is worth keeping.

**1. The check that needed nothing ran last.** A device read needs a donor for the ~0.49% no dump
carries — header, song table, slot array — and every donor this page can produce is a Digitone II
project. So a Digitone 1 cannot be read here *whatever* the donor situation is, and that verdict was
available the instant the port opened. Asking for a template first meant a DN1 user was told about a
missing template instead of about their device.

> **Order the checks by what they depend on.** A check that depends on nothing cannot be wrong
> about anything else, so it goes first. The code already knew this — its own comment says
> *"checked before the read, not after it"* — and stopped one step short.

**2. A refusal for want of something the code already had.** `src/librarian/blankproject.ts` has
carried a device-authored blank since the expander needed one. Only the expander's *blank
destination* used it; the manager's device read, the expander's device read and the expander's
export all gave up instead. Four callers, one question, four answers — now `web/src/donor.ts`, which
tries a picked project, then the served `EMPTY.dn2prj`, then the embedded blank, and **cannot return
nothing**.

The embedded blank stays last on purpose. `src/cli/serve.ts` argues that a template must match the
storage version the device writes and it is right; ours is version 3 from firmware 1.10E. So the
fallback names its firmware in the status line rather than passing itself off as the user's own.

**3. A template that was present but unreadable was reported as absent.** `fetchServedTemplate`
wrapped its `fetch` *and* its parse in one `catch` returning `undefined`, and the callers rendered
that as "no template" — sending the user to look for a file already sitting on the server. The
swallow now stops at the network; a broken template throws, **with its own name in the message**,
which meant naming it in `readProjectFile` too because `readZip` does not know what it is reading.

Which of the three actually fired on the night is not established — the server serves the template
correctly from this checkout, so the fetch failing there is unexplained. That is the point of fixing
all three: after this, every one of them says something true, so the next occurrence identifies
itself.

> **"Not available" is a claim about the world. Make sure it is one you can support.**

## Exports that never arrived were Chrome holding them — NOT A DEFECT 2026-09-15

The release test of 2026-09-14 and its retest reported project exports that said "Exported" and
left nothing in Downloads: a full-size `.tmp` the first time, no file at all the second. The copy
taken before overwriting, saved a minute earlier from the same tab, arrived both times.

**It did not reproduce with a real click.** Measured on 2026-09-15 on `main`: two exports by mouse
click both arrived. Both failing runs had pressed Export from a script. A scripted export ran and
handed the file to the browser with user activation, and nothing arrived, with
`URL.revokeObjectURL` held back 30 s, which rules out the early revoke. After that a real click on
`127.0.0.1:8173` saved nothing either, while the same page on `localhost:8173` saved normally.

That is Chrome's guard against a site starting many downloads. Once it trips, every download from
that site waits on a prompt in the address bar, and no page can see the prompt.

**The same guard can catch a person.** DNX saves backups and pre-write copies long after the click
that caused them, which is the kind of download the guard counts. The DNX folder
(`web/src/dnxfolder.ts`, ROADMAP §12) writes those files straight to disk where the browser allows
it. A write there lands or throws, so the status line can say where the file is.

**For release tests:** press download buttons with a real click, and retry a missing file on the
other host name before calling it a DNX bug.

## A Digitone 1 project's copy was named and labelled as a Digitone II file — FIXED 2026-09-15

Found in the Digitone 1 release run (MGR-DN1-COPY-NAMING). The copy the manager takes before saving over
a +Drive project came out of a Digitone 1 as `RELTEST PRESETS-before-….dn2prj` with `ProductType: []`.
DNX still read it, but the name and the manifest both said Digitone II.

Two literals did it: `safewriteui.ts` replaced `.payload` with `.dn2prj` whatever the instrument, and
`projectFile` in `dnxfile.ts` wrote `ProductType: []` for every payload. Backups wrap their projects with
the same `projectFile`, so a Digitone 1 backup's projects carried the Digitone II manifest too.

Both now read the payload's family byte (`kind` at `0x08`): `productTypesFor` and `isDn1Payload` in
`src/device/drive.ts`, which `manifestFor` already used the same way, and `projectExtensionFor` in
`dnxfile.ts`. Checked on both instruments: saving `/projects/127` back over itself on the Digitone 1
saved `RELTEST PRESETS-before-2026-09-15T13-43-44.dnprj` with `ProductType: ["24","30"]`; the same on
the Digitone II's `/projects/19` saved a `.dn2prj`.

## Export did nothing for a project opened from the +Drive — FIXED 2026-08-04

Reported as *"after you rename or do any action the export button doesn't seem to do anything."* It
was not about renaming. **Every project opened from a +Drive slot exported to nothing**, and only
those: `openFromDrive` set `state.device`, `state.session` and five other fields but never
`state.file`, so `exportProject` returned at its first line —

```ts
if (!file || !session || !device) return;
```

— while the button sat enabled and the status line said *"export to a file"*. The one path with no
other way out was the one path that could not take it.

Three separate things had to be true for that to be invisible, and all three are fixed:

- **The precondition returned silently.** It now says which of the three is missing.
- **The click handler was `void exportProject()`** with no `.catch`, so a throw produced no
  download and no message either.
- **The button was enabled before anything checked it could work.** It is now enabled from the same
  condition the export tests.

> **A control that is enabled and does nothing is not a missing feature, it is a lie.** Enable it
> from the same condition the action checks, or the two will disagree.

**Nothing was missing from the library.** `manifestFor` — which rebuilds the `manifest.json` the
+Drive does not send, every field read off the payload or off the device — had existed and been
tested since the +Drive read was written, and had **no production caller at all**. `connectDevice`
now asks for `Version` while its session is open so the manifest's `FirmwareVersion` is the
instrument's own; when the device does not answer, there is no manifest and the export says so
rather than inventing a version.

The trap underneath it is worth keeping: **a stored project and a downloaded one are not the same
bytes.** A `.dnprj` holds its image LZ4-compressed and the +Drive sends it uncompressed, so building
a file from a +Drive payload means keeping its 31-byte container header — device signature, project
slot — and compressing the image behind it. `test/driveexport.test.ts` round-trips the real
2,781,743-byte capture through the export and back, checks the result decodes to the identical
image, and checks it is actually compressed rather than the raw bytes passed through.

### SAVE to the device — the experiment was run, 2026-08-04

Both presses, on a Digitone 1, captured in `99_HardwareTest/API_17msg_2251.syx`.

**The write sequence works.** `/soundbanks/A/1` → `/soundbanks/H/256`, 345 bytes in one chunk with
the checksum the device reported on the read, `0x59` acknowledged — and the device's own re-listing
then showed `256: "DIGIT-ONE"`. The first write to a Digitone's +Drive in this project's history.

**The checksum is enforced.** One bit flipped in it and the device answered
`Invalid package checksum; corrupt transfer`, with the link check passing so the refusal is an
answer rather than a silence. It is rejected at `0x58` — write-data — before any commit, so nothing
is left half-written.

> **SAVE-to-+Drive stays blocked, and is now a solvable problem rather than an unknown one.**

What changed is the shape of the remaining work. We can write back bytes the device checksummed
for us, and nothing else — which still excludes every edited project. But the device **names** a bad
checksum, so it is an oracle: a candidate algorithm can be tested one round trip at a time with an
unambiguous answer, writing only into an empty slot. That is a far better position than fitting a
function to matched pairs and hoping.

Next step is a checksum search driven from the instrument, seeded by the pairs already held
(`docs/device-storage.md` §7). The working route to the device is unchanged meanwhile: **Write to
device** sends changed patterns to the active project over the dump protocol, and SAVE PROJECT on
the front panel commits them.
## The grid drew one landing while the panel described another — FIXED 2026-08-04

Reported: *"if you tick/untick contiguous, the distribution of patterns already dropped doesn't
match the new toggle state — you have to re-drop for it to affect the preview."*

`replan()` called `renderSource()`, `renderReport()` and `replanForDevice()`, and **not**
`renderDestinationGrid()`. So ticking **Contiguous**:

- updated the plan panel and status line, because `replanForDevice` passes the new mode straight
  through to `planMerge`;
- left the grid drawing the previous `landingSlots()` marks and `pendingSources()` names, because
  nothing repainted it.

`onDrop` repaints explicitly, which is why re-dropping appeared to fix it.

### The interesting part

This is the failure `src/expand/landing.ts` was written to prevent, arriving through the other door.
That change gave the placement **rule** one home so the preview could not disagree with the write —
and it worked: both still called the same function. What it did not give one home to was
**invalidation**.

> **Giving a rule one home does not give its invalidation one.** A shared function cannot disagree
> with itself, but a view that never re-asks it can still be wrong, and nothing about sharing makes
> anyone remember to repaint.

So the pair — recompute, repaint — has a name: `landingChanged()`. Everything that changes the
selection, the anchor or the landing mode goes through it.

### The guard found a second live instance

`test/expanderwiring.test.ts` asserts that `replanForDevice` has exactly one caller. Written to pin
the reported bug, it immediately failed on four others — and **one of them was the same defect,
unreported**: clicking in the *source* grid changed the selection, recomputed the plan, and did not
repaint the destination. The selection is precisely what `landingSlots()` and `pendingSources()` are
computed from, so ctrl-clicking a fifth pattern updated the panel while the grid went on showing
marks for four.

The remaining three (`setDestination`, `applyMerge`, `undoApply`) already did both halves and now
say so in one word.

> A guard written for one instance of a bug is the cheapest way to find the others.

## Aggregated groups were ranked by their leader, not their total — FIXED 2026-08-04

Reported from the expander: with **aggregate by name** on, `HH TINNY` (2 trigs) and `HH NOISY`
(2 trigs) stayed sound-locked while `PUSH WEIGHT` (2 trigs) took the last free track. Promoting the
pair would have freed twice as many trigs.

`groupCandidate` had always summed the members' counts — the `HH` group *was* built, and it *did*
report 4 trigs. What never happened was reordering:

```ts
const ranked = rank(candidates, byTrigCount(order));  // ranks individual sounds
const groups = groupByName(ranked);                   // then groups them
allocate({ ranked: [...byCandidate.keys()] });        // in the leaders' order
```

So the candidates reached the allocator ordered by their **leaders'** individual counts, and a
four-trig group sat at position 12, behind four two-trig singles.

> **Ranking asks which promotion frees the most trigs. Once several sounds share a track, the
> answer is their total** — so grouping changes the answer, and the ranking has to be asked again.

`plan.ts`'s own comment said aggregation *"needs no changes to placement rules, pinning or
ranking"*. Two of those three were right.

**Fixed** by ranking the group candidates a second time, after grouping. Grouping still runs on the
individually-ranked list, so each group's leader — whose tags decide its placement character —
remains its highest-ranked member.

On the reported project (`005 SEA_GROOVE`, eight patterns): **92 trigs promoted instead of 90**, and
overflow down from 11 trigs to 9. The converter confirms it end to end — `trigsPromoted: 92`, and
**zero** trigs blocked by an aggregated-track step clash, so all four really move.

That last check is the one worth keeping. Two sounds on one track cannot both hold the same step,
and the converter reports it when they try; a ranking change that produced more promotions but more
blocked trigs would be a worse plan wearing a better number.

## An exported +Drive project claimed to be uncompressed — FIXED 2026-08-04

Reported from the hardware (T14): a project opened from a +Drive slot exported fine, but loading
the file with **Elektron Transfer stopped at "Calculating Checksum" and Transfer then crashed**.

Byte 29 of the 31-byte container header:

```
real .dnprj  ac 11 d3 03 02 00 05 00 09 30 30 39 37 00 … 04 01 0c   body LZ4-compressed
+Drive read  ac 11 d3 03 02 00 05 00 09 30 30 39 37 00 … 04 00 0c   body uncompressed
                                                            ^^
```

Every other byte of the two headers is identical. `buildPayload` copies the header verbatim — right
for all of them but this one — and then always writes an **LZ4 chain**. So a project exported from
the +Drive claimed to be uncompressed while being compressed.

**All 79 project files in the corpus carry `0x01` here**, both families, every firmware present. The
only `0x00` ever seen is the uncompressed +Drive stream. What the byte is *called* is still unknown
and does not need to be: everything `buildPayload` emits is compressed, so it now writes `0x01`.

### Why the test suite did not catch it

`test/driveexport.test.ts` already round-tripped the real 2,781,743-byte capture through the export
and back, and passed. **Our reader measures the body rather than trusting the flag** — `imageFrom`
decides by comparing the declared length against the image size for the family — so a wrong flag
was invisible to us and fatal to Transfer.

> **A round trip through your own reader proves your reader agrees with your writer, and nothing
> more.** The corpus is the only witness to what a real file looks like, and the check that was
> missing is the one that compares against it rather than against ourselves.

A test now asserts the emitted byte is `0x01`.

## Sound locks were read from steps that have no trig — FIXED 2026-08-07

Found by looking at what the new pool audit *said*, not by a failing test. Every project in the
corpus reported the same two things:

```
slot 161 is outside the pool entirely, locked by 128 pattern(s)
slot   0 ... 128 locks across 128 pattern(s)
```

**All 128 patterns locking the same two slots is not music.** It is unset memory: a step with no
trig still has a byte in the sound-lock array, and that byte is not `0xFF`.

`STEP_FLAG.trig` is verified across 1,571 pattern records, in both directions, with zero
exceptions — so gating the walk on it is not a guess. With the gate, `008 JAM` reads 119 of 128
slots occupied with plausible lock counts, and slot 161 disappears completely.

### It was not only the audit

`merge.ts` had its own private copy of the same walk, and it decides **which pool slots an incoming
merge needs**. So every merge has been over-reserving, and this is almost certainly the origin of a
note in `device-storage.md` recording dangling locks as *"ordinary in real projects"* — the
evidence for that was slot 161, which now looks like this bug rather than anybody's untidiness.

> **A finding that survives only because nobody looked at the output is not a finding.** The tests
> passed before and after; what caught it was printing an audit of three real projects and reading
> the numbers.

The reader lives in `project/dn2pattern.ts` now, beside the trig and lock tables, with `merge.ts`
and the audit both calling it.

**`reroute` is deliberately not gated.** It *writes*, the reader's gate is the change just made, and
altering both on the same inference is how a wrong assumption gets twice as far. Gating it would
send fewer bytes to a device and is worth revisiting with a round trip.

## The probe misread another application's traffic as an answer — OPEN 2026-07-30

**Elektron Transfer was running during the unknown-code sweep**, polling the Digitone continuously.
Two defects turned that into a wrong finding.

1. **Try code accepts *any* incoming message as its reply.** Deliberate — so an unexpected response
   code could not be missed — but on a shared port it cannot tell an answer from someone else's
   traffic. It reported `0x65 ANSWERED with 0x0f, 2 bytes, checksum BAD`. There is no dump type
   `0x0f`, two bytes is no record, and a bad checksum means it was never a dump message: **it was
   one of Transfer's API messages**, misread.
2. ~~**The capture summariser is a dump parser** and mangles API messages.~~ **FIXED 2026-07-30.**
   Fed `F0 00 20 3C 10 00 …` it read byte 4 as a product and byte 6 as a dump type, so it reported
   **"product 16"** with invented dump types and every checksum bad. `summariseCapture` now checks
   `isApiMessage` **before** the dump parser sees anything and counts API traffic in its own
   `summary.api`, named by code — `directory listing reply` rather than an invented dump type.

**What that cost.** `0x65`'s result is void, and so are the "silences" from `0x66` and `0x67` —
with Transfer holding the output port, our sends may never have reached the device at all. A long
line of reasoning was built on it, including a claim that we had put the instrument into a
streaming mode. We had not: the flood was Transfer, and **every message carried a `respId`** saying
it answered something we never sent.

**Fixes needed:**

- **Try code must verify the reply is a dump message from the expected product** before calling it
  an answer, and say plainly when what arrived was neither.
- ~~**The summariser should recognise API framing**~~ **DONE.** See above.
- **Port exclusivity should be surfaced.** Transfer will not start while the page listens; once it
  is running the page can listen but probably cannot send. The page has no idea, and reports
  silence.
- **Card text is not selectable while listening**, so a result cannot be copied without stopping.

**And the summariser fix uncovered what it was hiding.** On a Digitone II, a fresh **Listen** — a
port opened and nothing sent — captured 11 messages, 155 bytes, reported as `Unreadable 10` plus
one group `product 16 — unknown (0x04)`. All eleven are API messages.

`0x04` is worth spelling out, because it is a lesson in what an invented field looks like. Byte 6
of a dump is its type; in an API message byte 6 is the **first 8-in-7 high-bits byte**, and `0x04`
is bit 2 — set because payload byte 4 is the code and the code had its response bit set. So the
"dump type" was a faithful reading of a byte that means something else entirely, which is exactly
why it looked plausible for so long.

Whether the device volunteers those or they are buffered replies to something sent earlier in the
session is **not established** — it needs a fresh power cycle to separate. Either way the operating
consequence holds: **a capture is never empty of other traffic, and the first message to arrive is
not necessarily an answer.** Code that treats "the next message" as its reply is wrong on both
machines, not merely when Transfer happens to be running.

## Listening is quadratic — OPEN 2026-07-30

`renderCapture()` runs on **every** incoming message and calls `summarise()`, which re-parses the
whole capture from the start; the status line calls `summarise()` a second time. At the
5,973-message capture that is tens of millions of message-parses, and the page becomes unusable.

Nothing is lost — `capture.add()` runs before any rendering — but the tab crawls exactly when a
large transfer is arriving, which is the case the listener exists for.

**Fix:** summarise incrementally as messages arrive, and throttle rendering to a few times a second
rather than once per message.

## A write worked and the read-back vanished — FIXED 2026-07-30

A 114 KB pattern was written to an occupied slot and **landed correctly** — confirmed on the device
by eye — while the page sat on *"asking for A14 back"* forever. No reply ever came.

**The request was sent with zero delay behind 114 KB of SysEx**, and the device, still ingesting,
dropped it. elk-herd has always paced this and it is the one part of its send path we had not
copied: `SysEx.elm`'s `sendDump` sleeps `size / bytesPerMs + 20` before doing anything else, at
200 B/ms for a Digitakt and 800 for a Digitakt II. `settleMsAfter` now does the same.

Two things worth keeping from how this was found:

1. **The symptom pointed nowhere near the cause.** A write that worked plus a UI that hung looks
   like a broken read path, a dead port, or a device that ignores requests. Nothing about it says
   *pacing*. The fix therefore belongs in code every write path shares, not in whichever caller
   happened to notice.
2. **The captures nearly produced a confident wrong answer.** Comparing the two most recent ones
   showed `A14` unchanged, and the conclusion drawn was that the write never landed — possibly that
   the device refuses occupied slots, which would have been a significant false finding. The later
   capture was in fact the **pre-write baseline**. The user's manual check of the device is what
   caught it.

   The lesson is about captures rather than about writing: **a capture is only evidence if you know
   where it sits in the sequence.** Filenames carry a timestamp and nothing about what had happened
   to the device by then.

## The first write reported nothing at all — FIXED 2026-07-29

**Write back** was run on hardware and the UI did not visibly change. **Three** separate defects,
each of which alone produces exactly that symptom, which is why the result was total silence:

1. **A rejected promise was discarded.** The click handler used `void writeBack()`. `output.send()`
   can throw — a 114 KB SysEx message is not small — and the rejection went nowhere. Now caught,
   and the send is wrapped separately, so *"we refused before sending"* and *"the port rejected
   it"* are different messages rather than the same nothing.
2. **The capture renderer cleared the results area.** Every incoming message called
   `renderCapture()`, which wipes `#results` and redraws the capture cards. The verification reply
   *is* an incoming message, so it wiped the area a moment before the verdict was appended — and
   the verdict then landed below the capture cards, off screen.
3. **A guard firing showed only in the status bar**, one line at the bottom of the page, easily
   missed.

The lesson generalises past this page: **the one control that changes the instrument must not have
silence among its possible outcomes.** It now narrates every step into a card that survives
whatever happens next — bytes on the wire, send result, request issued, reply or timeout — so a
failure says *which step* failed instead of saying nothing.

### The fix was inadequate, and the third attempt is the structural one

The `writing` flag did not hold, and the user reported the card still vanishing. The flag is only
true *during* the write, so **any** message arriving afterwards redraws `#results` and destroys
whatever is in it — a reply that beat the timeout, a late one that missed it, anything.

Flags cannot fix this, because the problem is that two features share one element. The verdict now
lives in its own `#writeResult`, which `renderCapture` does not know exists. Nothing that redraws
the capture can destroy it, whatever the ordering. A late reply also **upgrades** the card instead
of wiping it, which is what a slow-but-successful write needs.

The general lesson: **when a redraw keeps eating something, stop guarding the redraw and move the
thing out of its reach.**

### And a false explanation the same capture exposed

The capture summary told the user that 129 patternKits with 128 distinct numbers meant the object
number had **saturated**. It had not — the 129th was our own verification re-read. The check was
just `count > distinct`, which is true of any repeat.

The bytes genuinely cannot tell the two apart, so the note no longer picks: it states the counts
and names both causes. **A confident wrong explanation is worse than an honest ambiguous one** —
the same lesson `G11` and the Digitone 1's `0x63` both taught.

### The write itself worked

Verified from the capture, offline: pattern `A1` read back **byte-for-byte identical**, 99,840
bytes, both checksums good. Writing to a Digitone II works.

---

## The failure mode to understand first

Conversion is a **transplant**: the caller supplies a DN2 project the device itself wrote,
and we overwrite only the regions we have verified. That is what makes writing safe with a
partial understanding of a 12.9 MB format — but it has one nasty consequence.

> **A field nobody writes silently inherits the template's value.**
> It does not crash, does not warn, and does not show up in a byte diff against Elektron's
> output if that output is also the template.

Two audible bugs shipped this way before anyone noticed, both caught on hardware by ear
rather than by 75 passing tests:

- **Pattern scale mode.** Per-track lengths were written correctly, but the mode byte
  deciding whether the device *honours* them was not. A 32-step bass line played as 16.
- **Track levels.** Every track arrived at the template's default of 100, so a converted
  project lost its mix entirely.

A third instance was found on 2026-07-26, the moment the machine selector was located:

- **The MIDI machine.** DN2 sound slots 4-7 carry machine 4 (MIDI) in every one of Elektron's
  conversions — 3,072 samples, no exceptions — because that is where the DN1's four MIDI tracks
  land. We wrote nothing there, so with a neutral template a converted project's MIDI tracks
  arrived carrying an FM TONE machine. It passed every byte-diff test because that test uses
  Elektron's own output as the template, which already had the right value. Fixed, with a test
  that converts from `EMPTY.dn2prj` specifically.

A subtler variant caused a fix to only half-work: several DN1 bytes were logged as
*"constant across the corpus, nothing to transfer"*. That reasoning is wrong — **nothing to
transfer is not the same as nothing to write**, because the template's value is not
necessarily the importer's.

**Mitigation.** `test/convert.test.ts` contains a per-region byte budget measured against
Elektron's output using the *neutral* `EMPTY.dn2prj` template. The byte-diff test uses
Elektron's own output as the template and is structurally incapable of catching omissions;
the budget test exists specifically to cover that blind spot. Keep budgets tight.

---

## Hardware validation: passed, 2026-07-25/26

`MORNING_JAM_EXPANDED.dn2prj` has been loaded on a real Digitone II. **Expanded tracks 9-16
exist and carry their sounds**, which was the single largest unproven assumption in the
project — and on 2026-07-26 the user reported that **every check they ran from the test sheet
cleared on the machine**: track lengths, levels, trigs still sound-locked where they should
be, and the per-trig detail that travelled with promoted trigs.

That closes the expansion writer as an unproven component. It is not a claim that every
pattern of every project is correct — the sheet covers what was checked — but the mechanism
is validated end to end on hardware.

**The MIDI machine fix is validated, 2026-07-26.** Build `MORNING_JA 1640`, converted from a
neutral `EMPTY.dn2prj` template. The user confirmed on the device that **tracks 5-8 all read as
MIDI tracks**, which is what the new write at `sound+244` exists to guarantee. Before the fix a
conversion from a blank template gave those four tracks an FM TONE machine.

Note the limit of that check: `002 MORNING_JAM` has **zero trigs on tracks 5-8 in all 128
patterns** — that DN1 project never used its MIDI tracks — so it validates the machine
assignment and nothing further. For MIDI *behaviour*, `048 ORION_MIDI_TEST` is the project to
use: its pattern A1 track 6 carries 16 MIDI trigs, one per step of page 1, and it is a matched
pair so Elektron's own conversion is available to compare against.

One reported defect did not survive checking: track 9's length in pattern A1 appeared to read
48 against the 62 in the file, and on reload it reads **62**, as written. The first reading
was of another track or page. Nothing was wrong and nothing was changed.

Two useful facts came out of chasing it anyway, and both are now recorded properly:

- Track length is written at `settings+0x0D` **on all 16 tracks**, tracks 9-16 included, with
  nothing accompanying it — `docs/dn2-pattern-format.md` §6.
- RESET and CHNG are pattern-level fields, not per-track — same section.

---

## Capture session, 2026-07-26 — what it settled

A device-authored project with one experiment per pattern, `docs/dn2-capture-plan.md`. Three
long-standing unknowns closed, all recorded in `docs/dn2-pattern-format.md`:

- **The trig-condition code table**, generated by two rules — negation is +1, ratios are blocks
  of `2B` starting at a known base. Previously unknown and unreachable from the corpus.
- **Probability is a literal percentage.** Not a ladder, not a table.
- **Bipolar p-lock values are offset by 64, not two's complement**, so they never collide with
  the `0xFFFF` unlocked sentinel — a question that had to be answered before this tool writes a
  p-lock to hardware.

It also corrected a reader assumption: **a lock slot is two bytes that are not always one
integer.** A fine-resolution parameter stores a coarse byte and a fine byte, which our `u16le`
read turns into nonsense. Conversion is unaffected — it copies the bytes through — but any
editor showing a p-lock value must know which kind of parameter it has.

**Done.** Both readers and the writer now agree on `u16be`, and `src/project/lockvalue.ts` splits
a slot into its coarse and fine bytes and offers the three readings a caller can want: the plain
0-127 value, the bipolar value, and the fine-resolution one. The corpus cross-validation still
finds the same 392 records and the same 6 rescaled values, which is the check that the byte-order
change is invisible to conversion.

### Still to do from that capture

**Nothing says which parameters are fine-resolution.** `lockvalue.ts` can decode a slot three
ways but cannot choose; the caller must know that parameter 29 on a synth track is an LFO depth.
Closing this needs the parameter-id table filled in — see the entry below on parameter naming.
Until then a UI can display byte-parameter locks correctly, and must ask before displaying the
rest.

**The `±1.00` steps of the depth sweep sit one fine tick out** (0.008 further from zero than the
value asked for). Three other points in the same sweep land exactly, so the scale is not in
doubt; the open question is whether the device rounds outward at whole units or the value was
entered a tick off. The same capture has a step labelled `+64.00` reading `+60.00`, so entry
slips are known. One short re-sweep of `DEP` around `±1.00` settles it.

## Open gaps, largest first

Measured as bytes per project differing from Elektron's conversion, with `EMPTY` as
template. All are bounded by the budget test.

### Rearranging patterns leaves the saved position stale — OPEN, found 2026-07-28

A project stores the pattern and track the device was on when it was saved (`dn2-format.md` §5b,
verified on hardware). **Nothing updates it**, so after any operation that moves patterns around,
the project reopens on whatever now occupies the old slot.

Harmless in that no music is lost, and visible immediately — the user found it by noticing a
generated test project opening on `G2`, the pattern it had been seeded *from*.

Not fixed alongside the discovery, deliberately, because the fix needs a decision that is not
ours: **does the cursor follow the pattern it was on, or stay on the slot?** Both are defensible.
Following the pattern matches *"I was working on this idea"*; staying put matches *"I was working
on this position in the set"*. A `Shuffle` can answer either — `rereference` gives the new home
of a moved slot — so it is a line of code once the question is settled.

The same question applies to the track byte when a track operation runs inside the open pattern.

### ~~Every project we write inherits the template's identity token~~ — FIXED 2026-07-27

**Found** by round-tripping a generated project through the device. Image header `0x18`–`0x1b`
is a project identity token, not a checksum (`dn2-format.md` §2 has the evidence). We never
wrote it, so it was a textbook instance of the failure mode at the top of this file: **a field
nobody writes inherits the template's value.** Everything built from `EMPTY.dn2prj` claimed to
be `EMPTY`.

**Settled from the corpus, with no new capture.** The nine DN1/DN2 pairs in
`test/convert.test.ts` are DN1 projects the Digitone II upgraded on first open, and their
values are all **distinct**: `5d4246fb`, `0bf60b53`, `6da54cda`, `46f4220d`, `2fc17649`,
`4981754d`, `13ba0237`, `57964b9b`, `313d29ba`. Nine device-authored conversions, nine
identities; our generated files duplicated their template's. That settles it. The remaining
question — whether the device's value is random or derived — does not change what we do, and
the field is demonstrably not validated on load, since inherited-value files have loaded and
played on hardware twice.

This also corrected the shape of the experiment first written down here. Elektron's Transfer
tool does not convert: it places the DN1 project on the +Drive, where it shows as needing
upgrade, and **the device converts on first open**. So "Elektron's importer" is the device's
upgrade path, and the corpus pairs already are the experiment.

**The fix: mint where a file is authored, not inside `convertProject`.** That function's
contract is to reproduce the device's upgrade byte for byte, and a field random by design
cannot be part of a byte-identical comparison — so it stays out of it and the guarantee is
untouched. `mintProjectId` / `writeProjectId` live in `dn2image.ts`, and the three places that
author a file call them: `cli/convert.ts`, `librarian/open.ts`, `web/src/app.ts`.

**Rearranging does not re-mint.** Editing a project is not authoring another one, so it keeps
the identity it had.

**One caveat worth stating.** This is the only place where we write into a field we have merely
inferred, rather than preserving an unknown region verbatim. elk-herd's discipline is the
opposite — its `structProjectSettings` skips to the sample list and keeps everything else as an
opaque `ByteArray`. The departure is justified because inheriting is *demonstrably* wrong here
and the field is unvalidated, but if anything odd ever shows up in +Drive project management,
this is the first thing to suspect.

### Kit MIDI track records — ~3 bytes/project, was 10,112

**Solved 2026-07-26.** DN1 `kit+0x54E`, 4 × 172 bytes, onto DN2 `kit+5964` record 4+n of 16 ×
268. Derived from 7,168 record samples (14 pairs × 128 kits × 4 tracks): of the 18 DN2 bytes
that vary, 14 have exactly one DN1 source agreeing on every sample, three are ambiguous by
value and assigned positionally, and one has none. See `MIDI_TRACK_MAP` in
`src/expand/fieldmap.ts`.

Two thirds of the old divergence was not the configuration at all but the **track name**: a
native DN2 names its MIDI records `MIDI 1`..`MIDI 16` and the importer clears all sixteen, so
a template contributed sixteen names we inherited. Textbook "constant across the corpus is not
the same as nothing to write".

What remains: `dn2[54]` varies across 0, 41 and 42 with no DN1 source — `UNPLACED_MIDI_BYTES`.
Two projects show a residue of 2 and 11 bytes per project; the other pairs are exact.

### Pattern metadata — closed, 0 bytes/project

**Solved 2026-07-26**, and 95% of it was one byte. `+0x21` reads 7 in every record Elektron
converted and 1 in every native capture, so a device-written template contributed 1 and we
inherited it — 768 of the 810 differing bytes. The other two were exact copies at the same
relative offset the rest of the block already uses: `+0x11` from DN1 `0x4735` and `+0x18`
from DN1 `0x473C`, unanimous across all 1,152 matched pattern pairs.

The block now matches Elektron byte for byte on every pair. What the three fields *mean* is
still unknown on both devices.

### Kit FX region — ~152 bytes/project, was ~409

Four of the seven unplaced DN1 bytes were found on 2026-07-26 by correlating what still
differed against the **whole** DN1 kit rather than only the FX block:

- `FX+0x37`, `FX+0x46`, `FX+0x47` are ordinary copies to kit+5859, +5874, +5875 — each at
  `5804 +` its own FX offset, the rule most of the block already follows.
- `FX+0x34` is **rescaled**, not copied. It lands on the DN2 compressor volume at kit+5898 and
  its fine byte at kit+5899 — two fields, not one `u16be`, corrected once the capture showed
  the device writing 5899 as zero and 5898 as a plain 0-127 byte. With the pair split, one rule
  reproduces all five observed inputs exactly: `min(floor(dn1 × 25600/127), 25599) / 256`. The
  five pairs are still stored as a **table** because *why* a 0-127 source lands on a 0-100 scale
  is unexplained; anything outside the table keeps the template's value and warns. This alone
  was 256 bytes/project, because the field differs in **every** kit. Full working in
  `docs/dn2-pattern-format.md` §6a.

`UNPLACED_FX_BYTES` is still `0x36, 0x3A, 0x4C`. All three were re-tested on 2026-07-26 against
their `5804 +` destinations once the input-page capture gave those offsets meaning:

- **`0x3A` → `IN L balance` and `0x4C` → `master overdrive`: rejected.** `0x3A` maps 0 and 100
  alike onto a centred 64; `0x4C` maps its two values onto more than a dozen destinations.
- **`0x36` → `IN L level`: SOLVED**, and it needed two sources rather than one.

**`kit+5858` — the first field that is not a function of one byte.**

```
kit+5858 = (DN1 tail mixer+0x0E == 0) ? 100 : DN1 FX+0x36
```

VERIFIED on **1,152 of 1,152** kit pairs. `FX+0x36` alone is an exact identity on 1,024 of them
and fails on all 128 kits of `053 TECNO_EXP`, where source 0 yields destination 100; both sides
are kit record version 10, so a format difference does not explain it. An exhaustive search of
all 2,560 bytes of the DN1's per-pattern block found no consistent source, because there is
none — the answer was never in that block.

**The DN1 has no kits.** That is a DN2 feature, and `DN1_KIT` in this codebase is our own
analogy. So nothing required the DN1's external-input settings to be per-pattern, and they are
not entirely: `tail mixer+0x0E` reads 1 in eight projects and 0 in `TECNO_EXP`, the one project
whose output takes the alternate state throughout. What the flag means *on the DN1* is UNKNOWN;
only its effect on the conversion is measured. The `flag == 0` branch rests on that single
project, so a second DN1 project with the flag clear would settle it.

**The compressor page: nothing to transfer, but something to write.** The DN1 has no
compressor — it is a DN2 feature — so no correspondence exists to find. All eight parameters
and their fine bytes are constant across every one of the 1,152 converted kits, and agree with
both `EMPTY.dn2prj` and the device's own defaults. They are now written as constants, so a
template carrying its own compressor settings cannot leak them into a conversion. `VOL` is the
one exception and comes from `FX+0x34` through `FX_COMPRESSOR_VOLUME`.

**CLOSED — all three input fields, and every unplaced DN1 FX byte.**

```
kit+5858  IN L level = (DN1 tail mixer+0x0E == 0) ? 100 : DN1 FX+0x36
kit+5860  IN R level = (DN1 tail mixer+0x0E == 0) ? 100 : DN1 FX+0x3A
kit+5878  DUAL       = (DN1 tail mixer+0x0E == 0) ?   0 : DN1 FX+0x4C
```

VERIFIED on 1,152 of 1,152 kit pairs each. These are the only fields in the project that are
not a function of a single source byte, which is why all three resisted every search: each
source is an identity on 1,024 pairs and fails on the same 128 — all of `053 TECNO_EXP`, the
one project whose flag is clear.

`0x3A` and `0x4C` had been rejected earlier, and that rejection was right about the
correspondence and wrong about the destination: they were tested against `5804 + offset`
(5862, 5880) because the rest of the block follows that rule. **The `5804 +` rule does not
reach the input page.**

`UNPLACED_FX_BYTES` is now empty and every named FX parameter is written —
`test/fieldmap.test.ts` asserts completeness rather than pinning exceptions.

Two limits worth keeping: what the flag means **on the DN1** is UNKNOWN, only its effect on the
conversion is measured; and the `flag == 0` branch rests on a single project, since all 128
flag-clear kits come from one file.

**Thirteen named FX parameters have no copy at all**, pinned by `test/fieldmap.test.ts`:
the whole compressor page except `VOL` (THR, ATK, REL, MUP, RAT, SCS, SCF, DRY/CMP),
`chorus HPF`, and `IN L level`, `IN R level`, `IN R reverb send`, `DUAL`.

Two of those look like defects rather than absent sources: **the left reverb send transfers and
the right does not**, and **the fine byte of `IN L level` transfers while its coarse byte does
not**. The compressor page may simply have no DN1 source. Either way each is a byte a
non-default template leaks through, which is the failure mode this document opens with.

Three DN2 bytes remain unexplained: **kit+5858** (values 0, 6, 94, 100, 102), **kit+5860**
(0, 100) and **kit+5878** (0, 1). None is an exact copy of, or a function of, any single byte
of the DN1 kit — checked over all 2,560 offsets across 1,024 kit pairs. They either combine
several sources or come from outside the kit record.

### Kit gap 10252-10751 — ~117 bytes/project

500 bytes of unidentified kit data. Two things are now known inside it:

- **kit+10260** is the `u16be` synth/MIDI track mask (`docs/dn2-pattern-format.md` §7). We
  write it.
- **kit+10264 looks like a 16 × 5-byte per-track array**, default `00 00 81 20 00`. Elektron's
  importer writes non-default values into individual entries — in `MORNING_JAM` A1, entry 2
  reads `00 00 01 20 00` and entry 3 `00 00 81 20 01` — and we never write any of it. The
  values do not correlate with track length or speed in the samples checked, so what they are
  is unknown. Alignment of the array start is inferred from the repeat, not proven.

The rest is uninvestigated.

### Tail project settings — ~19 bytes/project

MIDI config (sync, port config, channels) and audio routing. Tiny and tractable: only 30
distinct byte offsets differ between `EMPTY` and Elektron's conversions across four
projects. The clearest signal is `+0xA0..+0xA7` going `0xFF` to `8,9,...,15` in every
project — the per-track MIDI channel array widening from the DN1's 8 entries to the DN2's
16, corroborating the DN1 tail finding at `0x299A1B`. `+0xB0..+0xB7` look like per-track
flags.

### Track settings — ~5 bytes/project

Effectively closed, but four DN1 bytes vary with no consistent destination:
`UNPLACED_TRACK_SETTINGS` = `0x01, 0x06, 0x08, 0x0A`.

---

## Accepted divergences

Deliberate, bounded, and asserted so they cannot grow.

**Duplicate sounds in the project pool.** A DN1 pool accumulates byte-identical copies from
repeated saves — `002 MORNING_JAM` holds 64 named slots but only 57 distinct sounds, one of
them occupying seven consecutive slots. We copy the pool across verbatim, which is exactly
what Elektron's own importer does. **Deliberately not deduplicated:** the conversion is a
transplant, not a clean-up, and collapsing slots would mean rewriting every sound lock that
addresses the pool by index. Decided 2026-07-26.

**Unused trigger slots and unused lock records.** Elektron leaves uncleared residue there —
fragments of whatever previously occupied the memory. We write a clean `0xFF` fill, which is
what a natively empty DN2 pattern contains. Our output is arguably more correct than the
device's; either way the bytes are inert.

**146 parity bytes.** The importer sets the odd-step flag bit per 16-step page and only on
pages containing a trig; we set it on every odd step. That bit is documented UNKNOWN, is not
needed to decode anything, and never differs on a step that carries a trig.

---

## Untrusted or unverified

**DN2 pattern record version 2.** The factory `PRESETS.dn2prj` uses version 2; our reader
assumes 3 and its structural check fails on all 128 of its patterns. Conversion always
targets version 3 so this does not affect the converter, but a librarian operating on native
DN2 projects will hit it.

**Sound-mapping residue.** Three fields carry provenance warnings rather than certainty:
`dn1[173] -> dn2[229]` and `dn1[208] -> dn2[270]` are inferred from a structural rule and
confirmed on only one non-default sample each; `dn1[284]` and `dn1[286]` have no known
destination and are dropped, affecting 4 of 1,102 sounds. `convertDn1SoundToDn2Detailed`
reports all of these per field.

**DN1 song-row layout.** Rows are 21 bytes on the DN1 and 29 on the DN2, and the 8-byte
difference is certainly per-track — almost certainly a mute mask. Its position is unknown
because every one of the 89,199 corpus rows is empty. **Any feature that moves a track
between indices must refuse when the song table is non-empty**, or it risks a desync that
plays correctly but arranges wrongly. `isSongTableEmpty()` exists for exactly this.

**The 1,024 × 11-byte slot array** at DN1 `0x299A45`. `1024 = 8 × 128` and the corpus cannot
distinguish "8 tracks × 128 patterns" from the other factorisation. Empty in 50 of 53
projects. Guard with `isSlotArrayEmpty()`.

---

## Traps that have already cost time

**Entropy is not a compression test.** Windowed entropy over a project payload reads 3.7-6.2
bits and looks nothing like compressed data. It is LZ4 throughout. Worse, the leftover
literals invite false pattern-matching: a run of `u16le` match offsets puts an `0xFF` every
six bytes and looks exactly like a field layout. **Decompress first; never pattern-match raw
payload bytes.**

**Micro timing's `0xFF` means −1**, not "unset". It is the only byte in the pattern record
where `0xFF` is a value rather than a sentinel.

**Do not stop reading the trigger array at the first `0xFF`.** The device frees slots in
place and leaves holes. Elektron's importer happens to write a dense prefix, so code that
stops early appears to work until it meets a device-written pattern.

**Name fields are never cleared on rename.** Renaming NEW PROJECT to GROOVY leaves "JECT"
after the terminator. Re-encoding a decoded string zeroes that residue and diverges from the
device. Transplant the bytes.

**Rebuilt files are not byte-identical and that is fine.** LZ4 admits many valid encodings.
Correctness means *decodes to the same image*, never *same bytes*. Do not diff project files
to check a change.

## The probe stalled for minutes on a write — FIXED 2026-08-01

**Symptom:** writing a pattern appeared to hang. The device stored the bytes correctly and answered,
and the page sat with no verdict for 152s, then 246s, then 56s across separate runs.

**Cause:** the capture listener redrew the whole capture for every arriving MIDI message, and the
status line under it parsed the capture a second time. The instrument's sequencer sends MIDI clock
continuously, so ~100 messages per second each triggered two full parses of a multi-megabyte
capture. MIDI events dispatch back to back, so no timer, promise or repaint ran until the queue
drained.

**Fix:** the redraw is coalesced to at most one per 250ms with a trailing redraw, and the status
line reuses the summary the redraw already computed. A null round trip went from 246s to **0.3s**.

**Why it took four wrong diagnoses:** truncation, a deaf port, a suspended tab and a re-opened port
were each plausible, and each was argued rather than measured. What settled it was a liveness probe
and an inbound counter — together about thirty lines, less work than any single theory.

**The general trap:** a cost paid *per message* meeting a source that sends *many small messages*.
Total bytes were unremarkable — 24 KB — so anything profiling volume would have missed it. Worth
remembering before any live view of device traffic is built.
