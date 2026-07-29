# DNX

Tools for Elektron **Digitone** and **Digitone II** project files.

Read, modify and write `.dnprj` / `.dn2prj` projects: patterns, kits, sounds, trigs,
parameter locks and sound locks. Files produced by this code have been loaded and played by
a real Digitone II.

Two things are being built on top:

- **Expander** — take a DN1 sketch, where extra sounds are crammed onto four tracks by
  sound-locking individual trigs, and give each sound its own track on the DN2's 16.
- **Librarian** — copy and rearrange patterns across slots, banks and projects, carrying
  their sound dependencies with them.

Elektron publishes no format documentation for the Digitone family. Everything here was
derived from real files; `docs/` records how, with every claim tagged verified, inferred,
speculative or unknown.

## Status

| | |
|---|---|
| SysEx container (DN1 + DN2) | done |
| Project container, LZ4 codec, CRC | done |
| DN1 pattern internals — trigs, sound locks, p-locks | done |
| DN2 pattern internals | done |
| DN1 → DN2 sound conversion | done, reproduces Elektron's own output byte-for-byte |
| Writing project files | done, **loaded by a real Digitone II** |
| Pattern librarian (DN1) | done, hardware-validated |
| Pattern rearrangement — move/copy/swap/clear, batched | done, **hardware-validated on DN2** |
| DN1 sketch opened directly as a DN2 project (`--as-dn2`) | done |
| Expansion planning, rules, pins | done |
| DN1 to DN2 conversion | done, byte-identical to Elektron's importer |
| Expansion writer | done, hardware validation in progress |
| Compact per-pattern allocation | done, opt-in (`--compact`) |
| Aggregate sounds by name onto one track | done, opt-in (`--aggregate`) |
| Hardware test sheet generator | done (`npm run sheet`) |
| Compact per-pattern allocation | done, opt-in |
| Remaining field transfers | in progress, see `docs/KNOWN-ISSUES.md` |
| Web UI | first version — load, plan, export, all in the browser |
| Session model with undo/redo | done |
| Track move/copy/swap/clear inside a pattern | done, DN2 only, **hardware-validated** |
| Pattern rename | done, both devices — batch schemes to come |
| WebMIDI — SysEx API and device probe | done, **confirmed on a Digitone 1 and a Digitone II** |
| WebMIDI — +Drive file access | **not possible on either Digitone** — neither implements it |
| WebMIDI — reading a device by request | **works on both devices** — pattern, kit, sound, settings |
| WebMIDI — reading a whole project by request | done, **hardware-validated on DN2** — 257/257, byte-identical to a device dump |
| WebMIDI — writing to a device | not started, see ROADMAP §3c-iv |

`docs/ROADMAP.md` tracks progress and what is next. `docs/KNOWN-ISSUES.md` tracks defects,
gaps and the traps that have already cost time.

## Usage

```bash
npm install

# What is in this file?
npm run project -- --objects path/to/project.dnprj
npm run inspect -- --hex 64 path/to/dump.syx

# What would expansion do?
npm run plan -- path/to/project.dnprj
npm run plan -- --summary --rules path/to/*.dnprj

# What tags does this library use?
npm run tags -- --locked path/to/project.dnprj

# Convert to Digitone II, optionally expanding across 16 tracks (dry run by default).
# The template is found via DN_TEMPLATE / DN_CORPUS / a sibling checkout; --template overrides.
npm run convert -- --from a.dnprj --expand                          # what would it do?
npm run convert -- --from a.dnprj --expand --out b.dn2prj --stamp   # commit it
npm run convert -- --from a.dnprj --expand --aggregate              # HH CLOSED + HH OPEN share a track
npm run convert -- --from a.dnprj --expand --compact --out b.dn2prj --template EMPTY.dn2prj

# What should this converted file do on the device?
npm run sheet -- --from a.dnprj --file b.dn2prj --out sheet.html

# Copy a pattern between projects (dry run by default)
npm run copy -- --from a.dnprj --pattern 3 --to b.dnprj --slot 17
npm run copy -- --from a.dnprj --pattern 3 --to b.dnprj --slot 17 --apply --out new.dnprj

# Open a DN1 sketch as a Digitone II project: convert and expand on the way in
npm run rearrange -- --project sketch.dnprj --as-dn2 --expand
npm run rearrange -- --project sketch.dnprj --as-dn2 --expand --move A4 --to C5 --apply --out done.dn2prj

# Rearrange patterns inside one project — DN1 or DN2, dry run by default
npm run rearrange -- --project a.dn2prj                      # occupancy grid
npm run rearrange -- --project a.dn2prj --swap A1 B12
npm run rearrange -- --project a.dn2prj --move A1 A2 A3 --to C5
npm run rearrange -- --project a.dn2prj --copy A1 --to C5
npm run rearrange -- --project a.dn2prj --clear B12 B13
npm run rearrange -- --project a.dn2prj --keep A1 A4         # a clean test project
npm run rearrange -- --project a.dn2prj --swap A1 B12 --apply --confirm --out new.dn2prj

# Rename a pattern — both devices, dry run by default
npm run rename -- --project a.dn2prj                              # what everything is called
npm run rename -- --project a.dn2prj --pattern A1 --to "INTRO 01"
npm run rename -- --project a.dn2prj --pattern A1 --to "INTRO 01" --apply --out new.dn2prj

# Move tracks inside one pattern — Digitone II only, dry run by default
npm run track -- --project a.dn2prj --pattern A1                  # what is on each track
npm run track -- --project a.dn2prj --pattern A1 --swap T1 T5
npm run track -- --project a.dn2prj --pattern A1 --move T1 T2 --to T9
npm run track -- --project a.dn2prj --pattern A1 --copy T3 --to T11 --scope preset
npm run track -- --project a.dn2prj --pattern A1 --clear T4 --apply --confirm --out new.dn2prj

# Build the pattern-rearrangement hardware test: two projects and an interactive check sheet
npm run hwtest -- --project a.dn2prj --keep A1 B5 --out ../dn_sysex/99_HardwareTest

# Build the track-operation hardware test: one project, A1 the reference, A2 upward one op each
npm run trackhwtest -- --project a.dn2prj                          # which patterns can seed it
npm run trackhwtest -- --project a.dn2prj --pattern G2 --out ../dn_sysex/99_HardwareTest
npm run trackhwtest -- --project a.dn2prj --pattern G2 --only 4 --out ...   # one step at a time

# What changed between two captures?
npm run diff -- --chain --stride captures/

# The web UI: expander at /, manager at /manager, read-only device probe at /probe
npm run web

npm test
```

## Tests and the corpus

Many tests validate against real Digitone projects. **Those files are not in this
repository** — they are the author's own music. The corpus is located at run time:

1. `DN_CORPUS`, if set — an absolute path to a folder laid out like `00_Examples/` below.
2. otherwise a sibling `dn_sysex/00_Examples/` next to this repository.

Without it, corpus-dependent tests **skip** rather than fail, so a fresh clone still runs a
green suite over the 8-in-7 codec, the SysEx container, LZ4 round-tripping, placement rules,
ranking and allocation.

```
<corpus>/01_DN1/01_Projects/*.dnprj       Digitone 1 projects
<corpus>/01_DN1/02_Sounds/*.syx           Digitone 1 sound banks
<corpus>/02_DN2/01_Projects/*.dn2prj      Digitone II projects
<corpus>/02_DN2/reference_captures/*.syx  native DN2 SysEx pattern captures
```

`.gitignore` refuses project and sound files outright, as a safety net.

## The web UI

`npm run web` builds and serves at `http://127.0.0.1:8173`. Three pages:

- **`/`** — the **expander**. Pick a `.dnprj`, choose the options, export a `.dn2prj`.
- **`/probe`** — the **device probe**. Read-only, and in two halves. **Probe** asks a connected
  Elektron what it is, what firmware it runs and which messages it supports. **Listen** sends
  nothing at all: it captures whatever the device chooses to send, so a dump triggered from the
  front panel (`SETTINGS > SYSEX DUMP > SYSEX SEND`) can be saved as a `.syx` — the same form as
  the corpus captures, so every existing tool reads it. **Read project** asks for all 128
  patterns, all 128 sound-pool slots and the project settings one at a time, waiting for each
  answer before asking again, and reports what came back — the same capture without touching the
  device's menus. Chrome or Edge only,
  and it asks for SysEx permission. It reads the device's capability list before sending
  anything, and **only ever sends messages classified read** — see `docs/device-probing.md` for
  why that matters, and what a stray dump would do to your instrument.
- **`/manager.html`** — the **manager**. Open a project of either family, move, copy, swap and
  clear patterns across its banks with undo, and export once. **Open another…** in the top bar
  swaps projects without reloading, asking first if there are unsaved edits. Double-click a
  Digitone II pattern — or select one and press **Tracks…** — to drill into its 16 tracks,
  where the same four operations move tracks and a **Move** selector picks which half travels.
  Select one pattern and press <kbd>F2</kbd>, or **Rename…**, to rename it.
  While dragging, the destination cell shades itself and says which action it is about to
  perform — `MOVE`, `COPY` or `SWAP` — and updates as you press or release a modifier.

The manager holds no rules of its own: `shuffle.ts` says what a move means, `rearrange.ts` and
`trackmove.ts` plan and verify it, `session.ts` holds the history, `tracksummary.ts` says what
a track holds so the CLI and the page cannot describe one differently. `test/web.test.ts`
walks both pages' import graphs and fails if either reaches anything needing Node, and checks
every `$("id")` against the page that has to define it.

**The template loads itself.** The browser cannot read your corpus, but the local server is
the CLI and can — it finds `EMPTY.dn2prj` via `DN_TEMPLATE`, `DN_CORPUS` or a sibling
checkout and serves it to the page, so there is nothing to pick. Deployed as static files
there is no server, the request 404s, and the file picker is still there.

No template is bundled, deliberately: a template must match the **storage version the device
writes**, and shipping one would quietly make it the template for every firmware. Your own
device-authored blank is by definition the right version for your device.

Everything happens in the browser: the page parses the ZIP, decompresses the LZ4 chain, plans
the expansion and writes the new project locally. **No project ever leaves the machine**, and
there is no server to speak of — the local one exists only because ES modules cannot load over
`file://`. It deploys to any static host as-is; `.gitlab-ci.yml` publishes it to GitLab Pages.

The only platform requirement is `CompressionStream`, for writing the ZIP — Chrome 80+,
Firefox 113+, Safari 16.4+.

## Layout

```
src/sysex/       SysEx dumps: 8-in-7 codec, container, device IDs
src/project/     Project files: ZIP, LZ4, CRC, images, patterns, kits, sounds, tags
src/expand/      Planning, routing, translation tables, the DN1 to DN2 converter
src/librarian/   Pattern copy with sound-dependency resolution
src/device/      Talking to a connected instrument: SysEx API, dump requests, capture, reading
src/cli/         Command-line entry points
web/             The browser UI: its own ZIP layer, then the same library as the CLI
docs/            Format documentation, roadmap, known issues
```

`src/project/container.ts` holds the payload format and is platform-free; `projectfile.ts`
holds the ZIP wrapper and is Node-only. That split is what lets the browser share every byte
of format knowledge with the CLI while bringing its own compression.

## Format notes

Full detail in `docs/`. The headlines:

- **Digitone II product ID is `0x15`** — established here; it appears in no public source.
- Project payloads are **LZ4-compressed** (linked blocks, 32 KB, shared dictionary) inside a
  ZIP. Windowed entropy reads 3.7–6.2 bits and looks nothing like compressed data, which is
  a trap worth knowing about.
- The check field is `crc32(payload[0x1F : len-12])` with a **zero init** — same polynomial
  as CRC-32 but not the standard parameterisation.
- SysEx payloads are **8-in-7, MSB-first**, and the length field keeps only the low 14 bits,
  so it wraps on large dumps.
- A SysEx pattern payload equals a project pattern record plus its kit record, byte-for-byte,
  so findings transfer between the two with no offset translation.

## Prior art

- [`emnyeca/digitone-syx-toolkit`](https://github.com/emnyeca/digitone-syx-toolkit) — 424
  single-variable DN2 pattern captures. The most valuable public artifact for this work.
- [`mzero/elk-herd`](https://github.com/mzero/elk-herd) — Digitakt project editor; the model
  for versioned structs and preserving unknown regions verbatim.
- [`bsp2/libanalogrytm`](https://github.com/bsp2/libanalogrytm) — Analog Rytm structures.
- [`ashojaeddini/digitools`](https://github.com/ashojaeddini/digitools) — DN1 sound tags.

## Licence

See `LICENSE.md`.
