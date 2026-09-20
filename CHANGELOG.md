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

## 0.9.0-beta.5 — 2026-09-20

### Fixed

- **The reset ruler prints a period you can read.** A track's period is its length divided by its
  speed, so a 14-step track at 3/4x is 18⅔ master steps, and the row said *"cut after 8 of
  18.666666666666668"*. Seventeen digits of floating-point noise, next to the "14 steps @3/4x" the
  same row prints, which is the pair of settings the reader is trying to match it to. It now reads
  *"cut after 8 of 18.67"*, two places, the same as every other fractional number on the card.
  Only patterns with a speed other than 1x on some track are affected, because every other period
  is already whole.

### Changed

- **The alignment grid and the prose beside it can no longer give two answers.** Both are asking
  when two track periods come back into phase, and each had its own arithmetic: the grid stopped
  counting at the largest integer a double holds exactly, the prose at the one-million-step limit
  the rest of the analysis uses. They part company only past that limit, which needs tracks of 127
  and 128 steps at 1/8x. No project in the test corpus reaches it, across 425 playing patterns and
  1,467 pairs of periods. Where it happens the grid now shows the limit, which is what the pattern
  summary above it was already saying.

## 0.9.0-beta.4 — 2026-09-20

### Added

- **Every bank tab in the Library now carries its count.** Asked for on Elektronauts. Until now
  only the bank you were looking at had a number on it, because the other seven had never been
  listed and a zero would have been a claim about an instrument nobody had asked. They are listed
  now, in the background, once the bank on screen has finished reading its tags. A count is one
  message a bank, not the 256 reads that knowing what is in it costs, and the numbers are kept for
  the session so switching bank does not ask again. A bank that has not answered yet still shows
  nothing, an empty bank is dimmed and says so, and Refresh takes fresh counts for all of them
  without throwing away a single tag it already read.

- **The Library's tag cloud now shows which tags are still worth pressing.** Also asked for on
  Elektronauts. Choosing KICK dims every tag no remaining preset carries, so the cloud stops
  offering clicks that lead to an empty table, and each number is now how many rows would be left
  if you pressed that chip as well as the ones already chosen. Dimmed tags stay where they are
  rather than disappearing under the pointer, and a chosen tag is always pressable so a filter can
  always be undone. **While a bank is still being read nothing is dimmed at all**, because a tag
  can look unreachable purely because the presets carrying it have not been read yet. The counts
  wear a `+` until that finishes, next to the row count that already says how many slots are still
  to come.

### Fixed

- **DNX reads Digitone 1 projects from OS 1.43, and the ones an updated instrument pads.** 1.43
  makes a project 512 bytes longer, for the Outbox 8's CV configuration, and DNX knew one size for
  a Digitone 1 project, so it refused every project on an updated machine with *"payload declares
  2782212 bytes, format 0104"*. The second problem is the one the message does not describe: a 1.43
  instrument hands over 2,782,212 bytes for **any** stored project, so one last saved on 1.42A
  arrives claiming the newer size with 512 bytes of padding on the end. Projects are converted when
  you load one, not when you update, so on a freshly updated Digitone 1 that is every project on
  the drive. DNX now finds where a project actually ends rather than believing the length it is
  handed, which reads both, and a read that is genuinely cut short is still refused and says so.

  What 1.43 changed inside a project is only where the songs sit and a set of version numbers, so
  patterns, sounds and everything Insights draws read the same on either firmware. The Outbox
  settings are carried through untouched rather than decoded.

  Nothing changes for the Digitone II. Its own 512-byte growth in OS 1.11 has a different shape,
  and whether a pre-1.11 project is padded the same way has not been measured on one.

### Fixed earlier, released here

- **The Probe's Write back and Write to slot now check the WRITE switch themselves.** Until now
  only the greyed button stood between them and the instrument, so a button that failed to grey
  out would have written with WRITE off. Both now refuse in code before the slot is even read, and
  say that nothing was sent. With WRITE armed they behave exactly as before.

### Changed

- **The backup now says why the instrument's global settings are missing, not just that they are.**
  MIDI configuration, sync, audio routing and brightness live in the machine rather than in a
  project, and **two independent routes both fail to reach them**: the +Drive root holds only
  projects, soundbanks and kits, and Elektron's SysEx SEND menu offers only PROJECT, PATTERN and
  PRESETS. Restore onto a replacement unit and those stay at whatever the target already had. The
  limit is the instrument's, not DNX's, and the README now says so.

## 0.9.0-beta.3 — 2026-09-16

### Fixed

- **A backup now says what it could not read.** DNX asks the instrument what is on its +Drive
  rather than assuming from the model, which is right — but it only knows how to read projects,
  soundbanks and kits, so a firmware adding a fourth directory would have been discovered and then
  passed over in silence. The run would report success while being incomplete, and the omission
  would surface at restore time. Any directory DNX cannot read is now named on screen and recorded
  in the manifest. Empty for every instrument that exists today, which is the point.

- **The README no longer says DNX backs up the whole instrument.** It copies the **+Drive**.
  Settings that live outside it, like LED brightness or MIDI port configuration, are not reachable
  over this protocol and are not in a backup.

### Fixed earlier, released here

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
