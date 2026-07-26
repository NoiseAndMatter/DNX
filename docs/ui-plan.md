# Web UI and kit builder — plan

**Status: queued for discussion.** Nothing here is committed to. It exists so the conversation
starts from something concrete rather than a blank page, and so the format work that has to
land first is visible.

## What has to finish first

The UI is blocked on very little. Reading and organising a project needs no new format
knowledge; **editing parameter values does**.

| Needed for | What is missing |
|---|---|
| Browsing, organising, **the kit builder** | nothing — this is buildable today |
| Showing what a p-lock does | machine-page ids (32..76), in capture now |
| **Editing** a sound's parameters | the sound object's *semantics* — see below |
| Sending to the device | WebMIDI / Elektron Transfer, not started |

The sound object is mapped **structurally but not semantically**: 139 of its DN2 offsets have an
identified DN1 source and conversion is 99.99966% byte-exact, but nothing says which byte is
`CUTOFF`. That is one more capture of the kind that has now worked three times — and it is the
only real blocker for a parameter editor.

**The kit builder does not need it.** A sound is a self-contained 359-byte object; assigning one
to a slot is a copy, not an edit.

## Principles

**Static and offline. The user's projects never leave the machine.** No upload, no server, no
telemetry. The current app is already this way and it is a hard requirement, not a nicety —
these files are the author's own music. Any feature that would need a backend gets cut or
redesigned rather than compromising this.

**Never invent a value.** The same rule the converter follows. Where a field's meaning is
unknown, the UI shows the bytes and says so; it does not render a plausible-looking knob.

**One naming vocabulary.** Patterns as the device shows them (`A1`, `B12`), steps as page and
step (`p2·7`), never a trig number above 16. `src/sheet/naming.ts` already implements this and
the UI must import it rather than reimplement it — divergence between the sheet and the screen
would be its own bug.

**Reads at arm's length.** This gets used beside hardware, sometimes in a dark room, sometimes
in daylight. Both themes are first-class; neither is an afterthought.

## Visual language

Take from Overbridge: the **eight-knob page** as the organising unit, the **track strip** as
persistent context, generous numerals for values, and the discipline of showing the device's own
abbreviations rather than inventing friendlier ones.

Leave behind: it is dark-only, extremely dense, and skeuomorphic. We want the *structure* of a
hardware editor with the *restraint* of a document.

- **Colour**: one accent, everything else greyscale. The accent is already established at
  `#6d4aff` light / `#b5a2ff` dark by the hardware sheets — reusing it makes the sheets and the
  app visibly the same tool.
- **Theme**: `color-scheme: light dark`, `prefers-color-scheme` as the default signal, plus an
  explicit toggle that wins in both directions. Every colour a custom property; no hard-coded
  hex outside the token block.
- **Type**: system sans for chrome, monospace for anything positional — offsets, step names,
  values, ids. The monospace is doing real work: it makes columns of steps scannable.
- **Never colour alone.** Locked/unlocked, pass/fail and machine kind each need a shape or a
  label as well, or the UI stops working for a colour-blind user and in print.
- **Density**: comfortable by default, with a compact mode for the pattern grid. Overbridge's
  density is right at a desk and wrong on a laptop.

## Screens

1. **Open** — drop a `.dnprj` or `.dn2prj`. Everything else follows from a loaded project.
2. **Project** — the 8×16 pattern grid, live patterns marked, name, tempo, pool occupancy.
3. **Pattern** — 16 tracks × steps. Trigs, conditions, probability, micro timing, sound locks,
   and p-locks named where `plockparams.ts` knows them, shown as raw ids where it does not.
4. **Sounds** — every sound in the project: the 128-slot pool plus each pattern's 16 kit slots.
   Search, filter, deduplicate by content, see where each one is used.
5. **Kit builder** — below.
6. **Convert / expand** — the existing flow, which is what the app does today.

## Kit builder

The idea in one line: **filter the sound list, then assign sounds to the sixteen slots of a
kit.**

### Why it is a good first feature

It is genuinely useful, it needs no format knowledge we lack, and it exercises the parts of the
UI everything else will reuse — a searchable list, a slot grid, and a write path that produces a
new file.

### Layout

Two panes. Left, the sound library with a search field and filters. Right, sixteen slots in the
device's own track order, each showing its assigned sound's name and machine. Click a sound then
a slot, or drag. A slot shows what it displaced so a mistake is one click to undo.

### Filters worth having

- **Text** across name, matching how the device shows it.
- **Machine** — FM TONE, WAVETONE, FM DRUM, SWARMER, MIDI. `machineOf()` already reads this.
- **Source** — this project's pool, a specific pattern's kit, or an imported DN1 bank.
- **Used / unused** — which sounds any pattern actually references. `collectSoundUsage()`
  already computes this for the expander.
- **Duplicates** — the corpus is full of them, deliberately: Elektron's own conversion keeps
  duplicate pool entries and we match it. Surfacing them is useful; removing them silently is
  not, and the user has already ruled that out for the converter.

### Where the sounds come from

The project's pool, the 128 patterns' kit slots, and DN1 SysEx sound banks, which
`convertDn1SoundToDn2Detailed` already converts. A DN2 `+Drive` sound library is **not** a
source: it is not inside a project file and its format is unknown.

### Writing the result

Assigning is a 359-byte copy into a kit slot. Two things make it less trivial than that:

- **Sound locks address the pool by index.** Rearranging the pool breaks every lock that points
  into it unless they are remapped. `src/librarian/copy.ts` already solves exactly this for
  pattern copy and the builder should reuse it rather than growing a second implementation.
- **A slot's machine travels with the sound.** Dropping a WAVETONE sound onto a track makes it a
  WAVETONE track, because `sound+244` is part of the object being copied. That is almost
  certainly the desired behaviour, but it should be *shown*, not silently done.

**Always write a new file.** Never modify the project that was opened. The whole tool is built
on not destroying the user's music.

### What it cannot do yet, and should say so

**Save a standalone named kit to the +Drive.** The DN2 treats kits as first-class objects that
can be saved and loaded independently — but we only understand kits *inside* a project. The
standalone kit file format is unknown and not currently on the roadmap. Until then the builder
writes kits into patterns of a project file, which is a real limitation to state up front rather
than discover.

## Open questions for the refinement pass

1. **Scope of a "kit"** — sixteen sounds only, or also the FX, mixer and compressor state that
   the DN2 stores in the same kit? The bytes are all mapped now, so either is possible. The
   second is more faithful to what the device calls a kit.
2. **Library across projects** — is the sound list one project at a time, or a library built
   from several? The latter needs persistence, which means the user's sounds sitting in browser
   storage. That is a privacy decision, not a technical one.
3. **In place or new file** — recommended: always a new file, always stamped. Worth confirming.
4. **How much of the pattern view to build** before the machine-page ids land, given locks will
   show as raw numbers until then.
5. **Publish target** — the CI config currently targets GitLab Pages while the repository is on
   GitHub. One of those should move.

## Sequencing

Nothing here starts until the format work finishes. When it does, the order that gets something
usable soonest:

1. Design tokens and the theme switch, extracted from the hardware sheets so the two match.
2. Sound list with search and filters — reused by everything after it.
3. Kit builder on top of that list.
4. Pattern view, which is where p-lock naming pays off.
5. Project grid and navigation, once there is something to navigate between.
