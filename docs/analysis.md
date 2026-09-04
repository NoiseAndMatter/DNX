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
| `web/src/analysis/charts.ts` | data in, SVG string out. Pure. |
| `web/src/analysis/mount.ts` | the only part that touches a document: sizing and the tooltip. |
| `web/mockups/metrics.html` | synthetic data and a composition of cards. A harness, not a page. |

`test/analysis.test.ts` covers the derivations and asserts the boundary: `charts.ts` and `model.ts`
reach no page folder and name no browser API. `mount.ts` is the deliberate exception.

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
- **A trig with no velocity lock sounds at its track default.** 599 of the 695 trigs measured carry
  no lock of their own, so reading `undefined` as 0 would silence most of a project.
- **Per-track lengths only exist when `SCALE` says so.** Every track record carries a length whether
  the pattern uses it or not; with per-track scale off — 51 of 64 corpus patterns — the sequencer
  plays every track at the master length and the stored values are leftovers. Drawing those would
  invent a polymeter the instrument is not playing.

### What it does not draw, and why

**Voice pressure, note-length marks and overlap detection are absent from the manager.** All three
need to know how long a note sounds, and a Digitone II project does not say: the trig carries a
note-length byte, the track a default of `0x0E` in 1,016 of the 1,024 tracks measured, and
**nothing maps either to a duration**. `dn2-pattern-format.md` marks even the name of the track
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
