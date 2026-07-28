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

## Drag-and-drop feedback — TO DO

**Requested by the user 2026-07-28, after using the first cut.** The gesture works; what it is
about to do is not visible enough. Two changes, both on the **destination** cell while a drag
hovers it:

1. **Shade it by modifier**, so the action is readable without looking away to the status bar —
   a distinct tint per action rather than one amber dashed outline for all three. Move, copy and
   swap should not look alike.
2. **Name the action in the middle of the cell** — `MOVE`, `COPY`, `SWAP` — overlaid on the
   destination. The modifier is read at drop time, so this updates live as Shift or Ctrl is
   pressed and released mid-drag, which is what makes it worth drawing at all.

Applies to both grids, and to the trig grid when that exists. The refusal cases already lean on
the browser's own "no" cursor and should keep doing so: a fourth state meaning "you cannot"
would compete with the three that mean something.

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
`src/librarian/copy.ts`. That module is **DN1 → DN1 only** — its own header says so, and it
imports `dn1.js` and `DN1_LAYOUT`. Recording the correction because it is the kind of error that
makes a plan feel finished when it is not.

| Precondition | State |
|---|---|
| DN1 pattern copy with sound-lock resolution | done, hardware-validated |
| DN2 pattern move | **done** — `librarian/rearrange.ts`, both families |
| One device-agnostic librarian over both | **done** — `librarian/device.ts` |
| Rewriting `slotIndexOffset` on every move | **done**, and asserted by the verifier |
| Tolerating DN2 pattern record **version 2** | **done** — detected, reported, refused |
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
  pattern that disagrees about where it lives.
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
(`p2·7`), never a trig number above 16. `src/sheet/naming.ts` already implements this and the UI
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
