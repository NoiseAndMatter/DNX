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

A **project / pattern / track / sound manager** comes later, and is where editorial features
belong. The distinction matters when judging a proposal: conversion is a *transplant* and
should not clean anything up, while a manager is exactly where a user asks for changes and
can be shown what changed. Tidying the sound pool, re-laying-out tracks by tag, and merging
libraries all sit on the manager side of that line.

---

## Where things stand

Reading and writing both formats is solved and validated on hardware. Conversion reproduces
Elektron's own importer byte-for-byte. Expansion works. What remains is a handful of
untransferred fields, then a user interface.

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
| Remaining field transfers | in progress, see KNOWN-ISSUES |
| Web UI | first version done — load, plan, export |
| WebMIDI device transfer | not started |
| GitHub Pages and CI | not started |

76 tests pass. `npm test` runs them; corpus-dependent tests skip cleanly without one.

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

### 3b. Web UI — a project manager — PLANNED, queued for discussion

The plan is written: [ui-plan.md](ui-plan.md). **Queued by the user for after the format work
finishes**, to be discussed and refined rather than built from the document as it stands.

The short version. **A project manager in the spirit of elk-herd, with extra tools for the DN2's
new data structures** — copy and move patterns, sounds and kits between projects and slots, to
assemble performance sets, and eventually a song editor. Clean, minimal, genuinely dual-theme,
taking the eight-knob page and the track strip from Overbridge while leaving behind its
dark-only density. Static and offline, with the user's projects never leaving the machine.

Everything the manager does is a *reorganisation* of what we already decode, which is why it is
unblocked while an editor is not.

One utility inside it is a **kit builder**: filter and search the sound list, then assign sounds to
the sixteen slots of a kit. It is a good first target because it needs **no format knowledge we
lack** — a sound is a self-contained 359-byte object, so assigning one is a copy rather than an
edit — while exercising the searchable list, the slot grid and the write path that everything
else reuses.

Two limits worth knowing now. Sound locks address the pool by index, so rearranging it means
remapping them; `src/librarian/copy.ts` already does this for pattern copy and should be reused.
And a standalone named kit cannot be written to the +Drive, because only kits *inside* a project
are understood — the standalone kit file format is unknown.

What still blocks a parameter **editor**, as opposed to a builder, is the sound object's
semantics: 139 offsets are structurally mapped but nothing says which byte is `CUTOFF`. One more
capture of the kind that has now worked three times.

### 4. WebMIDI transfer

Elektron's Transfer protocol over USB, so projects move without files. Larger than it
sounds; file-based I/O should ship first.

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
