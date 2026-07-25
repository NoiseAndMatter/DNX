# Roadmap and progress

Living record of what is done, what is next, and why. Updated as work lands.

Companion documents: [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for defects and gaps,
[expansion-design.md](expansion-design.md) for the decisions behind the expander, and the
format notes in this folder for the byte-level detail.

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
| Expansion writer | done, **hardware validation in progress** |
| Compact per-pattern allocation | done, opt-in (`--compact`) |
| Hardware test sheet generator | done (`npm run sheet`) |
| Remaining field transfers | in progress, see KNOWN-ISSUES |
| Web UI | not started |
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

### 1. Finish hardware-validating the expander

`MORNING_JAM_EXPANDED.dn2prj` has now been loaded on a real Digitone II and the first defect
is already out of it: **track 9 displays LEN 48 where the file holds 62**, documented in
[KNOWN-ISSUES.md](KNOWN-ISSUES.md) with the capture that will settle it. Expansion writes
into tracks 9-16 in a shape no Elektron file has ever used, so this is where the remaining
unknowns are.

`npm run sheet` generates a per-pattern test sheet from a converted file — positions named
as the device names them, A1..H16 and page·step — so a hardware session has something to
follow. Regenerate it after every build; every build stamps its time into the project name
so the device says which one is loaded.

### 2. Finish the field transfers

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md). The largest is the kit MIDI track records: a DN1
project using its MIDI tracks currently loses channel and CC configuration.

### 3. Web UI

Load a `.dnprj`, show the proposed track assignment, let the user pin and reorder, export a
`.dn2prj`. Local-only, no server. The planning layer already produces everything the UI
needs to display, and `--dry-run` on the CLIs mirrors the intended flow.

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
assumes version 3. Not blocking, since conversion targets version 3, but a librarian working
on native DN2 projects will hit it.

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
