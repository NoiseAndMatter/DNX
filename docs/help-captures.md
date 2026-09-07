# Help-page screenshot capture manifest

The in-app help pages in `web/src/helppages.ts` reference the PNGs listed below. Help is
**sectioned**: each page is a list of `{ heading, body, image? }` sections, and each imaged section
renders its screenshot beside its body in two columns. **One PNG per section or concept.** All PNGs
are served from `web/help/`.

Until a PNG is on disk, its slot renders a labelled placeholder carrying the section's `alt` text.
That is harmless and deliberate: **sections are written before the shots are taken**, so a page
half-captured reads as in progress rather than broken.

## Capture status, 2026-09-07

**21 of the 21 referenced PNGs exist.** 9 pages, 31 sections, 21 screenshot slots. Counted from the
source rather than adjusted: every `image.src` across `HELP_PAGES` enumerated against `web/help/`.

The two Library shots came last, because both are the instrument's +Drive pane and it holds nothing
until a **Digitone II** answers. They were taken against `/soundbanks/A`, 256 slots read.

`test/helppages.test.ts` fails when a referenced file has no row here, so this table cannot fall
behind the pages.

## How to capture

Serve the app with `npm run web` and capture against **http://127.0.0.1:8173**.

- **Dark theme.** It is the only theme, and every capture must match.
- **Crop tight to the panel the section describes.** The two-column help renders each image at
  roughly 40% of the content column, so a full-window screenshot arrives unreadable.
- **Target ~1200px wide** before cropping.
- **Open the factory presets, not a personal project.** `017 PRESETS.dn2prj` is content every owner
  already has, so a screenshot of it publishes nobody's music. It also has what the Insights shots
  need: A3 holds dormant trigs on two tracks, and **B2 · SAL-GÖTÜ** is the one pattern in the file
  whose RESET cuts a track mid-figure (22 against 64, 9% reachable). An empty grid teaches nothing.
- **Connect an instrument** for the probe, +Drive and backup shots. Those states cannot be faked and
  a mocked one would be a lie with a picture attached.

### Captures run at the end of a cycle, never mid-flight

A capture taken while code is landing, a server is restarting or a device is mid-read shows an error
or an empty state and **ships it silently**. So: finish and verify the feature, then capture as the
closing step. Re-open any suspect image before committing it.

## The slots

| file | page | section | status |
|---|---|---|---|
| `overview-toolrow.png` | Overview | Four tools, always in the same order | captured |
| `expander-in.png` | Expander | Pick a source and a destination | captured |
| `expander-options.png` | Expander | Choosing what to expand | captured |
| `manager-grid.png` | Manager | The grid | captured |
| `manager-operations.png` | Manager | Move, copy, swap, rename, clear | captured |
| `manager-drive.png` | Manager | Opening from an instrument | captured |
| `manager-song.png` | Manager | Songs | captured |
| `insights-cycle.png` | Insights | How long a pattern really takes | captured |
| `insights-reset.png` | Insights | What the reset interrupts | captured |
| `insights-dormant.png` | Insights | Trigs the sequencer never reaches | captured |
| `insights-pitch.png` | Insights | Voices, pitch and key | captured |
| `insights-compare.png` | Insights | Comparing patterns | captured |
| `library-two-panes.png` | Library | Why both are on one page | captured |
| `library-search.png` | Library | Finding a preset | captured |
| `probe-connect.png` | Probe | Finding an instrument | captured |
| `probe-request.png` | Probe | Asking for one object | captured |
| `probe-drive.png` | Probe | The +Drive | captured |
| `safeguards-write-armed.png` | Safeguards | Nothing is written until you arm it | captured |
| `safeguards-confirm.png` | Safeguards | What a confirmation tells you | captured |
| `backup-progress.png` | Backup | What it reads | captured |
| `settings-sheet.png` | Settings | What is in it | captured |

## How the crops were taken

Chrome's element screenshot crops to one node, and the node has to be addressable. So:

1. Put `role="region"` and `aria-label="capture"` on the element wanted. It then appears in the
   accessibility snapshot with a uid, and a screenshot of that uid is the crop.
2. **Do not clone the element.** A clone loses a canvas's bitmap and every listener on it, so a
   cloned Insights card renders its charts blank.
3. A panel taller than the viewport needs its sticky heading set to `position: static` first, or the
   heading is clipped out of the top of its own picture.
4. Hide `#tip` before shooting. A tooltip left over from the last mouse position lands in the image
   and reads as part of the UI.

A `?` marker in shot is wanted, not a mistake: it is how a reader finds their way back to the page
they are looking at.

### A control shot is worth more doing something than sitting still

`library-search.png` was first taken with no instrument connected, by unhiding the filter row the
page keeps `hidden` until one is. It was honest and it taught nothing: an empty search box and an
unticked switch look the same whether or not the feature works.

Retaken against a connected instrument it carries `pad` in the box, **90 of 256** in the heading,
the tag chips re-counted against the match, and the presets that matched. Same control, and now a
reader can see what pressing it does.

**Wait for the hardware rather than photograph the empty state.** A placeholder that says a shot is
pending costs a reader nothing; a picture of an empty box costs them the belief that the page works.

## Sections with no screenshot, on purpose

Eleven of the 31 sections carry no image. A section explaining a rule rather than a surface does not
need one, and an invented picture is worse than none: *Nothing leaves this machine*, *What DNX will
not do*, *Apply, then export or write*, *What it writes*, *Writing*, *Every write backs up first*,
*If something goes wrong*, *A .dnx is a zip*, *What manifest.json is for*, and *Why the write switch
is not in here*.

**Add a section rather than a sentence** when a new concept arrives, so it gets its own slot instead
of being folded into a paragraph belonging to a picture of something else.
