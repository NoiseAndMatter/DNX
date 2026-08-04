# Known issues and open gaps

What is wrong, unfinished or untrusted, and how it was found. Read this before changing the
converter.

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

### SAVE to the device is blocked, and one experiment unblocks it

The other half of this report — *"we need SAVE so the changes can be committed to the project in the
device"* — cannot be built yet, and the reason is specific rather than general.

Writing a project to the +Drive needs `0x57`/`0x58`/`0x59`, which are decoded, and a **checksum
whose algorithm is unknown** (`docs/device-storage.md` §7). We can write back bytes the device
itself gave us a checksum for, and nothing else — which excludes every edited project by
definition.

**The experiment that settles it is already built** and sits in the probe: read a file, write the
identical bytes to an *empty* slot with the device's own checksum, then repeat with **Corrupt the
checksum** ticked.

- **Refused** → the field is validated, and the algorithm has to be fitted from the pairs we already
  hold before SAVE is possible at all.
- **Accepted** → the field is not enforced, and writing arbitrary content is unblocked outright.

Until then the working route to the instrument is unchanged: **Write to device** sends changed
patterns to the *active* project over the dump protocol, and SAVE PROJECT on the front panel commits
them. That route is proven on hardware; the +Drive one has never been performed.

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
