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

## What is next

1. **An Insights mode in the manager.** The bank tabs and pattern grid stay live at the top, the song
   panel folds to its strip, the side column and edit controls hide, drops are declined, and the
   analysis fills the full width below. Selecting a pattern redraws it **without losing the reader's
   scroll position** — comparing two patterns on the same chart is the gesture the layout exists for.
2. **Then a separate Insights tool**, when analysis needs subjects the manager does not have open:
   two projects compared, a whole +Drive surveyed, a preset bank classified. That is a second caller
   for `analysis/`, not a move — the manager keeps its pattern inspector, because pattern-scoped
   insight belongs where the selection lives.

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
- **The mockup's `random()` calls are in a load-bearing order.** It is one seeded sequence, so moving
  a draw past another changes every value after it. The extraction hoisted the sound-lock draw above
  the velocity draw, every trig shifted, and eight charts diffed as wrong when what had moved was the
  data underneath them.
