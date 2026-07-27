# Roadmap and progress

Living record of what is done, what is next, and why. Updated as work lands.

Companion documents: [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for defects and gaps,
[expansion-design.md](expansion-design.md) for the decisions behind the expander, and the
format notes in this folder for the byte-level detail.

---

## Scope

Two things, and everything is judged against them:

1. **A 1:1 Digitone 1 → Digitone II translation.** Whatever the source project holds should
   arrive on the DN2 unchanged. Where we cannot yet transfer a field, that is a gap to close,
   not a licence to improvise.
2. **Expansion** — the one deliberate departure from 1:1: sounds crammed onto the DN1's four
   tracks by sound-locking get their own tracks on the DN2's sixteen.

A **project / pattern / track / sound manager** is the third thing, and is where editorial
features belong. As of 2026-07-27 it is the active phase. The distinction matters when judging a
proposal: conversion is a *transplant* and should not clean anything up, while a manager is
exactly where a user asks for changes and can be shown what changed. Tidying the sound pool,
re-laying-out tracks by tag, and merging libraries all sit on the manager side of that line.

The manager works on **both devices**, but conversion stays one-directional: **DN1 → DN2 only**.
DN2 → DN1 is out of scope and nothing should be designed to accommodate it.

The DN1 → DN2 workflow is not a separate tool from the manager — it is the reason the project
exists. Sketch on the DN1, finish on the DN2 with more tracks, more voices and better arrangement
tools. It is **built and hardware-validated**, so it becomes the manager's first entry point
rather than a later phase.

---

## Where things stand

Reading and writing both formats is solved and validated on hardware. Conversion reproduces
Elektron's own importer byte-for-byte. Expansion works.

**The mapping phase is finished.** As of 2026-07-27 there is no format work blocking a user
interface: parameter locks can be named and decoded, every machine's parameters are resolved,
and the sound object's bytes have meanings rather than only sources. What remains is the
interface itself.

| | Status |
|---|---|
| SysEx container, both devices | done |
| Project container, LZ4 codec, CRC check field | done |
| DN1 project format — patterns, tracks, kits, sound pool, tail | done |
| DN2 project format — patterns, tracks, kits | done |
| DN1 to DN2 sound conversion | done, byte-exact on 5,760 sound pairs |
| Parameter-id and trig-condition tables | done, 58/58 and 35/35 |
| Writing project files | done, **loaded by a real Digitone II** |
| Pattern librarian (DN1) | done, **hardware-validated** |
| Expansion planning, rules, pins | done |
| DN1 to DN2 conversion | done, byte-identical to Elektron's importer |
| Expansion writer | done, **hardware-validated** |
| Compact per-pattern allocation | done, opt-in (`--compact`) |
| Reusing unused DN1 source tracks | done, on in compact mode |
| Hardware test sheet generator | done (`npm run sheet`) |
| Kit FX, mixer and external input | done, every DN1 FX byte placed |
| Machine selector (`sound+244`) | done, **hardware-validated** |
| Parameter-lock ids, fixed pages | done |
| Parameter-lock ids, machine pages | done, all ten machines |
| Sound object semantics | done, 54 offsets named and decodable |
| Remaining field transfers | see KNOWN-ISSUES — nothing blocking |
| Web UI | first version done — load, plan, export |
| Manager — DN1 and DN2 | plan refined, spine not started |
| WebMIDI device transfer | not started |
| GitHub Pages and CI | not started |

145 tests pass. `npm test` runs them; corpus-dependent tests skip cleanly without one.

---

## Done

**Formats.** Both SysEx and project containers, the LZ4 linked-block codec, the CRC check
field, and the internal layout of DN1 and DN2 patterns, tracks, kits and sound pools. The
Digitone II product ID `0x15` was established here and appears in no public source.

**Conversion.** `convertProject` reproduces Elektron's own importer byte-for-byte across all
fourteen matched projects, outside two residue regions and 146 bounded parity bytes.

**Expansion.** `planExpansion` decides which sound-locked sounds get promoted; the writer
moves their trigs, clears their locks, splits the parameter-lock table, switches claimed
MIDI tracks to synth and carries per-track settings and levels across. Verified by sound
identity: every trig still plays the same sound, 3,342 checked across three projects.

**Librarian.** Pattern copy between slots, banks and projects with minimal sound-dependency
resolution. Hardware-validated: a pattern copied into another project loaded and played
correctly, carrying exactly the four sounds it needed and no others.

---

## Next

Roughly in order of value.

### 1. Hardware validation — passed

`MORNING_JAM_EXPANDED.dn2prj` loads on a real Digitone II, tracks 9-16 carry their sounds and
honour their own per-track lengths, and every check run from the generated test sheet cleared
on the machine. The largest unproven assumption in the project is closed.

Still worth running when convenient: the same pass over the **compact** build, whose
per-pattern layout no Elektron file resembles.

`npm run sheet` generates a per-pattern test sheet from a converted file — positions named
as the device names them, A1..H16 and page·step — so a hardware session has something to
follow. Regenerate it after every build; every build stamps its time into the project name
so the device says which one is loaded.

### 2. Finish the field transfers

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md). The kit MIDI track records — the largest gap, and the
one that most plainly broke the 1:1 promise — are **done**: channel and CC configuration now
transfer, and the sixteen inherited track names with them, taking that region from 10,112
bytes per project to about 3. Pattern metadata is **also done** and now matches byte for
byte. What is left is the kit FX residue (~152, down from
397), the kit gap at 10252 (~117) and the tail project settings (~19).

### 3. Web UI — first version done

`npm run web`. Loads a `.dnprj` and a template, shows the plan, exports a stamped `.dn2prj`.
Entirely in the browser, publishable as static files.

Making it work forced a split worth knowing about: `container.ts` mixed the pure payload
format with ZIP decompression, so importing it in a browser pulled in `node:zlib` and failed
at load. The ZIP wrapper now lives in `projectfile.ts` and the browser brings its own, built
on `CompressionStream`. `test/web.test.ts` walks the import graph from the app entry point and
fails if anything reachable needs Node, so the boundary cannot rot.

Still to do here: pinning and reordering by hand, a per-pattern preview like the hardware test
sheet, and remembering the template between sessions.

### 3a. A device-authored test project, to crack what the corpus cannot — PLANNED

The table is written: [dn2-capture-plan.md](dn2-capture-plan.md).

**Queued by the user for straight after the first UI.** Build a DN2 project on the device in
which sounds and parameters are set to deliberate, known values from a test table, dump it,
and diff against a baseline. It is the `emnyeca` single-variable method, run for our own
purposes and aimed at the fields the matched pairs can never explain, because a matched pair
only shows what the *importer* does — never what a field *means*.

It is the only remaining tool for the residue we keep hitting:

- kit+5858, kit+5860, kit+5878 — the FX bytes no DN1 byte predicts.
- `dn2[54]` in the MIDI track record.
- The 16 x 5-byte per-track array at kit+10264.
- The 500-byte kit gap and the ~98,800 unidentified bytes of the DN2 tail.
- What the DN2 trig-condition codes at `+0x100` and `+0x180` actually mean.

The wider point is the right one: knowing what we clone is worth more than the bytes it fixes,
because it turns a transplant into an editor and unlocks the manager.

The plan uses **one capture carrying many distinct values** rather than one capture per change.
If every parameter holds a value no other parameter has, a single dump maps them all — the
changed bytes say where, the values say which. That collapses an evening of captures into
minutes, and `npm run diff` now names every offset in a pattern payload, so a clean capture
reads as a sentence. Blocked only on the Digitone manuals, which are needed to enumerate the
parameters of each page.

### 3b. The manager — REFINED 2026-07-27, active

The plan has been through two refinement rounds with the user: [ui-plan.md](ui-plan.md). The
paradigm, the first slice, the cuts and the scope are agreed.

**The paradigm: one project open and being edited at a time.** Within it — move patterns between
slots, replace kits, build kits, assign sounds to tracks. New material arrives through
**explorers, which are read-only sources rather than a second editable project**. Copying between
two projects comes later.

That paradigm settles a question an earlier draft left open: because you load once, operate many
times and export once, there is no chain of `MORNING_JAM(7).dn2prj` files, and where exports land
stops being a design problem.

**The first slice: open one project, move patterns between slots, export a verified result.**
Nothing else. CLI first, UI second, the way everything hardware-validated here was built.

**Conversion and expansion are entry point one, not a later phase.** An earlier draft filed the
DN1 → DN2 workflow under "cross-device, needs design", which conflated two different things. Whole
-project conversion with expansion is **done and hardware-validated** and already runs in the
browser; it should land the user in the editor on its result. What genuinely remains undesigned is
narrower — copying *one* DN1 pattern into an *existing* DN2 project, where the destination pool is
already populated and `planExpansion` allocates across a whole project rather than into a pattern
whose tracks may be occupied.

**A correction worth keeping.** The plan's first version claimed the manager was "buildable today,
nothing missing", citing `src/librarian/copy.ts`. That module is **DN1 → DN1 only**, so the
product's central operation did not exist for half its subject matter. The real preconditions:

| Precondition | State |
|---|---|
| DN1 pattern copy with sound-lock resolution | done, hardware-validated |
| DN2 pattern move | missing — a port, not research |
| One device-agnostic librarian over both | missing |
| Rewriting `slotIndexOffset` on every move | missing |
| Tolerating DN2 pattern record **version 2** | missing — the reader pins version 3 |
| Song guard on the move path | DN1 only — see 3c |
| Verify-after-write | missing |

Intra-project moves are *easier* than cross-project copies: the pool is shared, so sound-lock
indices stay valid and no remapping is needed. `planPatternCopy` already supports same-image copy.
The risk moves to `slotIndexOffset` — the record stores the slot it believes it occupies, DN1 in
`PATTERN.slotIndexOffset` and DN2 at meta+0x1C — and to version 2: the factory `PRESETS.dn2prj`
uses it and all 128 of its patterns fail our check, so **the untested case is the one a manager
meets first, a project the device itself wrote.**

**Cut from early work**, with reasons in the plan: the pattern inspector, the Overbridge knob-page
visual grammar, and side-by-side drag between two projects. **Kit work is near the front**, not
cut — in a single-project paradigm it *is* the project editor. What is genuinely blocked is
narrower: saving a standalone kit to the +Drive, and sourcing sounds from the device library.

**The device's own sound library is canonical** for kit building; project-derived sounds are the
fallback. Reading it needs SysEx, which is why WebMIDI moved earlier.

### 3c. Songs — deferred by the user, with a constraint to remember

Song mode and a song editor come **after** the pattern, kit and sound workflows. Recorded here so
the constraint is not rediscovered.

Moving patterns inside a project *is* rearrange mode, and the risk is a song referencing pattern
slots by index.

- **DN1: guardable today.** The song table is located — `dn1tail.ts`, `0x2efc`, 17 records of
  2,560 bytes, 99 rows of 21. `isSongTableEmpty()` exists and is **called by nothing**; wiring it
  into the move path is a day-one job.
- **DN2: not guardable.** The DN2 song table has never been located; `dn2-format.md` puts song
  mode among the ~98,800 unidentified tail bytes. **We cannot currently prove a DN2 pattern move
  is safe with respect to songs.**

Since songs are deferred, the manager ships with the limitation **stated in the UI** rather than
silently. Locating the table is one capture of the kind that has worked four times — build a short
song on the device, export, diff a baseline — and it becomes a prerequisite the moment song
support is real.

### 3c. The mapping phase — DONE, 2026-07-26/27

Four device-authored captures closed everything that blocked an editor. Written up in
`dn2-pattern-format.md` §4a/§4b, `dn2-format.md`, and `dn2-capture-plan.md`.

| Capture | What it settled |
|---|---|
| Trig conditions, p-locks, FX | the condition table, bipolar encoding, coarse/fine lock slots, the kit FX block |
| Machine pages | ids 33-81 are **machine-relative** — the same id means a different parameter on a different machine |
| Sound object | 54 offsets named, and its encodings match the lock table's |
| Follow-ups | `HOLD`, `AMP MODE`, `FTUN`, `HARM`, `FX BR` |

**Three lessons worth keeping**, because each cost time:

1. **Capture by position, not by name.** Parameter lists came from a PDF and were wrong four
   times — block-diagram labels read as controls, a stale OS version, an incomplete page. Asking
   for "SYN page 1, knob A" and letting the device supply the name removed the dependency.
2. **Give each control its own step or its own value, never both implicitly.** Every capture that
   identified controls positionally survived gaps, skipped controls and mis-entered values. A
   name-based sheet would have been ruined by any one of them.
3. **Use a blank project.** The sound capture used a converted one, so tracks carrying original
   music differed from the baseline in bytes nobody touched. Named offsets were confirmed by
   value match and are safe, but unmatched bytes proved nothing.

What is still open is small and blocks nothing: lock ids `32`, `63..65` and `86` are unclaimed,
and the four SYN 3 switches are ordered by inference rather than measurement.

### 4. WebMIDI — moved earlier, because three features now depend on it

Elektron's Transfer protocol over USB, so projects move without files. Larger than it
sounds; file-based I/O should still ship first, but this is no longer last.

**4a. Read the device's sound library.** The user considers the library on the connected Digitone
the **canonical** sound source for kit building — sounds recovered from project files are a
fallback. The library is not in the project file and its format is unknown, so this needs SysEx
sound-dump requests. Research.

**4b. The Kit request `0x62` / response `0x52`.** elk-herd documents this as family-wide. If the
DN2 answers it, **the response body is the standalone kit format** — the missing piece for "save
this kit to the +Drive as a named object", which is the kit builder's most wanted operation and
the one it currently cannot do. It is the only route to that format we know of, since kits do not
appear in a project file outside patterns. Cheap to try: send the request and see.

**4c. Sound preview, using the connected Digitone as the player.** Audition a sound by sending it
to the device and triggering a note, rather than synthesising anything ourselves. Requested by the
user; plausibly inexpensive once WebMIDI exists, and it is the feature that turns a file manager
into something usable for actually building a set. The open question is which slot or buffer a
sound can be pushed to **without disturbing the user's project**, and not disturbing it is the
hard requirement.

### 5. Publish

GitHub Pages plus a build and test workflow. Deliberately last — a few hours of well-trodden
work with no unknowns.

---

## Deferred, with reasons

**Rearrange mode** — letting the user re-lay-out tracks by tag rather than preserving the
DN1 order. Blocked on the DN1 song-row layout: the tail contains per-track references whose
position is unknown because every corpus row is empty. Moving a sound from track 2 to track
11 could desync a song. Preserve mode is also the only mode that can be verified against
Elektron's output, so it stays the default regardless.

**A promotion-ranking metric better than trig count** — 44 of 53 projects expand with no
overflow at all, so ranking rarely matters. The comparator is isolated for the day it does.

**DN2 pattern record version 2** — the factory `PRESETS.dn2prj` uses it and our reader
assumes version 3. Not blocking for conversion, which always targets version 3. It **is** a
prerequisite for the manager: the moment it opens a native DN2 project it may meet a version
2 record, and `checkDn2PatternRecord` currently fails on all 128 of that project's patterns.
Cheap to do properly — version the struct the way elk-herd does rather than branching inside
the reader.

**Manager prerequisites, so they are not discovered late.** Beyond version 2: any operation
that moves a track between indices must refuse when the song table is non-empty, because the
eight per-track bytes inside a 21-byte song row are located but not identified, and must
refuse when the 1,024-slot DN1 array is occupied, because its outer dimension may be the
track. `isSongTableEmpty()` and `isSlotArrayEmpty()` exist for exactly this and are currently
called by nothing — wiring them into the manager's guard path is the first thing to do, not
the last.

**Sound-pool clean-up** — collapsing byte-identical duplicates in a project's 128-slot pool.
`002 MORNING_JAM` holds 64 named slots and 57 distinct sounds, one of them repeated across
seven consecutive slots, so the saving is real. Deferred to the **manager**, not the
converter: conversion is a transplant and Elektron's own importer copies the duplicates too,
so doing it during conversion would be an unrequested edit.

The feature is only safe once **every** reference to a collapsed slot is repointed, and the
honest position is that we can enumerate the references we know about, not all of them:

- **Sound locks** address the pool by index and are fully enumerable — this part is easy.
- **Kit sounds are stored inline**, not referenced, so they are unaffected.
- **The DN1 tail holds no pool references at all** — verified across the 53-project corpus,
  `docs/dn1-tail-format.md` §0.
- **The DN2 tail's ~98,800 unidentified bytes are not ruled out.** Nothing says the device
  does not keep a reference there, and we cannot yet say it does not.
- **The 1,024 × 11-byte DN1 slot array** is UNKNOWN and empty in 50 of 53 projects; its
  populated values look like note numbers rather than pool indices, but that is a reading,
  not a proof.

So: collapse rather than compact (a duplicate's references move to the surviving copy, every
other slot keeps its index), and guard with `isSlotArrayEmpty()` the way rearrange mode is
guarded. Report what was removed rather than doing it silently.

---

## How to pick this up cold

1. Read [KNOWN-ISSUES.md](KNOWN-ISSUES.md) first — it names the traps that have already cost
   time.
2. `npm install && npm test`. Without a corpus, 26 tests pass and the rest skip; that is
   correct, not a failure.
3. The format documents in this folder tag every claim verified / inferred / speculative /
   unknown. Trust the tags: several sections exist to record what was ruled out.
4. The technique that solved almost everything: hold a DN1 value against the DN2 byte
   Elektron's importer produced, across the fourteen matched pairs, and keep only
   correspondences that hold for every sample. Parameter ids, trig conditions, track levels,
   track settings and kit FX were all derived that way.
