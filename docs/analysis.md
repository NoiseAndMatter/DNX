# Musical analysis — `web/src/analysis/`

Reading a pattern as music: how long it really is, how many voices it spends, what it is playing and
in what key. Distinct from the *device* analytics view in `ROADMAP.md` §5, which is about what is on
an instrument rather than what is in a pattern.

Started as a mockup on 2026-08-16 and reviewed over three days against `web/mockups/metrics.html`.
The charts were extracted into modules on 2026-09-05 with no change to what they draw.

---

## The layout

| | |
|---|---|
| `web/src/analysis/model.ts` | the input shape, and every derivation. Pure. |
| `web/src/analysis/charts.ts` | data in, SVG string out. Pure. A barrel: every caller, the mockup and the purity walk find the charts by this path. |
| `web/src/analysis/charts/` | one file per family, over `theme.ts` (colours, the type scale), `svg.ts` (the wrapper, the tooltip, and the drawing idioms more than one chart needs) and `legend.ts`. |
| `web/src/analysis/mount.ts` | the only part that touches a document: sizing and the tooltip. |
| `web/mockups/metrics.html` | synthetic data and a composition of cards. A harness, not a page. |

`test/analysis.test.ts` covers the derivations and asserts the boundary: `charts.ts` and `model.ts`
reach no page folder and name no browser API. `mount.ts` is the deliberate exception. It also
holds the folder's shape to the rule that a chart file imports only the model, `theme`, `svg` and
`legend`, never another chart and never the barrel. `test/charts.golden.test.ts` renders every
chart from one synthetic subject into committed fixtures, so a move that changes a byte of markup
fails rather than passing quietly; `DNX_UPDATE_GOLDEN=1` regenerates them.

## The input is a subject, never a project

Everything takes an `AnalysisSubject` — a label, a tempo, a master length, a voice budget, a default
velocity, and some tracks carrying trigs. Nothing under `analysis/` knows what a `.dn2prj` is, what a
+Drive slot is, or which page is asking.

**This is the decision that decides what analysis can ever cover.** Taking a decoded project image
instead would have been less code and would have fixed the whole subsystem to one subject: the
pattern open in the manager. A kit, a preset bank, a song's worth of patterns end to end, or two
projects side by side would each have needed the charts to learn a new container.

With a neutral subject, a new source is a new **producer**. The charts and the derivations do not
change at all.

So the rule for anything added here: *it takes a subject, or a list of them.*

### Notes are MIDI numbers

A stack has to be ordered low to high and a pitch class cannot say which of two notes is lower.
Pitch class is a view of a note, never how one is stored.

A trig carries **every** note it sounds. A chord is more than one, and that is where the voice
budget is actually spent — counting a trig once instead of counting its notes moved the measured
peak from 17 to 21 against a budget of 16.

A note p-lock needs no field of its own: `plockparams.ts` lists `TRIG 1 NOTE` under `NOT_LOCKABLE`
because the trig slot itself carries the note, so **the note already decoded is the locked note.**

## What the charts say, and what they only infer

The split is deliberate and is drawn on the page itself: a fact is a chart, an inference is stated as
one, in a block that says why.

| | |
|---|---|
| **fact** | trigs, gates, lengths, velocities, microtiming, pitch classes, the realign cycle |
| **inference** | the fitted key, a chord's name, and the degree it is read as |

**Key is Krumhansl–Schmuckler, named so the method is attributable, and the confidence is the
`margin` over the runner-up — not the correlation.** A relative minor shares six of seven notes with
its major, so a high score with a tiny margin is the normal case rather than the exception.

Three things move a pitch and none is visible in a pattern read: the **arpeggiator** transposes and
its settings are not decoded, a note p-lock changes one trig, and percussive FM material has no
tonality to find.

**Key fitting runs only over tracks playing more than one distinct pitch class.** With every track
included, a 16-step window held about eighty notes and the fit never moved once across 84 bars — a
hat on one pitch every step is an immovable spike no melodic line can outvote. The analysis was
measuring the drum kit. The test is measured rather than assumed, so it catches drones too.

## Overlaps are not glides

Two notes overlapping on one track is the **geometry** of a glide and nothing more. A glide is an
overlap on a *monophonic* track with *portamento* on.

Per-trig portamento is readable today — **`PORT` is lock id 99, `PTIM` is 100**. The track-level
default and mono/poly both live on the preset's SETUP page, which no capture has covered. Naming
these glides would assert two values nothing here can read, so they are reported as overlaps.

**On the capture list**, with the arpeggiator settings. Until then the chart says what it measured.

## Insights mode, in the manager — 2026-09-05

The `Insights` toggle in the toolbar swaps the manager from editing to reading. The bank tabs and
the pattern grid stay live at the top; the song panel folds to its strip; the side column, the track
drill-down and the edit affordances go; the analysis fills the full width below.

- **The grid is the subject selector.** Clicking between patterns to compare them on the same chart
  is the gesture the layout exists for, so a redraw **restores the scroll position** rather than
  jumping to the top, and the chart controls keep their settings across a change of pattern.
- **The song panel folds rather than hides.** A song is a legitimate analysis subject and the strip
  still says which one is selected, so the scope stays reachable. Leaving the mode does not unfold
  it: the fold is the reader's setting and this mode only borrows it.
- **It is read-only, structurally.** The side column carries History, which is undo. The grid is
  handed no drag controller in this mode, so a drop cannot happen with no visible way back.

`web/src/patternsubject.ts` is the first producer: a decoded image and a pattern index in, an
`AnalysisSubject` out. Digitone II only, and it refuses a DN1 by name rather than walking DN2
offsets over DN1 bytes.

### Three things it reads that a first pass would get wrong

- **A trigless lock trig is not a note.** Pattern A2 of `TECNO_EXP` holds 36 sequencer records: 8
  note trigs and 28 trigless lock trigs carrying parameter automation. The grid counts records and
  the charts count notes — both right, and the tile says which it means.
- **A trig with no velocity lock sounds at its track default.** Most trigs in the corpus carry no
  lock of their own, so reading `undefined` as 0 would silence most of a project. The accent
  threshold is read per pattern for the same reason: 1,712 of the 1,725 playing tracks read 100,
  and the other 13 read 127, 102, 79 and 89 — a four-project sample showed 100 everywhere and would
  have justified hard-coding it.
- **Per-track lengths only exist when `SCALE` says so.** Every track record carries a length whether
  the pattern uses it or not; with per-track scale off the sequencer plays every track at the master
  length and the stored values are leftovers. Drawing those would invent a polymeter the instrument
  is not playing. Corpus-wide **69% of the patterns that play something do carry real per-track
  lengths**, so both cases are normal.
- **A record at a version we do not read is refused by version, before anything is read out of it.**
  `PRESETS.dn2prj` is version 2 in all 128 of its records. Read as version 3 it reports 422 trigs on
  a pattern of length 0, at speeds no table names — plausible, and entirely fiction.

### What it does not draw, and why

**Voice pressure, note-length marks and overlap detection are absent from the manager.** All three
need to know how long a note sounds, and a Digitone II project does not say: the trig carries a
note-length byte, the track a default of `0x0E` in 1,577 of the 1,725 playing tracks, and
**nothing maps either to a duration** — and the byte takes 24 other values across the corpus, which
is what says it carries something rather than being a constant. `dn2-pattern-format.md` marks even the name of the track
default as inferred from its position in the Digitone 1 block rather than from a capture.

The subject carries `gateLengthKnown: false` and the page says so in a card of its own. The charts
are written, tested and working — the synthetic harness draws all three — and they will draw on
real data the day the mapping exists.

## What is next

1. **Decode the note length.** One capture: set one trig to each `LEN` value on the instrument,
   save, diff. It unblocks three charts that are already built.
2. **A separate Insights tool**, when analysis needs subjects the manager does not have open: two
   projects compared, a whole +Drive surveyed, a preset bank classified. That is a second caller for
   `analysis/`, not a move — the manager keeps its pattern inspector, because pattern-scoped insight
   belongs where the selection lives.

Multi-pattern selection needs no new code: `selection.ts` already does shift-range and ctrl-toggle,
and the model takes a list. Whether analysing several patterns at once reads well is the cheapest
useful test of whether the separate tool is worth building.

## What a corpus sweep changed — 2026-09-05

Everything above was built against four projects. Rendering **every chart of every pattern of all
24 DN2 projects at three widths — 9,003 charts** — found five faults that a green suite and a
careful reading had both missed, and corrected three claims.

### Faults

| | |
|---|---|
| **The page hung.** A version-2 record read as version 3 gave a track length of 0, `phaseStrip`'s repetition loop stepped by zero, and the sweep exhausted a 4 GB heap in seconds. In a browser: a dead tab. | Refuse on record version; guard every repetition walk against a stride below 1; `cycleSteps` ignores unplayable lengths rather than returning `0` or `NaN`. |
| **The status bar sat in the middle of the charts.** `body.app > main` is `flex: 1; min-height: 0` — a workspace sized to the window. The analysis is a document, so it overflowed and the status bar, an ordinary last child on this page, was laid out where `main`'s box ended. | `min-height: auto` in Insights mode only, so the page grows and scrolls. |
| **A MIDI track was labelled "unknown machine"** in every legend and tooltip — 49 of them across the corpus — because the producer special-cased `midi` to `undefined`. | A MIDI track carries `MACHINE.midi`. The kit mask stays the discriminator, so the two tracks whose machine byte disagrees with it still read MIDI. |
| **The phase strip drew a one-step window** on `017 PRESETS.dn2prj`, whose patterns declare a master length of 1 while their tracks run 14–64 steps: four dots on one pixel column. | Draw `max(master, longest track)` and say so in the caption when they differ. |
| **Opening a Digitone 1 while in Insights hid the editor with no way back** — the side column gone, the panel empty, the toggle disabled. | Wanting the mode and being in it are separate: the page falls back to the editor and returns by itself when a readable project is opened. |

### Claims that did not survive

| | four projects | the whole corpus |
|---|---|---|
| default velocity 100 | all 1,024 tracks | **1,712 of 1,725** playing tracks; 127, 102, 79 and 89 also occur |
| track default note length `0x0E` | 1,016 of 1,024 | **1,577 of 1,725**, with **24 other values** — which is what says the byte means something |
| per-track scale | "off in 51 of 64" | **69% of the patterns that play something carry real per-track lengths** |
| undocumented speed enums | 3 tracks | **none** — all three were version-2 fiction |

**The general lesson: a four-project sample agreed with every guess, and the corpus disagreed with
four of them.** Two of the five faults were in the *producer* and three were in code the mockup had
exercised for weeks — because synthetic data is written by someone who already knows the invariants.

### The mislabel

`densityBars`' middle band was captioned **"Parameter locks"** and counts trigs carrying microtiming
or a velocity above the track default. On a Digitone II both live in the trig slot itself — which is
exactly why `plockparams.ts` lists `TRIG 1 VEL` under `NOT_LOCKABLE`. They are per-trig values, not
lock-table entries. It now reads **"Microtimed or accented"**, and the real lock table remains an
unread reading.

## When a pattern actually repeats — corrected 2026-09-05

**The least common multiple of the track lengths is not the answer**, and reporting it as one was
wrong on 40 of the 352 playing patterns in the corpus.

In PER TRACK mode the sequencer has a **PATTERN RESET**: a number of steps after which every track
is pulled back to step one, whether or not it has finished. Elektron's manual describes it exactly,
and the guidebook adds the detail that the PATTERN column carries LENGTH and SPEED in PER PATTERN
mode but CHANGE and RESET in PER TRACK mode — **there is no pattern length in per-track mode at
all**, which is why one stored field at `+0x14` means two different things.

| | |
|---|---|
| `cycleSteps(tracks)` | the polymeter arithmetic — when the lengths would come round |
| `repeatSteps(tracks, resetSteps)` | what a musician hears — the above, bounded by RESET |

`MORNING_JA 1640(2)` A2: tracks of 16, 32, 62, 64 give a 1,984-step polymeter, announced as
**12 minutes 24** at 40 BPM. RESET is 128, so it repeats in **48 seconds**. The page now leads with
the bounded number and names the polymeter it cuts.

**One guess remains**: a RESET field of `1` is read as INF, by analogy with CHANGE where `1` is
documented as off. Unconfirmed on hardware — `Tests_To_Run.html` T41 is the capture.

> **The lesson is not about polymeter.** Every length was read correctly, every chart was
> self-consistent, and a 9,003-chart sweep of the whole corpus passed without complaint — because
> the sweep only ever compared us against ourselves. It took somebody who knows the instrument
> saying *there is a global pattern reset*. **A corpus cannot tell you that you asked the wrong
> question.**

## The polymeter card — 2026-09-05

Three questions the instrument cannot answer on one screen, because it keeps track lengths and the
pattern reset on different rows and never their remainder.

| tile | |
|---|---|
| **Pattern reset** | where every track is pulled back to step one, or INF |
| **Hands over after** | CHANGE — when a cued pattern takes over. *Not a repeat length* |
| **Polymeter** | the track lengths alone, ignoring the reset |
| **Reachable** | how much of that polymeter is ever heard |

**Reachable is the one worth explaining.** A reset does not shorten a polymeter — it makes most of
it unreachable. Every track returns to step one together, so the pattern is exactly periodic from
there and the phasing past it never happens. You do not hear less of it; you hear the *same* first
stretch, forever. `GLITCH_EXPLORE` B5 reaches 33% of its 192 steps: 128 of them never play.

### The reset ruler

One row per track, its passes laid across the reset, ordered with the interrupted tracks first. A
track whose length divides the reset draws whole blocks up to the line; one that does not draws a
stub in the alert colour, and **that stub is the part of the figure the sequencer cuts off — in the
same place, every time the pattern comes round.** 41 of the 352 playing corpus patterns have at
least one, across 63 tracks.

The card says plainly that a clipped figure may be exactly what somebody wanted. It is listed
because it is otherwise invisible, not because it is wrong.

### A marker that was built and removed

The phase strip briefly drew a dashed rule at the reset. Measured, the callers draw that chart over
exactly one loop of what plays, so the reset **is** the right-hand edge: in 261 of the 262 corpus
patterns that have a reset, the line would have sat on the frame saying nothing. Removed. The ruler
carries the cutting story and the phase strip stays about rhythm.

### CHANGE is on the page but is never a cycle

Elektron's manual: CHANGE *"controls for how long the active pattern plays before it changes to a
cued or chained pattern."* It ends the pattern rather than bringing it round, so it can never stand
in for the repeat length — that would be the same mistake as reporting the LCM. It answers a
different question: how much of a long polymeter anybody hears in a chain. `017 PRESETS` B8 runs
4,928 steps and hands over after 16.

It also carries the manual's own trap, which **58 corpus patterns are in**: with RESET at INF and no
CHANGE setting, *"the pattern plays infinitely and the next cued pattern will never play."*

## The reset calculator — 2026-09-05

*"What do I set so the polyrhythm runs its full length?"* The answer is a short list, not one number.

**The alignment grid** gives when each pair of lengths comes back into phase. **Keyed on lengths,
not tracks** — alignment is a property of two lengths, two 16-step tracks are always in phase, and a
sixteen-by-sixteen grid of tracks would mostly say so. Sixteen tracks bounds it at sixteen distinct
lengths, and the cells size to fit however many there are. The diagonal is each length on its own,
which the reader needs: *"T2 realigns with T5 every 48 steps"* means nothing beside an unstated
*"T2 repeats every 12"*.

**The ladder** offers the least common multiples of subsets of the distinct lengths, Pareto-filtered
so each row leaves strictly more tracks whole than the one before. For 12/16/24/64 that is four
rows: 12 → 1 of 4 whole, 24 → 2, 48 → 3, **192 → all four, and they realign**. Any other value
leaves the same tracks whole as the row below it and is strictly worse, so it is not shown.

The card says outright that a longer reset is not automatically better: letting a polymeter finish
is one musical choice and cutting it on a bar line is another. It reports what each costs.

### Written against the format, not against the corpus

A first version bounded its loops with *"no corpus pattern has more than four distinct lengths"*.
That is a fact about twenty-four projects, not about the instrument, and the tool will see other
people's music.

- **`cycleSteps` saturates at `POLYMETER_LIMIT`.** Sixteen pairwise-coprime lengths in 1..128 are a
  legal pattern whose least common multiple is around 10^30 — past what a double holds exactly.
  Unbounded, that value flows into every windowing loop as a limit, which is the same class of fault
  as the zero-length stride that exhausted a heap. `polymeterIsBounded` says when it saturated, so
  the page prints *"> 1M steps"* rather than the limit as though it were measured.
- **The subset enumeration is capped at sixteen**, because sixteen is how many tracks the machine
  has — not because of what the projects to hand contain. 65,536 subsets is 8ms.
- **The grid's cells size to fit.** A floor under the cell width would have run the chart off the
  side of the card at sixteen lengths, and the second line of each cell is dropped before that
  happens.

### The ruler needed the trigs, and that was not a cosmetic point

The first ruler drew passes and a red stub and nothing else, and it **over-reported**. Of the 63
interrupted tracks in the corpus, **44 lose notes — 511 trigs that never sound — and 19 lose
nothing**: the cut lands after every trig on the track, so the geometry is untidy and the music is
unaffected.

`MORNING_JA 1640(2)` A2 makes the case on its own. T3 and T9 are both **62 steps** with the **same
cut after 4**, and they are not the same event: T9 drops 12 trigs, T3 has a single trig at step 0
and loses nothing. Without the trigs drawn, those two rows were identical.

So `ResetCut` carries `lost`, a cut that loses notes is filled in the alert colour, and one that
does not is a dashed outline — shown, not alarmed about.

### Contrast, and why not dashed rules

Five consecutive passes in one flat colour read as one long bar. Passes now **alternate between two
steps of the ramp** and the gap is wider — the same fix the beat cells needed when their gap went
from 1px to 3px, for the same reason.

**Dashed vertical rules were the other candidate and were rejected.** There are already vertical
lines behind this chart and they mean bars; two sets of vertical lines meaning different things is
worse than a boundary that is slightly softer.

### Making the grid readable, which took a second pass

The first version was, in the user's words, *"true to the data but very hard to interpret."* A
matrix of numbers with a colour ramp and no key is a decoration. Four changes:

- **A ramp legend** — *back in phase sooner ▸ later*, with the actual step range at both ends. A
  sequential scale without a key asks the reader to infer the direction.
- **A worked example in the caption, taken from the data**: *"16 and 32 come back into phase every
  2 bars; 62 and 64 take 124 bars."* One cell read out loud turns a table into a sentence.
- **The cell where every track aligns is outlined** in the alert colour. It is the answer to the
  question the grid exists for, and it was previously just another blue square.
- **The ladder carries the same swatches**, so a value seen in the grid is recognised in the prose
  under it. `rampBand` is exported for exactly that — a colour that appears in one place and
  nowhere else is a colour the reader has to memorise.

And the grid now says the thing outright, underneath itself: *"All 8 tracks align after 1,984 steps
— 124 bars. It never gets there: RESET restarts every track after 128 steps."* Plus the culprit,
where one pairing decides it: *"62 against 64 — every other pair comes round sooner."*

**That sentence is the whole feature.** It was derivable from the grid before and nobody could
derive it, which is the definition of a chart that has not done its job.

### One legibility fault worth recording

The grid's ramp runs **light for a long wait** — the opposite of print convention, and right on a
dark ground, where the light end is the prominent one and long waits are what somebody opened the
grid to find. The cost is that the ink has to change with the cell: `--ink` on `--q4` and up is
close to invisible, which is what the first version shipped with. Dark ink from `--q4`, measured
against the ramp in `viz.css` rather than guessed.

## The master clock — corrected 2026-09-05

**A track's length is not its period.** SPEED is a multiple of the pattern's tempo, so 12 steps at
3/2x is a period of 8 master steps and 16 at 1/2x is 32. Alignment, resets and trig positions are
all on that clock.

| | |
|---|---|
| `masterPeriod(track)` | `length / speed` — master steps per pass |
| `masterOffset(track, step)` | where a step of that track falls, in master steps |
| `periodGroups(tracks)` | groups by **period**, replacing the old grouping by length |

16@1x and 24@3/2x share a period of 16 and stay locked forever; 16@1x and 16@2x do not, and the old
grouping had those the wrong way round both times. Reading raw lengths got **60 of 352 patterns**
wrong, and `GLITCH_EXPLORE` B5 was inverted outright — reported as a 192-step polymeter with two
cuts, when it is 64, exactly its reset, with nothing cut.

Periods are whole numbers of twenty-fourths, so the least common multiples are computed there and
scaled back. A `16 @ 3/4x` track has a period of 21⅓ and still gives an exact answer.

### Silent tracks are excluded, and the charts now say so

`playing()` drops tracks with no note trigs, and every figure on this surface is built from what it
returns. That is right — a track with a preset loaded and nothing sequenced makes no sound, so it
cannot be heard realigning and cannot lose notes to a reset — but it produced the obvious question
the moment somebody looked: **why is T5 not in the ruler?**

`MORNING_JA 1640(2)` A2 has **16 tracks with presets and 8 with anything sequenced**, so the ruler
draws 8 rows. The only place that was stated was the *Tracks in play 8 of 16* tile, three cards
away. Both the ruler and the grid now say it where the rows are missing.

**A chart that omits rows has to say which and why**, next to the rows it kept.

### A period is not a control, so the settings behind it are shown

The axis of the alignment grid is periods, and **nobody can set a period**. The instrument has LEN
and SPEED; a period of 8 is what 12 steps at 3/2x produces. A track somebody set to 12 appearing as
an 8 with no explanation is worse than not showing it, so wherever a period is drawn the settings
behind it are written beside it — the grid gains a third header line, the ruler a line under the
pass count, and the table gains **Speed** and **Period** columns.

Only when a speed is doing something: at 1x the period *is* the length and repeating it is noise.

**In full-strength ink, not a colour.** The obvious choice was the warm series hue, and it was
wrong: `--crit` already means *notes lost* in the same card, and a second near-red meaning something
else is the same fault as two sets of vertical lines. Weight carries it.

`periodSources` derives the speed rather than storing it — it is exactly `length / period` by
construction — and `speedLabel` prints it the way the instrument does, `3/2x` rather than `1.5x`.

**It also caught a live bug.** The polymeter table was still dividing the reset by the raw length
after everything else had moved to the master clock, so its "passes before reset" column was wrong
for exactly the tracks the master-clock fix was about.

### The Digitone 1 is half the length

64 steps over 4 pages against the DN2's 128 over 8. Nothing here hard-codes either — every bar count
is derived — but a DN1 producer must not inherit a DN2 ceiling, and the voice budget already differs
(8 against 16).

### Conditional trigs make every alignment figure a floor

A trig set to 2:3 plays on one pass in three, which multiplies the musical cycle. **1,388 of the
15,258 note trigs in the corpus are conditional, across 220 of the 352 playing patterns.** The code
tables are unread, so `AnalysisTrig.conditional` is a boolean and the page says the cycle is a floor
rather than pretending the conditions are absent or pretending to compute them.

## Trigs the sequencer never reaches — 2026-09-06

A track record holds 128 steps whatever its LEN says, and the sequencer walks only the first LEN of
them. Shortening a track keeps the trigs on the pages it drops: raise its LEN again and they are
still there, playing as they did. Confirmed at the instrument on 2026-09-06.

**7,543 of them sit across 521 tracks of the corpus**, so this is the ordinary condition of a
project rather than a curiosity. `MORNING_JAM` A4 T1 is sixteen steps and holds notes on 33, 37, 41
and 45. `017 PRESETS` A16 T2 is five steps and holds 22 past the end. `PRESETS` A5 T2 is sixteen
steps, plays nothing at all, and stores six.

Counting those as notes overstated the trig count, the voice pressure and the pitch content of every
pattern holding one, and the key fit read them alongside the notes that sound. So `patternSubject`
splits them off: `AnalysisTrack.trigs` is what plays, `AnalysisTrack.dormant` is what is stored and
unreachable, and `dormantTrigs` turns the second into a finding with the LEN that would bring each
track's back.

**They are held rather than dropped, because the count is the point.** A musician cannot see this on
the instrument: LEN is on one screen and the trig pages on another, and a page past the last one
looks unlit whether it is empty or out of reach. A part written and then lost to a shortened track
has nowhere to be found, which is exactly the kind of thing this page exists to say.

The boundary is off-by-one bait. A track of LEN 16 plays trig indices 0 to 15; index 16 is step 17
and is the first unreachable one. `006 GLITCH_EXPLORE` B1 T2 carries a trig exactly there, and it is
what the test asserts against — the corpus pattern this was first written against had a gap at the
boundary and passed either way.

The grid still counts sequencer *records* per slot, which is a different and correct number: it is
what the file holds, including lock trigs and dormant ones. Insights counts what sounds.

## There is no master length in PER TRACK mode — corrected 2026-09-06

`+0x14` is the pattern LENGTH in PER PATTERN mode and the **RESET** in PER TRACK mode, and
`patternSubject` handed over the raw field in both. So `AnalysisSubject.masterLength` was the reset
for 705 of the 829 playing patterns in the corpus, under a tile that said "Master length".

**49 of them reported a master length of one step**, because RESET at INF stores `1`. Another 22
reported values above 128, which no pattern length can hold. `PRESETS` A5 printed **"MASTER LENGTH
512 steps"** beside **"PATTERN RESET 512 steps"**: one field, shown twice, under two names.

A one-step window is worse than a wrong label. `masterFit` fits a key over
`pitchWindows(tonal, masterLength, masterLength, masterLength)`, and the beat view windows the same
number, so those 49 patterns had their key read from a single step.

`masterLength` is now the pattern's own length in PER PATTERN mode and the **longest track pass** in
PER TRACK mode — the shortest window in which every track completes once, which is what a default
drawing window is for. `AnalysisSubject.perTrackLengths` says which, because `resetSteps` cannot:
it is undefined both for a PER PATTERN pattern and for a PER TRACK one whose RESET is INF.

**The field was documented correctly and read wrongly.** `dn2-pattern-format.md` has said `+0x14`
carries two meanings since the `Per_Track_Reset_T01` capture, the comment beside `resetSteps` in
`patternsubject.ts` says it in full, and the assertion in `patternsubject.test.ts` was widened to
1..1024 *because* of it. Three places named the trap and the line above them walked into it.

## Traps this subsystem has already paid for

- **A chart must degrade toward the busy case.** Labelling every voice overrun read well with one
  and printed thirty-one overlapping strings with thirty-one. Drawing all 1,344 steps of a polymeter
  as one block per repetition made the wrap points — the chart's entire subject — invisible.
- **The viewBox must be the rendered width.** A fixed 940 in a card rendering at 1130 multiplied
  every label by 1.2, so a declared 10px landed at 12px against 13px body text and the factor moved
  with the window. `mount()` is what makes the type scale mean anything.
- **`windowSteps`, not `window`.** The span a chart draws is the natural word and also the name of a
  global these modules must never reach for. Shadowing it would make a later `window.innerWidth` read
  as a number of steps, and the boundary test could not tell the two apart.
- **A log scale divides by the log of its largest value, which is zero when nothing varies.** With
  every track the same length each bar is `0/0`; an SVG rect with a `NaN` width draws nothing and
  its label lands at x=0 on top of the track name, so the chart disappears without failing. The
  synthetic data always had mixed lengths; the very first real project hit it, and it is the
  *common* case.
- **Mounting a chart is not wiring its tooltip.** Every chart drew, every number was right, and
  nothing had a tooltip, because `attachTooltip` was never called — a green build cannot see a
  listener that was never bound. It is attached once, lazily, on the first draw.
- **The mockup's `random()` calls are in a load-bearing order.** It is one seeded sequence, so moving
  a draw past another changes every value after it. The extraction hoisted the sound-lock draw above
  the velocity draw, every trig shifted, and eight charts diffed as wrong when what had moved was the
  data underneath them.
