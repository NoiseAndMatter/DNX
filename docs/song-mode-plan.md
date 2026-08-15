# Song mode — what it is, what we know, and how to find the rest

A plan for reading, showing and eventually editing Digitone II songs in the manager.

---

## 1. What a song is

From the Digitone II manual §10.13 and §13.2. **16 songs per project**, up to **99 rows** each, plus
an always-present END row.

| Per row | Range and behaviour |
|---|---|
| **LABEL** | A keyword for the row — Verse, Chorus, Fill — or the pattern's name |
| **PTN** | The pattern the row plays |
| **ROW PLAY COUNT** | How many times the row plays before the song advances |
| **ROW LENGTH** | Steps played from that pattern. 2–1024; the last 25 read `K00`–`K24`. Defaults to the pattern's own length |
| **ROW TEMPO** | BPM for the row, inherited from the pattern by default. A song tempo set on any row **overrides all row and pattern tempos**. Swing is always per row |
| **ROW MUTE** | Per-track mute mask over the 16 tracks. Initially reflects the pattern's own mute state |

Song-level: a **slot** (1–16) and a **name**. `SETTINGS > SONG` offers RENAME, CLEAR, LOAD and SAVE
TO PROJ. The **END row** is set to LOOP or STOP.

Songs auto-save as they are edited, but **the project must be saved** for them to survive loading
another project.

Two facts that matter for an editor rather than a viewer:

- **A row references a pattern by slot.** That is exactly the reference a rearrangement invalidates,
  which is why `librarian/device.ts` has a song guard at all.
- **CREATE ROWS FROM CHAIN** builds a whole song from a chain in one action. That is the cheapest way
  to produce many rows on the device, and the capture plan below leans on it.

---

## 2. What we already know

### The Digitone 1's song table is decoded

`src/project/dn1tail.ts` has it: **17 records of 2,560 bytes** at tail offset `0x2efc`, each holding
**99 rows of 21 bytes**, a version of `1`, a `u16be` tempo at `+0x838` reading BPM×120, and a flag
byte at `+0x835`.

**The row interior is deliberately not decoded.** That module says so in as many words: a row carries
per-track bytes whose positions are not established, and guessing "would silently desync an
arrangement". Only emptiness is decided, and it is decided from the corpus — 89,199 rows across 53
projects, none of them holding content.

### The Digitone II's song table has never been located

`SongState` returns `unknown` for the DN2, and the comment says why: its song mode "sits in the
~98,800 unidentified tail bytes". The rearrange guard is therefore blind on the DN2 — it cannot tell
a project with songs from one without.

The search space, scoped:

| | bytes |
|---|---|
| DN2 image | 12,889,604 |
| tail begins (`tailBase`) | 12,780,032 |
| tail | 109,572 |
| sound pool (128 × 359) | 45,952 |
| **unidentified** | **~63,620** |

### The corpus cannot answer it

Scanned all 24 DN2 projects in `00_Examples/02_DN2/01_Projects` for printable runs anywhere past the
pool. **Nothing.** Every ASCII run in every tail is a pool preset name; beyond the pool there is not
one printable string in any project.

So either no project in the corpus has ever had a song, or a song name is not stored as plain ASCII
in the image. Either way the corpus is silent and **captures are genuinely required** — this is a
negative result worth recording so nobody repeats the search.

---

## 3. The consequence that shapes everything: songs need a +Drive write

**A song never comes over the dump protocol.** The tail — pool, settings, slot array, song table —
is not transmittable, which is why a device read needs a donor to supply it and why
`writeChangedRecords` reports `untransmittable` rather than pretending.

So `writeChangedRecords` can never send a song edit. Song editing requires **writing a whole project
file to a +Drive slot**, which only became possible with the chunk-numbering and stored-form fixes.
The song editor is the first feature that actually needs that capability.

That gives the manager two write destinations with different meanings, and the UI must not blur them:

| edit | goes to | by |
|---|---|---|
| patterns, kits | the **active** project | dump records, `safeWriteRecords` |
| songs | a **stored** project | a whole-file write, `safeWriteFile` |

---

## 4. The capture plan

**Differential, not statistical.** Save a project, change one thing on the instrument, save again,
and diff. Whatever moved is the thing. No inference, no ranked candidates — the bytes either changed
or they did not.

This replaced an earlier plan to find the table by scanning for repeating structure. That approach
was built, examined against the Digitone 1 whose table is known independently, and **failed** — a
region of mostly-empty records is periodic at every stride, so the true answer cannot be
distinguished from a meaningless one. The failure is recorded here because it is the reason the
method below is the right one, not merely a cheaper one.

### Baseline: PRESETS on the DN2

Slot 1, already read and known. Three saves:

| # | on the instrument | what its diff gives |
|---|---|---|
| 0 | open PRESETS, **save unchanged** | the **noise floor** — bytes a save moves on its own |
| 1 | add a song, drop in a few existing patterns, save | **the song table**, once 0 is subtracted |
| 2 | change **one row's every parameter**, save | the field offsets inside a row |

### Why save 0 matters

A project re-saved with no changes is **not** guaranteed to be byte-identical — counters and
timestamps move by themselves. Without that control, the first hunt reports save bookkeeping as a
discovery. `npm run projectdiff` takes it as `--noise` and says out loud when it was not given one.

### Why save 2 changes six things at once

Every changed value is distinct, so a byte-level diff attributes each delta to exactly one field with
no ambiguity. One field per save would need six saves to learn the same six offsets.

Use values nothing else would produce:

| field | value |
|---|---|
| play count | 37 |
| row length | 999 |
| row tempo | 174.5 — a half-BPM, so a ×120 encoding shows as a non-round number |
| row mute | tracks 2, 3, 5, 7, 11, 13 |
| label | a keyword used nowhere else |
| pattern | a slot used nowhere else in the song |

### Reading the result

```
npm run projectdiff -- presets-0.dn2prj presets-1.dn2prj --noise presets-null.dn2prj
```

It reports changed regions, the tail first and in full, each as an offset from `tailBase` — and
flags the run as **not a clean experiment** if anything outside the tail moved, which means the
instrument was touched somewhere else as well.

### What each save costs

Saving on the device and exporting the project. `CREATE ROWS FROM CHAIN` builds many rows in one
action, which is the cheap way to get a song with real content into save 1.

## 5. Finding the table from a capture

`src/project/imagediff.ts` is pure and does the reading: changed runs, noise subtraction, and
locating an offset in the words the format documents use — `pattern 12`, `kit 3`, `tail +0x2efc`. It
deliberately does **not** dress the tail's interior up as a structure that has not been established.

Two failure modes it is built against, both tested: splitting one changed record into many findings
because a field in the middle kept its value, and **swallowing a real change that merely overlaps a
noise region** — containment counts as noise, overlap does not.

## 6. Sequencing

1. **Captures A and B**, then `docs/dn2-song-format.md` and a read-only `src/project/dn2song.ts`
2. **`SongState` becomes real for the DN2** — the rearrange guard stops being blind, which is a
   safety win independent of any editor
3. **A song viewer in the manager** — show before touch
4. **Editing**, written through the +Drive project path
5. **Row-interior writes last**, and only for fields the captures actually pinned

`deviceproject.ts` says songs are "the one thing this project has always refused to risk". That
posture stays: **decode and display before writing a single song byte**, and anything the captures
did not settle stays unwritten rather than guessed.
