# Help-page screenshot capture manifest

The in-app help pages in `web/src/helppages.ts` reference the PNGs listed below. Help is
**sectioned**: each page is a list of `{ heading, body, image? }` sections, and each imaged section
renders its screenshot beside its body in two columns. **One PNG per section or concept.** All PNGs
are served from `web/help/`.

Until a PNG is on disk, its slot renders a labelled placeholder carrying the section's `alt` text.
That is harmless and deliberate: **sections are written before the shots are taken**, so a page
half-captured reads as in progress rather than broken.

## Capture status, 2026-09-07

**0 of the 21 referenced PNGs exist.** 9 pages, 31 sections, 21 screenshot slots. Counted from the
source rather than adjusted: every `image.src` across `HELP_PAGES` enumerated against `web/help/`.

`test/helppages.test.ts` fails when a referenced file has no row here, so this table cannot fall
behind the pages.

## How to capture

Serve the app with `npm run web` and capture against **http://127.0.0.1:8173**.

- **Dark theme.** It is the only theme, and every capture must match.
- **Crop tight to the panel the section describes.** The two-column help renders each image at
  roughly 40% of the content column, so a full-window screenshot arrives unreadable.
- **Target ~1200px wide** before cropping.
- **Open a real project first.** `00_Examples/02_DN2/01_Projects/MORNING_JAM.dn2prj` has per-track
  lengths, a reset that cuts, and dormant trigs, so the Insights shots have something to show. An
  empty grid teaches nothing.
- **Connect an instrument** for the probe, +Drive and backup shots. Those states cannot be faked and
  a mocked one would be a lie with a picture attached.

### Captures run at the end of a cycle, never mid-flight

A capture taken while code is landing, a server is restarting or a device is mid-read shows an error
or an empty state and **ships it silently**. So: finish and verify the feature, then capture as the
closing step. Re-open any suspect image before committing it.

## The slots

| file | page | section | status |
|---|---|---|---|
| `overview-toolrow.png` | Overview | Four tools, always in the same order | to capture |
| `expander-in.png` | Expander | Pick a source and a destination | to capture |
| `expander-options.png` | Expander | Choosing what to expand | to capture |
| `manager-grid.png` | Manager | The grid | to capture |
| `manager-operations.png` | Manager | Move, copy, swap, rename, clear | to capture |
| `manager-drive.png` | Manager | Opening from an instrument | to capture |
| `manager-song.png` | Manager | Songs | to capture |
| `insights-cycle.png` | Insights | How long a pattern really takes | to capture |
| `insights-reset.png` | Insights | What the reset interrupts | to capture |
| `insights-dormant.png` | Insights | Trigs the sequencer never reaches | to capture |
| `insights-pitch.png` | Insights | Voices, pitch and key | to capture |
| `insights-compare.png` | Insights | Comparing patterns | to capture |
| `library-two-panes.png` | Library | Why both are on one page | to capture |
| `library-search.png` | Library | Finding a preset | to capture |
| `probe-connect.png` | Probe | Finding an instrument | to capture |
| `probe-request.png` | Probe | Asking for one object | to capture |
| `probe-drive.png` | Probe | The +Drive | to capture |
| `safeguards-write-armed.png` | Safeguards | Nothing is written until you arm it | to capture |
| `safeguards-confirm.png` | Safeguards | What a confirmation tells you | to capture |
| `backup-progress.png` | Backup | What it reads | to capture |
| `settings-sheet.png` | Settings | What is in it | to capture |

## Sections with no screenshot, on purpose

Eleven of the 31 sections carry no image. A section explaining a rule rather than a surface does not
need one, and an invented picture is worse than none: *Nothing leaves this machine*, *What DNX will
not do*, *Apply, then export or write*, *What it writes*, *Writing*, *Every write backs up first*,
*If something goes wrong*, *A .dnx is a zip*, *What manifest.json is for*, and *Why the write switch
is not in here*.

**Add a section rather than a sentence** when a new concept arrives, so it gets its own slot instead
of being folded into a paragraph belonging to a picture of something else.
