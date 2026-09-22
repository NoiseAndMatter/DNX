# Manager UI — plan

**Status: refined 2026-07-27**, over two rounds with the user. The paradigm, the first slice, the
cuts and the scope below are agreed. What is still open is listed at the end rather than left
implicit.

Expect this to move. The user's words: *"I forsee that we might need to change some things on the
go."* It is a starting position, not a contract.

## What this is

**A project manager for the Elektron Digitone, in the spirit of elk-herd, with extra tools for the
DN2's new data structures.** The job is working on a project: move patterns between slots, replace
and build kits, assign sounds to tracks, bring new sounds in — and eventually a song editor.

**Both devices are subjects.** The manager opens and works on Digitone 1 *and* Digitone II
projects. **Cross-device conversion is one-directional: DN1 → DN2 only.** DN2 → DN1 is out of
scope and nothing should be designed to accommodate it.

## The DN1 sketchpad workflow — already built, and central

This is why the project exists, in the user's own framing: **use the DN1 as a sketchpad and finish
tracks on the DN2**, with better arrangement tools, more tracks and more voices.

That workflow is **done and hardware-validated**:

- `convertProject` reproduces Elektron's own importer byte-for-byte across fourteen matched
  projects.
- `planExpansion` plus the expansion writer give sound-locked sounds their own tracks on the
  DN2's sixteen, verified by sound identity across 3,342 trigs.
- `web/src/app.ts` already runs the whole chain in a browser: load a `.dnprj`, plan, export a
  stamped `.dn2prj`.

So it is **not** a later phase, and an earlier draft of this plan was wrong to call it one. It is
**entry point number one** of the manager, and re-homing it from a standalone page costs
essentially nothing. A user should be able to open a DN1 sketch, convert and expand it, and land
directly in the editor on the result.

**What genuinely remains undesigned is a different, narrower thing:** copying *one* DN1 pattern
into an *existing* DN2 project. That is not the same problem as whole-project conversion, because
the destination pool is already populated — converted sounds need deduplication and slot
allocation against it — and `planExpansion` allocates tracks across a whole project rather than
into a destination pattern whose tracks may already be occupied. That one is a later phase.

## Drag-and-drop feedback — DONE 2026-07-28

**Requested by the user after using the first cut.** The gesture worked; what it was about to do
was not visible enough — one amber outline for all three actions said only *that* something
would happen, and the *what* lived in the status bar, at the other end of the page from the
cursor.

Both changes are on the **destination** cell while a drag hovers it:

1. **A hue per action** — blue moves, green copies, amber exchanges. Three hues far enough apart
   to read at a glance, and deliberately *not* a variation on the selection ring: selection is a
   thin 2px outline, a drop target is a thick ring plus a saturated wash, so nobody has to work
   out which is which.
2. **The word across the middle of the cell** — `MOVE`, `COPY`, `SWAP`, over a scrim so it stays
   legible on a full cell. Drawn from a `data-action` attribute rather than an injected child,
   because a re-render rebuilds every cell and a stray `<span>` would outlive the drag that put
   it there.

Refusals still draw **nothing**, as planned: the browser's own "no" cursor already says it, and
a fourth state meaning *you cannot* would compete with the three that mean *this will happen*.
The subtle case is a batch with Ctrl held — a perfectly good move target that becomes a
non-target the instant the modifier goes down, because a batch swap is refused. Drawing `SWAP`
there would promise something that then refuses.

### Two things it turned out to need

**A modifier can change without the mouse moving.** `dragover` only fires while the pointer
travels, so holding still and pressing Shift would leave the cell saying `MOVE` while the drop
copied — exactly the confusion the labels exist to prevent. Document-level `keydown`/`keyup`
handlers repaint the hovered cell instead, which is why `dropHint` is a pure function of the
modifiers rather than of an event: the key handler has no drag event to read.

**A cell's own children fire `dragleave` on it.** Moving from the cell onto one of its labels
fires `dragleave` and then `dragenter`, so the decoration flickered off and on with the pointer
standing still. `.slot > span { pointer-events: none }` fixes it at the source rather than by
guarding the handler. The old outline was subtle enough to get away with this; a word across the
middle is not.

Applies to both grids, and to the trig grid when that exists.

## Batch rename — TO DO

**Requested by the user 2026-07-28, alongside the single rename that is now built.** Rename many
patterns at once from a rule rather than one name at a time. The schemes named so far:

- **by position** — the slot decides, so `A1 A2 A3` become `PART 1`, `PART 2`, `PART 3`
- **by selection order** — the order they were clicked decides, which is not the same thing and
  is the one a person reaches for after arranging something by hand
- **from a base name** plus a counter, and other algorithms as they come up

None of this reaches the writer. `planRename` and `applyRename` already take a `slot -> name`
map, so a scheme is a naming function producing one of those and **nothing else** — every rule
lands downstream of a writer that has already been verified and hardware-checked. The work is
choosing the schemes and the UI for picking one, not renaming.

Two things to settle when it is built. **Which order is "selection order"** must be visible
before the rename runs, or the user is guessing which of two plausible orders they got — the
preview should number the selection. And **duplicates**: the single rename warns and proceeds,
which is right for one deliberate name, but a scheme that silently produces sixteen identical
names is a different problem and should probably refuse.

## The paradigm: one project open, explorers as sources

**One project is open and being edited at a time.** Within it: move patterns around, replace kits,
create kits, assign sounds to tracks.

New material arrives through **explorers, which are read-only sources, not a second editable
project**. That distinction matters: you never hold two projects as peers, you hold one project
you are editing and a library you are pulling from.

Sources available today: the open project itself, other project files browsed read-only, and DN1
`.syx` sound banks, which `convertDn1SoundToDn2Detailed` already converts byte-exactly. The
device's own library is canonical and arrives with WebMIDI — see below.

**This paradigm settles a question an earlier draft left open.** Because you load once, do many
operations and export once, there is no chain of `MORNING_JAM(7).dn2prj` files. Where exported
files land stops being a design problem.

## The first slice

**Open one project, move patterns between slots, export a verified result.** Nothing else.

Then, in order: kit operations, then the sound explorer, then the kit explorer.

**CLI first, UI second.** `npm run copy` already exists for DN1. Everything hardware-validated in
this repository was built that way, and it makes the risky part testable before any pixels exist.

### What the slice actually requires

An earlier draft claimed the manager was *"buildable today — nothing missing"* and cited
`packages/core/src/librarian/copy.ts`. That module is **DN1 → DN1 only** — its own header says so, and it
imports `dn1.js` and `DN1_LAYOUT`. Recording the correction because it is the kind of error that
makes a plan feel finished when it is not.

| Precondition | State |
|---|---|
| DN1 pattern copy with sound-lock resolution | done, hardware-validated |
| DN2 pattern move | **done** — `librarian/rearrange.ts`, both families |
| One device-agnostic librarian over both | **done** — `librarian/device.ts` |
| Rewriting `slotIndexOffset` on every move | **done**, and asserted by the verifier |
| Tolerating DN2 pattern record **version 2** | **superseded 2026-09-06** — version 2 is now *read*, not refused, and the factory presets project opens |
| Song guard on the move path | **done** — DN1 checked, DN2 reports `unknown` |
| Verify-after-write | **done** — `verifyRearrange` |

**Not yet validated on hardware.** A rearranged project has been written and re-read, but no
device has loaded one.

**Intra-project moves are easier than cross-project copies**, which is part of why this paradigm
is the better starting point. The pool is shared, so sound-lock indices stay valid — no remapping,
no deduplication, no capacity check. `planPatternCopy` already supports passing the same image as
both source and destination; every lock resolves as `reused`.

What replaces dependency resolution as the risk:

- **`slotIndexOffset`.** The pattern record stores the slot it believes it occupies — DN1 in
  `PATTERN.slotIndexOffset`, DN2 at meta+0x1C. Every move must rewrite it, or the device meets a
  pattern that disagrees about where it lives. **`planPatternMerge` did not**, until 2026-09-22:
  every merged pattern carried its source slot, including in the expander, which ships. Found by
  running it against `applyPatternCopy` on the same inputs — across a 2.78 MB image they differed
  in that one byte and nothing else.
- **Version 2.** `checkDn2PatternRecord` rejects anything but version 3, and the factory
  `PRESETS.dn2prj` is version 2 — all 128 of its patterns fail. Our whole DN2 corpus is version 3,
  which means **the untested case is the one a manager meets first: a project the device itself
  wrote.** Version the struct the way elk-herd does rather than branching inside the reader.
- **Songs**, which is its own section below.

## Two devices, one librarian

The temptation is an abstraction that makes a DN1 project look like a small DN2 project. That is
wrong, and it produces a UI that renders DN1 files as broken DN2 ones.

| | Digitone 1 | Digitone II |
|---|---|---|
| Synth tracks | 4 | 16 |
| MIDI tracks | 4 | 16 |
| Steps per pattern | 64 | 128 |
| Kit | 2,560 bytes, 4 sounds inline | ~10.7 KB, 16 sounds, MIDI records, FX, mixer |
| Kits as a named concept | **no** | **yes** |
| Compressor | **no** | **yes** |

So the interface **exposes** the differences rather than hiding them. `layoutFor(image)` and the
`ImageLayout` interface are the seed of the right shape: one entry point that reports which device
a file belongs to, and per-device implementations behind a common set of operations.

**The test of whether this is right:** if the UI layer starts needing `if (device === "dn1")`, the
interface is wrong and should be redrawn early rather than defended.

## Songs

**Deferred by the user**, in favour of pattern, kit and sound workflows. Song mode support and a
song editor come later. This section records the constraint so it is not rediscovered.

Moving patterns within a project *is* rearrange mode, and the risk is that a song references
pattern slots by index.

- **DN1: guardable today.** The song table is located — `dn1tail.ts`, offset `0x2efc`, 17 records
  of 2,560 bytes, 99 rows of 21. `isSongTableEmpty()` exists and is currently **called by
  nothing**; wiring it into the move path is a day-one job.
- **DN2: not guardable.** The DN2 song table has never been located; `dn2-format.md` places song
  mode among the ~98,800 unidentified tail bytes. **We cannot currently prove a DN2 pattern move
  is safe with respect to songs.**

Since songs are deferred, the manager ships with the limitation **stated in the UI** rather than
silently. Locating the table is one capture of the kind that has worked four times — build a short
song on the device, export, diff a baseline — and it becomes a prerequisite the moment song
support is real.

## Principles

**Static and offline. The user's projects never leave the machine.** No upload, no server, no
telemetry. The current app is already this way and it is a hard requirement, not a nicety — these
files are the author's own music. Any feature needing a backend gets cut or redesigned rather than
compromising this.

**The app never stores your sounds, only where to find them.** No shadow copy of the user's music
in browser storage; remember locations, re-read files.

**Never invent a value.** The rule the converter follows. Where a field's meaning is unknown, the
UI shows the bytes and says so; it does not render a plausible-looking knob. This extends to
defaults: a "default" FX or mixer block is **copied out of a device-written blank project**, never
chosen by us.

**Verify what we write.** Every export is re-read and checked before it is offered. We have
`checkDn2Pattern` and a differential analyser; not using them would be a choice.

**Never modify the project that was opened.** Always a new file, always stamped.

**One naming vocabulary.** Patterns as the device shows them (`A1`, `B12`), steps as page and step
(`p2·7`), never a trig number above 16. `packages/core/src/project/naming.ts` already implements this and the UI
must import it rather than reimplement it — divergence between the hardware sheets and the screen
would be its own bug.

**Reads at arm's length.** Used beside hardware, sometimes in a dark room, sometimes in daylight.
Both themes are first-class; neither is an afterthought.

## Visual language

- **Colour**: one accent, everything else greyscale. Already established at `#6d4aff` light /
  `#b5a2ff` dark by the hardware sheets and the current app — reusing it makes them visibly the
  same tool.
- **Theme**: `color-scheme: light dark`, `prefers-color-scheme` as the default signal, plus an
  explicit toggle that wins in both directions. Every colour a custom property; no hard-coded hex
  outside the token block.
- **Type**: system sans for chrome, monospace for anything positional — offsets, step names,
  values, ids. The monospace does real work: it makes columns of steps scannable.
- **Device abbreviations, not friendlier ones.** Show what the hardware shows.
- **Never colour alone.** Locked/unlocked, pass/fail and machine kind each need a shape or a label
  as well, or the UI stops working for a colour-blind user and in print.
- **Density**: comfortable by default, with a compact mode for the pattern grid.

**Cut: the Overbridge eight-knob page as the organising unit.** That is an *editor's* visual
grammar. A manager's unit is the grid and the list. Revisit when there is a parameter editor.

## Screens

Ordered by when they are built.

1. **Open** — drop a project file, or a DN1 sketch to convert and expand. The app identifies the
   device and routes accordingly.
2. **Convert / expand** — the existing flow, re-homed as an entry point rather than a separate
   page, landing the user in the editor on its result.
3. **Project** — the 8×16 pattern grid: move patterns between slots, live patterns marked, name,
   tempo, pool occupancy, kit names with **divergence marked** (see below).
4. **Kits** — replace a pattern's kit, build a new one, assign sounds to the sixteen track slots.
   DN2 only.
5. **Sound explorer** — read-only source. Every sound in the open project, deduplicated by
   content, searchable and filterable; then other files and DN1 banks as sources.
6. **Kit explorer** — read-only source, browsing kits across the project and other files.

**Cut for now: the pattern inspector.** Trigs, conditions, probability, micro timing and named
p-locks make the most expensive screen here, and it moves nothing. It is the emotional payoff of
the mapping phase, which makes it the obvious next thing and the wrong one. What survives is the
summary the move preview needs.

**Cut: two projects side by side with drag between them.** Superseded by the single-project
paradigm and read-only explorers.

## Kits

**A kit is the whole kit record** — sixteen sounds *and* the FX, mixer and compressor state, plus
the sixteen track levels in its header. The device's own `KIT 1` copies in `DATA_CAPTURE.dn2prj`
differ from each other precisely in their compressor settings, so the hardware already treats
those as part of a kit. Inventing a sounds-only kit would be a concept the device does not have.

**Kits are DN2 only.** The DN1 has no named kits and no compressor, so these features must not
appear for a DN1 project.

**Building a new kit** means choosing sixteen sounds, then sourcing the non-sound block from
either a **donor kit** or a **device-written blank project**. Those are the only two options,
because the kit contains regions we have not identified — 160 bytes before the MIDI records and
500 trailing at 10,252 — and inventing their contents would break the never-invent rule. **The UI
says which source it used**, because these settings are audible.

**Replacing a kit changes the tracks' machines.** `sound+244` travels with each sound, and the
header carries sixteen track levels. That is a visible, audible change and it must be shown, never
done silently.

### What a kit name means

Kit names are **provenance, not identity**. In `DATA_CAPTURE.dn2prj` the name `KIT 1` appears on
patterns A1, A4, A5 and A6, and A4 and A5 have different compressor settings from A1 — four
patterns, one name, three different contents.

The reading that fits: a kit is a separate saveable object on the +Drive; loading one **copies**
it into the pattern and records its name; editing the pattern's copy diverges from the saved
original without renaming it or writing back.

**Consequence, and it is concrete:** showing `KIT 1` on four patterns must not imply they are the
same. The project screen has to be able to say *these have diverged*, which is a diff of two kit
records and something we can already do.

### The limit worth stating up front

**Saving a standalone named kit to the +Drive is not possible.** The standalone kit format is
unknown. elk-herd documents a family-wide **Kit request `0x62` / response `0x52`**; if the DN2
answers it, that response *is* the format. Until then, kits are built into patterns of a project
file — a real limitation to state rather than let a user discover.

## The sound library — scope

A DN2 project holds sounds in two places: the **128-slot pool** and **inline inside every
pattern's kit**, 128 patterns × 16 slots. Up to **2,176 sound objects in a single file**; a DN1
holds 512 inline plus 128 pooled. Most are duplicates, so even the single-project case needs
deduplication-by-content before a list is usable.

**Decision: scoped to the open project, plus read-only explorers.** Nothing persisted.

If a persistent library is ever wanted, **not the obvious version of it.** Indexing sound objects
into IndexedDB never touches the network, so it does not violate "offline", but it makes the app
hold a **shadow copy of the user's music** in storage they do not manage, cannot easily back up,
and that a browser "clear site data" destroys. It also **goes stale**: once a project is edited on
the device, an index entry saying "slot 42 of MORNING_JAM" is a claim about a file we no longer
have. The better shape is the **File System Access API** — grant a folder once, store only the
handle, re-read on open — with the honest costs that it is Chrome and Edge only, needs a gesture
per session, and wants progress feedback for a folder-sized scan.

### The device's own library is canonical

**The sound library on the connected Digitone is the canonical source for kit building.** Sounds
recovered from project files are a *fallback*, useful because it is what we can read today. The
library is not in the project file and its format is unknown, so it needs SysEx — see the roadmap.

## Still open

1. **Cross-device pattern copy** — DN1 → DN2 only, and its preview semantics are undesigned. It is
   not lossless the way a same-device move is.
2. **Browser split** — if File System Access is ever adopted, Firefox and Safari get a lesser
   experience. Decide deliberately.
3. **Publish target** — the CI config targets GitLab Pages while the repository is on GitHub. Not
   a question so much as a twenty-minute fix nobody has done.

## The expansion report follows the mode — 2026-07-31

**Reported by the user:** the *Sounds on tracks* breakdown showed the whole project even with
selected patterns ticked. It should show the expansion of the patterns already dragged into the
DN2; only whole-project mode should break down the whole project.

It was not only a display bug. The report rendered `planExpansion(source)` unconditionally, and
`planPatternMerge` converted with a whole-project plan too — so the panel was accurate about a
conversion nobody had asked for, and the merge allocated tracks against 128 patterns' worth of
competition. Both now scope the plan to the patterns in play; see `docs/expansion-design.md`.

What the panel shows, by mode:

- **whole project** — every live pattern, with the heading saying so.
- **selected patterns** — the merged patterns plus the current selection, so the panel answers
  *what is this project becoming* while you are choosing rather than going blank until you apply.
  The heading names the patterns and how many are not applied yet.
- **nothing chosen yet** — a hint to drag, rather than a stale breakdown.

### The panel above it had two faults of its own

Found in the same session, from a screenshot: selecting one pattern printed a wall of text over
the whole page, and the breakdown was still the whole project's.

1. **The page handed the merge the whole-project plan.** `planMerge` passed `state.plan` whenever
   it existed, which defeated the scoping underneath it entirely — the merge allocated tracks
   against 128 patterns of competition and produced a layout nothing on screen described. It now
   builds a plan for the selection, through the same `planFor` helper the report uses, so the two
   cannot disagree.
2. **Conversion notes were printed raw, all of them.** A merge converts the whole source project —
   a pattern's kit is written by the pass that writes every kit — so the report came back with one
   note per inferred field per sound across 128 patterns. On a real project that is over a thousand
   lines of the same few sentences, inside a `position: sticky` strip, so it grew taller than the
   page and drew the rest of the tool underneath it.

   `MergePlan.notes` now carries them scoped to the merged patterns and the pool slots actually
   placed, folded by message with counts, separate from `warnings` (which stays short and always
   worth reading). One corpus merge goes from 163 raw notes to 2. The panel renders them behind a
   `<details>`, and `#devicePlan` is capped and scrollable — a sticky element must never be able to
   grow without bound, whatever it has to say.

### Where the plan panel belongs — 2026-08-01

**The user, on seeing it fixed:** it should sit under *Sounds on tracks*, below "Every sound-locked
sound gets its own track" — "it is only relevant together with the sound allocation".

Right, and it says something about the page's structure. The options strip is for *controls*; what
a merge would do to the pool, to the locks and to the destination's patterns is a *result*, and it
means nothing except beside the allocation it comes from. Two panels describing the same operation,
one at the top of the page and one in the middle, made the reader hold one in their head to
understand the other.

It also closed the last of the overflow problem: out of the sticky strip, nothing about the panel
can cover the page, whatever a plan has to say.

Two duplications went with the move — the panel said `replacing A3` and `1 destination pattern(s)
replaced: A3`, and counted the conversion notes in a line directly above the disclosure that counts
them. Each fact is now stated once, in the voice that means "look at this".

## Sequencing

1. ~~**The spine.**~~ **Done, CLI only** (`npm run rearrange`). Device-agnostic librarian, pattern
   moves on both families, `slotIndexOffset` rewritten, version guard, song guard,
   verify-after-write. Still wants a hardware pass.
2. **Convert / expand re-homed** as entry point one, landing in the editor on its result.
3. **The project screen** — pattern grid, moves, kit-name divergence.
4. **Kit operations** — replace, build from donor or blank, assign sounds to tracks.
5. **Sound explorer**, then **kit explorer**, as read-only sources.
6. **WebMIDI** — upgrades the explorers to canonical, and unblocks preview and the kit request.
7. **Cross-device pattern copy**, then the pattern inspector, then songs and a song editor.

## The status bar belongs to the page it is on — 2026-08-01

**Reported by the user:** "1 pattern(s) → A3." sitting alone at the bottom, unaligned with
everything else — "is this some kind of remnant from the old UI?"

Not a remnant: `.status` is the manager's bottom bar, reused. In `body.app` it is the last child of
a viewport-height column, so it is pinned and always in view. On `body.page` it became an ordinary
`<div>` at the end of a long document — a message written while the user is looking at the middle
of the page appeared below the fold, and when it did come into view it started at the far left of a
window whose content is centred in a 78rem column.

Both halves are the same mistake as the layout collapse earlier in this file: **anything reused has
to say what it assumes.** `.status` assumed a flex column that fills the viewport.

- `body.page > .status` is pinned to the bottom. `body.page` already reserved the room for it —
  that is what its `padding-bottom` was for.
- The full-bleed bars — the top bar and the status bar — align their contents with the content
  column while still spanning the width. A bar that stopped at 78rem would read as a floating card.
- The merge's status line now says what to do next (`Planned — press Apply to fold …`) instead of
  repeating the panel's first line. Two identical sentences in two places is what made it look
  like something left over.

### The bar was being deleted, not mis-styled — 2026-08-01

Pinning it did not fix it, which was the clue. `statusBar` rebuilt `className` from a `base`
argument; the expander passed `""` on the strength of a comment claiming its stylesheet used a bare
`#status.error` — no such rule has ever existed. So the **first message the page wrote deleted the
element's `status` class**, and with it the background, the border, the padding and the pinning. The
topbar kept its alignment because nothing ever rewrites its class.

The bar now lives in `web/src/statusbar.ts`, which owns the class as well as the text: `statusBar`
asserts the class at wiring time, and `applyStatus` adds one of `error`/`warn`/`ok` and removes the
others, touching nothing else. There is no argument left that can spell "and forget what you were".

Two tests came with it: `test/statusbar.test.ts` drives `applyStatus` against a fake target (which
is why it takes a target rather than an id), and `test/web.test.ts` checks every page that writes
status messages actually carries `<div class="status" id="status">`.
