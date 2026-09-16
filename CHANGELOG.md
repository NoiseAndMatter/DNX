# Changelog

What changed, for somebody who used DNX last week and wants to know what is different.

DNX is a page, so it updates the moment a change reaches `main` and nobody is asked to install
anything. That is convenient and it hides things: the same version number can be two different
builds a fortnight apart. Two habits keep it honest.

**The version moves when a user could notice.** A new tool, a chart that reads differently, a
refusal that stops refusing. Documentation, tests, build plumbing and repository tidying do not
move it, because a number that changes for everything tells you nothing about anything. The bump
goes in the pull request that earns it, so the number and the change land together rather than in
some later release commit that has to remember why.

**The commit is what makes a bug report actionable.** Every page footer and every report filed
through the `report` button carries the short commit alongside the version, and that is the part
that names the exact code somebody was running. The version tells you roughly what you have; the
commit tells the author exactly.

Versions are `MAJOR.MINOR.PATCH-beta.N` while this is a beta. It stays `0.x` and stays a beta until
DNX stops refusing things it should eventually do — the loaded project, Digitone II to Digitone 1
presets — because `1.0` would invite a reader to take those refusals for bugs.

## Unreleased

### Fixed

- **Two tables described the eight LFO controls and disagreed about three of them.** Neither could
  have been right: each carried a single word for two independent facts, so `SPD` and `DEP`, which
  are bipolar *and* carry a fine byte, had nowhere to say so, and `FADE` and `MULT` were classified
  by falling through a ternary's default branch. The eight slots are now described once in
  `lfoslots.ts`, measured across 53,248 sound records, and a test recounts them.

- **`inspect` no longer calls an ordinary Digitone II sound file suspect.** Its table of
  product/dump-type combinations listed two while the captures held ten, so reading a perfectly
  normal Sound dump printed *"unconfirmed product/type combination"*. All five dump types are
  confirmed on both instruments, and a test now walks the captures and fails on any combination
  nobody has written down.

## 0.9.0-beta.2 — 2026-09-16

### Added

- **The arpeggiator is counted in Insights.** A track with the arp engaged does not play the notes
  written on its trigs: it plays each of them offset by a per-step table. Pitch content, the pitch
  table and the key fit now count what the instrument actually sounds. 333 tracks across the
  author's own corpus have an arp engaged, and a bass line writing one note per trig was being
  dropped from the key fit entirely.

  The format was read off a Digitone II on stock 1.11: fourteen presets saved from one baseline
  with a single control moved each time. `docs/` records it.

  **Voice pressure deliberately does not use it.** An arp spreads a chord across time rather than
  stacking it, which changes the voice count in a direction that needs the arp's timing, and that
  has never been measured. A fabricated number would be worse than the honest one.

- **A Digitone 1 says what it cannot see.** Its sound object has never been decoded for the arp, so
  its key card says so rather than implying there is no arp to read.

### Changed

- The README opens with the boot screen, and explains how DNX is put together: the layering, what
  each subsystem owns, and why `src/` touches no browser. Every arrow in that diagram is a real
  import path.

### Removed

- `conflicts.txt` and `.gitlab-ci.yml`. The first was grep output left from a documentation pass.
  The second described a deployment that no longer exists and contradicted the one that does, on
  both the Node version and the files it published.

## 0.9.0-beta.1 — 2026-09-16

**The first public build.** DNX had been used against real instruments for weeks before this; this
is the point at which anyone else could.

- **Expander** — give each sound crammed onto a Digitone 1 track its own track on a Digitone II's
  sixteen, carrying the trigs, the locks and the parameter locks.
- **Manager** — move, copy, swap, clear and rename patterns across a project's banks, with undo, and
  drill into a Digitone II pattern's sixteen tracks.
- **Insights** — what a pattern actually plays: polymeter, what the PATTERN RESET costs, trigs
  stored past the end of a track that never sound, voice pressure, pitch content and a key fit. Both
  instruments.
- **Library** — browse the +Drive's 2,048 presets with their tags, rename one on the instrument, and
  drag presets into a project's sound pool.
- **Backup** — every project and soundbank on the +Drive into one `.dnx` file, with a manifest.
- **Probe** — ask an instrument what it is and which messages it answers. It sends only reads.
- **A front page** that runs the boot animation, names the version and the commit, and offers to set
  the DNX folder on a first run.
- **A report button on every tool**, which opens a filled-in GitHub issue and shows you exactly what
  it will say first. DNX posts nothing itself and holds no credential.
- **Notice when another application is on the MIDI port.** Sharing it with Elektron Transfer has
  truncated a directory listing to a third of its length and had one application's traffic read as
  another's answer.
- **Chromium only, said out loud.** Firefox and Safari implement no Web MIDI, so the front page says
  so rather than letting you find out one tool at a time.
