/**
 * In-app help, one page per view.
 *
 * ## The shape, and where it comes from
 *
 * This follows the contract CommentLab sets for its own documentation, because that is a working
 * example of help that stayed accurate through a year of changes rather than a style anyone
 * invented here:
 *
 * - **Help is per page, not one general page.** One entry per view, so a change to a view has an
 *   obvious place to land.
 * - **A page is a list of sections**, each with a heading, a markdown body, and an optional
 *   screenshot rendered beside it. Two columns on a wide window, stacked on a narrow one.
 * - **One screenshot per section or concept.** A new concept gets its own section so it gets its
 *   own slot, rather than being folded into a paragraph of one that already has a picture.
 * - **Every `src` here must have a row in `docs/help-captures.md`**, which says which shots exist
 *   and which are outstanding. A missing file renders its `alt` as a labelled placeholder, so a
 *   page half-captured reads as deliberate rather than broken.
 *
 * The rule that makes it stay true: **when a view, feature or number changes, its page changes in
 * the same branch.** A help page written afterwards is written from memory.
 *
 * ## Screenshots are captured at the end, never mid-flight
 *
 * A capture taken while the code is moving shows an error or an empty state and ships it silently.
 * So the sections are written first, the slots stay empty, and the shots are taken once the thing
 * they show is finished and working.
 *
 * ## What the writing is for
 *
 * A musician reading this wants to know what a control does to their music and what it cannot undo.
 * The case for a feature existing belongs in the module that implements it. Nothing here explains
 * why DNX was built.
 */

export interface HelpImage {
  /** Root-relative, e.g. `help/manager-grid.png`. Served from `web/help/`. */
  src: string;
  alt: string;
}

export interface HelpSection {
  /**
   * A stable name a `?` in the interface can point at.
   *
   * **Explicit, never derived from the heading.** A slug would break silently the first time
   * somebody improved a heading's wording, which is exactly the class of rot
   * `test/docstatus.test.ts` exists for. `test/helppages.test.ts` checks that every `data-help` in
   * the markup names one of these and that every id here is pointed at by something.
   *
   * Optional: a section nothing links to needs no id.
   */
  id?: string;
  heading: string;
  /** Markdown, rendered by `mdToHtml`. Soft-wrapped lines are folded. */
  body: string;
  /** Shown beside the body on a wide window. Absent is fine and common. */
  image?: HelpImage;
}

export interface HelpPage {
  key: string;
  title: string;
  /** A short lead above the sections. Markdown. */
  intro?: string;
  sections: HelpSection[];
}

export const HELP_PAGES: readonly HelpPage[] = [
  {
    key: "overview",
    title: "Overview",
    intro: `DNX reads, edits and writes Elektron **Digitone** and **Digitone II** projects, and talks
to the instruments over MIDI. It runs entirely in this browser.`,
    sections: [
      {
        heading: "Nothing leaves this machine",
        body: `Every project you open is read, edited and written **in the browser**. No file is
uploaded, there is no server, and DNX keeps nothing after you close the tab.

That is also why it works with no network at all. Load the page once and it will keep working on a
plane, in a studio with no wifi, and in ten years when whoever is hosting it has stopped.`,
      },
      {
        heading: "The tools, always in the same order",
        body: `The row at the top never reorders, so each tool keeps a permanent screen position. The
probe is hidden until you turn off **Settings → Hide the probe**; it is the last position, so hiding it
moves nothing else.

| tool | what it is for |
|---|---|
| **expander** | take a Digitone 1 project and spread its sounds across the Digitone II's 16 tracks |
| **manager** | move patterns between slots, banks and projects, and analyse what a pattern plays |
| **library** | move presets between a project's sound pool and the instrument's +Drive library |
| **probe** | ask an instrument questions when something is wrong |

\`Ctrl\`+\`Alt\`+\`←\` and \`→\` move between them. On a Spanish, German or UK-extended keyboard
\`Ctrl\`+\`Alt\` is AltGr, so the digit shortcuts are ignored while you are typing in a field.`,
        image: { src: "help/overview-toolrow.png", alt: "The DNX tool row: expander, manager, library, probe, the write switch, settings and source" },
      },
      {
        heading: "The front page, and which version you are running",
        body: `Opening DNX shows a front page: the tools, what DNX is, and **the version in the
identity line under the animation** — something like **v0.9.0-beta.1 · 11f8a9c**. The second half is
the commit it was built from. **Quote both when reporting anything**: DNX is served as a web page
with no release cadence, so two people on the same version can be a fortnight apart.

- **The first time you ever open it**, the animation runs longer and the page offers to set your
  DNX folder. Afterwards it is shorter and only reminds you where files go.
- **Settings → Skip the boot screen** goes straight to the tools instead.
- **The DNX wordmark, top left, comes back here** from any tool.

DNX needs a **Chromium browser** — Chrome, Edge, Brave, Arc. Firefox and Safari have no Web MIDI,
so they cannot see an instrument at all, and the front page says so rather than letting you find
out one tool at a time.`,
      },
      {
        heading: "A Digitone and a Digitone II",
        body: `DNX works with both, and not every tool does the same on each.

| | Digitone | Digitone II |
|---|---|---|
| **Expander** | the source: a file, the connected instrument, or its +Drive | the destination: blank, a file, its +Drive, or the loaded project |
| **Manager:** open a project file, open from the +Drive, save to it | yes | yes |
| **Manager:** move, copy, swap, clear and rename patterns | yes | yes, except patterns in a storage version DNX reads but does not edit |
| **Manager:** Open device, reading the loaded project | no: use Browse +Drive | yes |
| **Manager:** a pattern's 16 tracks | no | yes |
| **Manager:** songs | no | yes |
| **Manager:** Insights | yes | yes |
| **Library:** browse presets, search, tags, rename | yes | yes |
| **Library:** machine column | no: one FM engine | yes |
| **Library:** kits | no: none on its +Drive | yes |
| **Library:** pool audit, and dropping presets into a pool | the project must be a Digitone II; Digitone presets are converted as they go in | yes |
| **Backup** | projects and sounds | projects, sounds and kits |
| **Probe** | yes | yes |

With both instruments connected, the manager, the library and the backup ask which one to use.

One difference inside Insights: a Digitone II pattern carries a **RESET** and a **CHANGE** setting
and a Digitone 1's does not, or not anywhere DNX has found. Those two tiles read **?** rather than
repeating the Digitone II's answer.`,
      },
      {
        heading: "What DNX will not do",
        body: `- It will not write to an instrument until you turn **WRITE** on. See *Safeguards*.
- It will not write anything without first reading the destination back and saving a copy.
- It will not open a Digitone II pattern whose storage version it does not read, rather than showing
  you numbers measured from the wrong bytes.`,
      },
    ],
  },

  {
    key: "expander",
    title: "Expander",
    intro: `A Digitone 1 has four tracks. Producers reach past that by **sound-locking individual
trigs**, so one track plays several instruments. The expander undoes that crowding: it gives each
sound its own track on the Digitone II's sixteen.`,
    sections: [
      {
        id: "expander-io",
        heading: "Pick a source and a destination",
        body: `**Source** is the Digitone 1 project being expanded — from a file, from a connected
instrument, or from an instrument's +Drive.

**Destination** is the Digitone II project it lands in. *Blank* starts from an empty project; *From
file* and *Connect a Digitone II* put the expansion into a project you already have, so the rest of
that project survives.`,
        image: { src: "help/expander-in.png", alt: "The IN row: source and destination pickers, each offering a file, a connected instrument, or its +Drive" },
      },
      {
        id: "expander-options",
        heading: "Choosing what to expand",
        body: `**Selected patterns** expands the ones you pick. **Whole project** takes all of them.

Then five options change how sounds are laid out:

| option | what it does |
|---|---|
| **Contiguous** | fill tracks from the first free one rather than leaving gaps |
| **Compact** | allocate per pattern, so two patterns can reuse a track for different sounds |
| **Freed MIDI** | use the MIDI tracks a DN1 project was not using |
| **Aggregate by name** | sounds sharing a name share a track |
| **Percussion low** | put percussion on the lower tracks |

**Rules** shows what the planner decided and why, before anything is applied.`,
        image: { src: "help/expander-options.png", alt: "The expansion options row with Selected patterns, Whole project and the five layout switches" },
      },
      {
        id: "expander-out",
        heading: "Apply, then export or write",
        body: `**Apply** plans and performs the expansion into the destination held in this page.
Nothing has been saved anywhere yet, and **Undo** reverses it.

**Export .dn2prj** writes a project file to your downloads. **Write to instrument** sends it to a
connected Digitone II, which needs **WRITE** to be on.`,
      },
    ],
  },

  {
    key: "manager",
    title: "Manager",
    intro: `Move patterns between slots, banks and projects, carrying the sounds they depend on.
Open a project from a file, from an instrument, or from an instrument's +Drive.`,
    sections: [
      {
        id: "grid",
        heading: "The grid",
        body: `Each slot shows its bank letter and number, the pattern's name, and what is in it —
trig and lock counts, or *empty*.

Click a slot to select it. **Shift**-click extends a range, **Ctrl**-click adds one. Selection
survives switching banks, so A1 and B1 can be selected together.

A slot marked *storage version we do not read* holds a pattern written by a firmware whose layout
DNX does not know. It is shown rather than hidden, and it is not edited.`,
        image: { src: "help/manager-grid.png", alt: "The pattern grid showing a bank of sixteen slots with names and trig counts" },
      },
      {
        id: "operations",
        heading: "Move, copy, swap, rename, clear",
        body: `The operations act on the selection.

- **Move** empties the source. **Copy** does not.
- **Swap** exchanges two slots.
- **Rename** changes a pattern's name.
- **Clear** blanks a slot.

**Sound locks are carried.** A lock points at a numbered slot in the project's sound pool, so a
pattern copied into another project would otherwise play the wrong instrument. DNX remaps the
indices as part of the copy.

Every operation is a plan first. Nothing touches an instrument, and **Undo** and **Redo** cover the
whole session.`,
        image: { src: "help/manager-operations.png", alt: "The Operations panel with Move, Copy, Swap, Rename and Clear, and the current selection listed beside it" },
      },
      {
        id: "open-device",
        heading: "Opening from an instrument",
        body: `**Open device…** reads the project currently loaded on the instrument.

**Browse +Drive…** lists the 128 project slots and opens one of them. That is **read-only**: a write
goes to the instrument's *active* project, so edits made to slot 47 would land somewhere else. Use
*Export* to get a file, or *Save to +Drive…* to write back to a slot deliberately.`,
        image: { src: "help/manager-drive.png", alt: "The +Drive project picker listing slots by number and name" },
      },
      {
        id: "open-backup",
        heading: "Opening a project out of a backup",
        body: `**Open a backup…** reads a \`.dnx\` and shows what is inside it: the instrument it came
off, when it was taken, and every project, sound and kit in it. Pick a project and it opens here
like any other, with the grid, undo and *Export* working on it as usual.

**Nothing is written to an instrument by opening a backup.** The file is read in the browser and
what comes out of it is an ordinary project.

Sounds and kits are counted and named but cannot be placed yet — a backup of a Digitone II holds
around 1,835 sounds, and listing them to choose one project would bury it.

If part of the backup is damaged, the missing entries are **named at the top and the rest still
opens**. A backup that lost one slot is still worth the other 1,868.`,
        image: { src: "help/backup-picker.png", alt: "The contents of a backup: the instrument and date it was taken, its projects listed by slot, and its sounds and kits counted" },
      },
      {
        id: "songs",
        heading: "Songs",
        body: `The song panel shows the 16 arrangements a project holds and the rows in each. A
pattern moved by an operation has its song references repaired, so an arrangement still plays what
it did.`,
        image: { src: "help/manager-song.png", alt: "The song panel showing the sixteen song slots and the rows of the selected one" },
      },
    ],
  },

  {
    key: "insights",
    title: "Insights",
    intro: `**Insights** analyses what a pattern actually plays. Select one or more patterns in the
grid and press *Insights*. Selecting more than one compares them.

It reads both instruments. A Digitone 1 pattern has four synth tracks and four MIDI tracks named
**A** to **D**, eight voices rather than sixteen, and 64 steps rather than 128, and Insights draws
it on those terms. The only thing it cannot tell you about a Digitone 1 is whether the pattern
resets: that setting has not been found in its file, so those tiles read **?** instead of guessing.`,
    sections: [
      {
        id: "cycle",
        heading: "How long a pattern really takes",
        body: `Tracks can have their own lengths and their own speeds, so a pattern does not
necessarily repeat when its longest track does.

- **Polymeter** is when the track lengths alone would come round.
- **Repeats every** is what you actually hear, because **PATTERN RESET** pulls every track back to
  step one whether or not it has finished.

A pattern with tracks of 12, 16 and 64 steps comes round after 192 — and if RESET is 64 it never
gets there.`,
        image: { src: "help/insights-cycle.png", alt: "The play time and cycle card, with tempo, window, repeat length and tracks in play" },
      },
      {
        id: "reset",
        heading: "What the reset interrupts",
        body: `A track whose length does not divide the reset is cut mid-figure, in the same place
every time round. It is audible as a part that goes wrong on every repeat, and invisible on the
instrument, which shows lengths and the reset on different screens and never their remainder.

**A cut only matters if something was going to play in it.** A cut that loses no trigs is drawn as a
dashed outline; one that drops notes is filled and counted.`,
        image: { src: "help/insights-reset.png", alt: "The reset ruler showing each track's complete passes and where the reset interrupts it" },
      },
      {
        id: "dormant",
        heading: "Trigs the sequencer never reaches",
        body: `Shortening a track keeps whatever was written on the pages it drops. A 16-step track
can hold notes on steps 33 to 45 that are in the file and silent until you lengthen it again.

Insights names them, the steps they sit on, and the **LEN** that would bring each track's back. The
instrument cannot show you this: LEN is on one screen and the trig pages on another, and a page past
the last one looks unlit whether it is empty or out of reach.

Everything else on the page counts only the trigs that sound.`,
        image: { src: "help/insights-dormant.png", alt: "The card naming tracks that hold trigs past their own length, with the steps and the LEN that reaches them" },
      },
      {
        id: "pitch",
        heading: "Voices, pitch and key",
        body: `A Digitone II sounds **16 voices** at once, and a chord trig spends one per note. The
voice chart shows where a pattern asks for more than it has.

The key readings are a **fit**, not a declaration: they say which key the notes are most consistent
with over a window, and they change as the pattern moves.`,
        image: { src: "help/insights-pitch.png", alt: "The pitch content card with the per-track pitch bars and the key timeline" },
      },
      {
        id: "compare",
        heading: "Comparing patterns",
        body: `Select several patterns and the page opens with a comparison: whether they share a
tempo, which has the shortest cycle, which lose notes to their reset, and a bar for each showing how
long it runs before repeating.

**The bars are steps, and the clock times beside them are not comparable** when the tempos differ.
The page says so when that happens rather than leaving you to check the column.`,
        image: { src: "help/insights-compare.png", alt: "The comparison card with one bar per selected pattern and a caret marking the one analysed below" },
      },
    ],
  },

  {
    key: "library",
    title: "Library",
    intro: `A project's **sound pool** beside the instrument's **+Drive library**. The pool is where
a preset has to be for a trig to preset-lock it; the library is where 2,048 of them live.

The tabs above the left pane switch between **Sounds** and **Wavetables**. The wavetable sections
are at the end of this page.`,
    sections: [
      {
        id: "pool-vs-library",
        heading: "Why both are on one page",
        body: `Elektron's manual is blunt about the difference: *"the primary benefit of presets
loaded to the pool is the possibility for them to be preset locked. This feature is not available
for the presets in the +Drive library."*

So every operation anyone wants here crosses that line — add a preset to the pool, keep one back,
load a kit into a pattern. A tool showing one side could describe the work but never do it.`,
        image: { src: "help/library-two-panes.png", alt: "The library: a project's sound pool on one side and the instrument's +Drive library on the other" },
      },
      {
        heading: "What it writes",
        body: `Dragging a preset from the library into the pool **edits the project held in this
page**. The instrument is not written to, and the file on disk is untouched until you press
**Export project**. A mistake costs a reload, not a recording.

**Rename… is the exception**: it changes a preset on the instrument itself.`,
      },
      {
        heading: "A Digitone or a Digitone II",
        body: `**Connect an instrument…** works with either. With two connected, a list appears: choose
one and press it again.

- **A Digitone has no kits on its +Drive**, so only its presets can be browsed.
- **Its presets show tags and no machine.** A Digitone has one FM engine, and the byte a Digitone II
  uses for the machine is a sound setting on a Digitone.
- Renaming works the same way on both.
- The pool on the left reads Digitone II projects only, and presets travel one way: see below.`,
      },
      {
        heading: "Presets travel one way",
        body: `A **Digitone 1 preset goes into a Digitone II project**, converted as it is dropped
into the pool. **Nothing goes the other way**, and that is a fact about the two instruments rather
than a feature nobody has written yet.

- **Only FM TONE has an equivalent.** A Digitone has one FM engine. A Digitone II preset using
  WAVETONE, FM DRUM or SWARMER is not a Digitone sound in any form, so there is nothing to convert.
- **The third LFO would be lost.** A Digitone II has three LFOs and a Digitone has two. Even an
  FM TONE preset carries settings the Digitone has no field for.
- **And more than that would be lost.** Of the 302 bytes in a Digitone sound, 226 have a known
  source in the Digitone II's 359 and 53 more never vary and could be filled in — but **23 carry
  real settings that a Digitone II preset does not contain**. A converted preset would be a guess
  at those, and DNX does not guess at a sound.

So the library opens **Digitone II projects** for pool work, and refuses a Digitone 1 project with
this reason. A Digitone's presets can still be browsed, tagged, searched and renamed.`,
      },
      {
        heading: "Renaming a preset",
        body: `Browse a preset bank, click a preset, and press **Rename…**. It needs **WRITE** to be on.

- Up to 16 characters. The instrument has no lowercase, so lower case is stored upper.
- **Factory presets cannot be renamed.** The instrument marks them write-protected. Save a copy to a
  free slot on the instrument and rename that.
- Before anything is sent you are asked again, and the preset as it is now is saved to the DNX
  folder's *Copies before writing*, or to your downloads: a **.dn2snd** file from a Digitone II, a
  **.dnsnd** from a Digitone.
- After the write, DNX reads the slot back and compares it with what was sent, then lists the bank
  again so the new name comes from the instrument itself.`,
      },
      {
        id: "library-search",
        heading: "Finding a preset",
        body: `**Search** filters by name. **Occupied only** hides empty slots, which is most of a
library most of the time. **Refresh** re-reads the instrument.`,
        image: { src: "help/library-search.png", alt: "A search narrowing a bank to 90 of its 256 slots, the tag chips re-counted against the match, and the presets that matched" },
      },
      {
        id: "wavetable-modes",
        heading: "The Wavetables mode",
        body: `See which wavetables a project can play, and which slots on the instrument they come
from.

Before you start:

- A Digitone II whose firmware carries the wavetable store.
- **WRITE** can stay off. This mode only reads.

1. Press **Connect an instrument…**.
2. Press **Wavetables**, above the left pane.
3. Pick a project from **POOL OF**.

The left pane is that project's **wavetable pool**: 128 slots, each naming a store slot. The right
pane is the instrument's **wavetable store**: 256 slots, one table each, shared by every project.

A sound's **TBL** setting picks a pool slot, and that pool slot names a store slot. A sound never
points at the store directly.`,
        image: { src: "help/wavetables-pane.png", alt: "The Wavetables mode: a project's 128-slot wavetable pool on the left, the instrument's 256-slot store on the right, and store rows saying which pool slot each table is in" },
      },
      {
        heading: "Store slot, pool slot, and the number in a sound",
        body: `Set **TBL** on a sound to the pool slot you want. It is the same number.

Every table has two numbers:

- **Store slot, 0 to 255.** Where the table sits on the instrument, shared by every project.
- **Pool slot, 1 to 128.** Where it sits in this project's pool, and what you set **TBL** to.

The sound's **TBL** cell reads **T:002** for pool slot 2. Turning it below **T:001** gives the
instrument's two built-in waveforms, **PRIM** and **HARM**.

One table can be store slot 9 and pool slot 2, and the same table can be a different pool slot in
another project. Every cell shows its store slot and its pool slot.`,
      },
      {
        heading: "Seeing what a table looks like",
        body: `Click a row in the **+Drive wavetables** pane to draw that table.

A name does not tell you whether a table is bright or hollow, and two can share one. The preview
under the store draws **every frame of the table at once**, stacked front to back, so the shape is
there to read.

1. Click any occupied row in the right pane.
2. Drag **Position** to pick one frame out of the stack.

The frame you pick is drawn bright, with a dashed line under it; the rest stay dim. **Position**
is the same number a sound's **WT.POS** sets, so frame 24 of 64 is what you hear at a position of
0.365.

- Reading one table costs one read from the instrument. Picking it again afterwards is free.
- **Refresh** forgets every table it has read.
- **Play** sounds the frame you picked, and **Sweep** travels the whole table. Both are
  synthesised here, so nothing reaches the instrument and the sequencer does not move.
- Nothing in this pane changes the instrument, and **Position** moves only the drawing.`,
        image: { src: "help/wavetables-preview.png", alt: "The wavetable preview: every frame of a 64-frame table stacked front to back, the picked frame drawn bright with a dashed line under it, and the Position and Volume sliders under it reading frame 24 of 64 at 0.365" },
      },
      {
        id: "wavetable-import",
        heading: "Putting a wavetable on the instrument",
        body: `Drop audio files onto the store, check them, and write them in one go.

Before you start:

- A Digitone II whose firmware carries the wavetable store.
- **WRITE** on, in the tool row.
- Elektron Transfer and Overbridge closed.

1. Press **Wavetables**, then pick a project from **POOL OF**.
2. Drag audio files from your computer onto a free slot in the **+Drive wavetables** list.
3. The slots turn amber and read **staged**. Nothing has been sent.
4. Click a staged row. Set **name**, **waves** and **points**, and press **Play** to hear it, or
   **Sweep** to hear it travel from the first frame to the last.
5. Press **Write staged tables**. One question names every slot it is about to write.

To put a staged table somewhere else, drag its row onto another free slot. **Remove** takes one off
the list, **Discard all** clears it, and leaving the mode discards everything staged.

A **WAV** file is read exactly as it is. Any other format is handed to the browser, which may change
the number of samples it has, and the panel says when that happened.`,
        image: { src: "help/wavetables-import.png", alt: "Three audio files staged on free store slots, marked amber and reading staged, with the panel below showing the name, the waves and points, and the Play and Write staged tables buttons" },
      },
      {
        id: "wavetable-add-to-pool",
        heading: "Making a table playable: put it in the pool",
        body: `A table in the store makes no sound until a project's pool points at it. The pool
slot is the number a sound asks for, so you choose which slot it goes in.

Before you start:

- A table in the **+Drive wavetables** list.
- **WRITE** on, in the tool row.

1. Press **Wavetables**, then pick the project from **POOL OF**.
2. Click the table in the **+Drive wavetables** list on the right. **Shift-click** another to take
   the whole run between them; **Ctrl-click** (**Cmd** on a Mac) adds or removes one.
3. **Drag them onto the pool slot** you want the first one in. The rest follow in the slots after
   it, and the slot you are over says how many are landing and what they replace.
4. One question names every table, every slot, and what each slot holds now.

Rather not drag? Click a pool slot and press **Add to pool** instead, which does the same thing.
With no pool slot picked it uses the first free one.

On the instrument, set the sound's **TBL** to the pool slot number: for pool slot 5 the cell reads
**T:005**. Below **T:001** are the two built-in waveforms, **PRIM** and **HARM**.

The pool being replaced is saved to your computer as a file before anything is sent. That copy is
the only undo there is.

**If the project had no pool of its own**, the question says so before you answer it. Writing one
fixes the tables it plays today at the slots they are in now, and from then on a table written into
the store does not join that project until you add it.

The store is shared by every project; a pool is one project's own. So the same table can sit at
pool slot 3 of one project and pool slot 40 of another, and adding it to one changes nothing
anywhere else.`,
      },
      {
        id: "wavetable-shape",
        heading: "Choosing the shape of a table",
        body: `**waves** is how many frames the table holds. **points** is how long each frame is.

DNX reads how long the file is and proposes a shape. The panel says whether the length divided
exactly or whether the file has to be stretched to fit.

- **It divided exactly.** The file is very likely already that shape.
- **Several shapes divide most files**, so the proposal is a convention rather than a measurement.
  Change the numbers when you know better.
- **A shape this instrument does not play** is still written and still listed, and it makes no
  sound. The panel says so before you write, not after.

Every import is made as loud as it can be. The instrument does not undo that, so two tables made
from differently recorded files come out equally loud.`,
      },
      {
        id: "wavetable-pool-kinds",
        heading: "The three kinds of pool",
        body: `The line under the pool says which kind it is.

- **No pool of its own.** Nobody has written one, so the project plays **no** wavetables. Every
  sound set to a **TBL** number plays the built-in **PRIM** until you put tables in the pool.
- **Follows the store.** The project plays every stored table in store-slot order, and picks up
  new ones as they arrive.
- **A list.** Somebody chose these slots, on the instrument or in DNX.

**A list is what you want for a project you are building.** The pool slot is the number a sound
reaches, so putting each table where you want it to answer from is the point of keeping one.

When a project **follows the store** the order is the store's, so a table written into a free slot
below the others moves every later pool slot along by one. Sounds keep their **TBL** numbers and
play whatever moved into them. That is the behaviour to expect rather than a fault, and a list of
its own is how a project stops depending on it.

**A project made before the wavetable firmware has no pool of its own**, so it plays nothing until
you add tables to it. Older firmware answered differently — it gave such a project every stored
table — so if your pool looks full of tables you did not choose, that instrument has not been
updated yet.`,
      },
      {
        heading: "When a cell says MISSING",
        body: `**MISSING** means the pool names a store slot that is empty. The table was deleted
and the entry still points at it, so a sound set to that pool slot plays a built-in waveform.

To fix it:

1. Press **Refresh**. It re-reads the pool and the store together.
2. Click the cell and press **Remove from pool** to empty it, or put a table in it with
   **Add to pool**, or set the sound to a different pool slot.

DNX never clears one by itself, and adding a table skips a MISSING entry and fills the first truly
empty one. That is on purpose: an entry emptied without you asking would be a hole the next table
drops into, and the sound pointing at it would start playing something unrelated.

**Leaving one is riskier than it looks.** If you later write a different table into that store
slot, the entry starts naming the new table — in every project, with nothing on screen having
changed. Removing it is the way to avoid that.`,
        image: { src: "help/wavetables-missing.png", alt: "A pool cell naming a store slot that is empty, reading MISSING, with a note saying the table was deleted and the slot now plays the built-in waveform" },
      },
      {
        id: "wavetable-remove",
        heading: "Taking a table out of a pool, and deleting one",
        body: `Two different removals. One changes a project's list; the other takes the table off
the instrument for every project.

Before you start:

- **WRITE** on, in the tool row.

**To take a table out of this project's pool:** click the pool slot on the left, then press
**Remove from pool**.

The table stays in the store and every other project keeps it. The slot becomes empty, and any
sound whose **TBL** reads that number plays the built-in **PRIM** from then on. Nothing renumbers:
the slots after it stay where they are, and the empty one is where the next **Add to pool** lands
if you do not choose a slot.

**To delete a table from the instrument:** click it in the **+Drive wavetables** list, then press
**Delete table** in the preview header.

1. DNX saves a copy to your computer first. **There is no undo on the instrument** — that copy is
   the only way back.
2. The question names any pool slot of the project you are looking at that points at the table.
   Those cells will read **MISSING** afterwards.
3. Only that one project's pool has been read. Any other project may also name the slot, and DNX
   has not looked.

After deleting, take the MISSING entries out with **Remove from pool**. If you leave them and
later write a different table into the same store slot, those entries name the new table instead,
in every project, with nothing on screen having changed.

**To put a deleted table back**, drag its saved copy onto a free slot in the **+Drive wavetables**
list, exactly as you would an audio file, and press **Write staged tables**. DNX recognises the
copy and restores the table as it was: same shape, same name, nothing converted and nothing made
louder. The name and shape boxes are switched off for a restore, because changing them would mean
rebuilding a table that needs no rebuilding.`,
      },
      {
        id: "wavetable-limits",
        heading: "What this mode cannot tell you",
        body: `Three things the pane does not show.

- **The shape of a table.** How many waves it holds, and how long each wave is, is not in a
  listing.
- **How big a table is.** Every slot reports the same fixed size whatever it holds.
- **Which sounds use a pool slot.** That needs every sound of a saved project read, and the
  project open on the instrument stays unsaved until you save it.

A table of a shape the pool cannot play shows no name on the instrument and makes no sound. It is
still stored.`,
      },
      {
        heading: "When an instrument has no wavetables",
        body: `Pressing **Wavetables** asks the instrument what it has. Three replies:

- **It has them.** The mode reads the store.
- **It does not.** This firmware has no wavetable store.
- **It could not be asked.** A timeout, a port held by another program, or a reply that made no
  sense. Press **Wavetables** again.

If the third keeps coming back, close Elektron Transfer and Overbridge, then try again. Some
instruments answer without saying which parts they have. The mode then stays off and the warning
stays on screen.`,
      },
    ],
  },

  {
    key: "probe",
    title: "Probe",
    intro: `The tool you open when something is wrong. It sends single messages to an instrument and
shows exactly what came back, including nothing. It is hidden from the tool row until you turn off
**Settings → Hide the probe**.`,
    sections: [
      {
        id: "session",
        heading: "Finding an instrument",
        body: `**Probe** identifies what is connected. **Listen** shows every message arriving,
which is how you tell a silent device from a busy one.

**Listen has to be on before anything asks a question**, on this page: it is what collects the
reply. Press a request without it and the status bar says so and nothing is sent.

If a request times out, or a listing comes back short, the first thing to check is whether
**another application has the port**. Overbridge or Elektron Transfer holding it produces truncated
replies that look exactly like a protocol bug. Quit both and ask again.`,
        image: { src: "help/probe-connect.png", alt: "The probe's output and input pickers with the identify and listen controls" },
      },
      {
        id: "requests",
        heading: "Asking for one object",
        body: `Request a single pattern, kit, sound or settings object by number and read the bytes
back. **Read project** reads a whole project by request, one object at a time.`,
        image: { src: "help/probe-request.png", alt: "The request row: what to ask for, which object number, and the reply" },
      },
      {
        id: "drive",
        heading: "The +Drive",
        body: `List any directory and read a file by path. The +Drive holds three directories:

| path | what is in it |
|---|---|
| \`/projects\` | 128 project slots |
| \`/soundbanks/A\`..\`H\` | 256 sounds per bank |
| \`/kits/A\`..\`H\` | 128 kits per bank |

**Read file** is marked dangerous because it once froze a Digitone 1 three times. That cause is
understood and fixed, and the warning stays because the failure needed a power cycle and cost
whatever was unsaved.`,
        image: { src: "help/probe-drive.png", alt: "A listing of /soundbanks/A: the request that was sent, the cursor to continue from, and the seven presets that came back with their sizes" },
      },
      {
        id: "writing",
        heading: "Writing",
        body: `**Write back** returns a captured record to the slot it came from. **Write to slot**
copies a pattern into another slot. **Read → write** copies a +Drive file.

All three need **WRITE** to be on, save a copy of the destination to your downloads before
sending anything, and read the result back to check it. A copy that cannot be taken refuses the
write.

**Write back** also checks that the slot still holds what was captured. If it has changed since,
the round trip is not the harmless one it looks like, and the question says so.`,
      },
    ],
  },

  {
    key: "safeguards",
    title: "Safeguards",
    intro: `What stands between you and losing work. Every one of these exists because the failure it
prevents is one somebody has to notice afterwards, and there is no undo on the instrument.`,
    sections: [
      {
        heading: "Nothing is written until you arm it",
        body: `**WRITE** in the tool row starts **off**. While it is off, every control that could
reach an instrument is inert and says so.

Arming it edges the whole page in **red**, on every tool, for as long as it stays armed. The state
lasts for a browsing session rather than a page, so switching between the manager and the probe does
not disarm it — which is why the frame is loud rather than a lit pixel.

Turning it off again is one click.`,
        image: { src: "help/safeguards-write-armed.png", alt: "The tool row with WRITE ARMED lit in red and the red frame around the whole page" },
      },
      {
        heading: "Every write backs up first, and refuses without one",
        body: `Before a single byte is sent, DNX:

1. **Re-reads the destination from the instrument**, rather than trusting what it read an hour ago.
2. **Tells you what moved** if anything changed on the instrument meanwhile.
3. **Saves a copy** of what is about to be overwritten. If that copy cannot be made, the write does
   not happen.
4. **Asks**, showing what it is about to do.
5. **Writes.**
6. **Reads it back and compares.**

Step 3 is not optional and cannot be switched off. The case it exists for is the instrument going
quiet, which is exactly when you want the copy.`,
      },
      {
        heading: "What a confirmation tells you",
        body: `A confirmation names the file, its size and the exact path it is going to, and it says
what is at that path now and when it looked. A count of slots would tell you none of that.

**An occupied +Drive slot is refused, not overwritten**, so the picker offers only free ones and the
confirmation says so.

The affirmative button is marked as destructive and focus starts on **Cancel**.`,
        image: { src: "help/safeguards-confirm.png", alt: "A write confirmation naming the instrument, the destination slots and what they currently hold" },
      },
      {
        heading: "Close Elektron Transfer and Overbridge first",
        body: `**Only one application can talk to an instrument's USB port cleanly at a time.** With
Elektron Transfer or Overbridge open, DNX's messages still go out and replies still come back, but
the replies arrive **cut short**. Nothing on the instrument is wrong, and it looks exactly as if it
were.

What that looks like in DNX:

- A preset bank that lists **35 of 256** slots, or the +Drive listing **45 of 128** projects.
- A project or preset that stops part-way through reading.
- A request that never gets an answer.

DNX checks every listing and refuses one that did not arrive whole, rather than showing you part of
a bank as if it were all of it. The message names both applications. **Quit them, then press the
button again**: there is nothing to reset on the instrument.

A list you choose a destination from is the one place a short answer would cost you work, which is
why a partial one is an error and not a shorter list.`,
      },
      {
        heading: "If something goes wrong",
        body: `- A copy of the destination is saved to your downloads before every write that changes it,
  and the write is refused if the copy cannot be taken. It is a replayable file.
- A refused write reports the instrument's own words rather than a guess.
- A write that reaches the instrument and stores nothing is caught by the read-back, which is the
  only proof there is: a device that stored the bytes and one that ignored the message look
  identical from this end.`,
      },
    ],
  },

  {
    key: "backup",
    title: "Backup",
    intro: `**Settings → Back up the +Drive** reads a whole instrument into one \`.dnx\` file.
Nothing on the instrument is changed.`,
    sections: [
      {
        id: "backup-contents",
        heading: "What it reads",
        body: `Every occupied slot in every directory the +Drive has:

| | | |
|---|---|---|
| projects | up to 128 | both instruments |
| sounds | 8 banks of 256 | both instruments |
| kits | 8 banks of 128 | Digitone II only |

**The directories are read off the instrument, not assumed.** A Digitone 1 has no \`/kits\`, and a
backup that asked for one anyway would end with nothing saved.

Empty slots are skipped. A Digitone II with 18 projects, 1,835 sounds and 16 kits is **1,869 items,
1.7 MB, about a minute**; a Digitone 1 with 55 projects and 1,364 sounds is **1,419 items, 1.0 MB.**

Projects are read first, so a backup interrupted halfway holds the thing you would miss most.`,
        image: { src: "help/backup-progress.png", alt: "The backup running, with a row for each kind of thing showing how many of its slots have been read" },
      },
      {
        heading: "A .dnx is a zip",
        body: `Rename it to \`.zip\` and it opens in Explorer, in Finder, in any archiver. Every file
inside is an ordinary Elektron file that Elektron Transfer will accept.

\`\`\`
manifest.json
projects/001 PRESETS.dn2prj
soundbanks/A/001 HIDDEN TEARS.dn2snd
kits/A/001 SOLID.dn2kit
\`\`\`

That is a Digitone II. A Digitone 1 backup holds \`.dnprj\` and \`.dnsnd\` files and no \`kits\`
directory, because **the names say which instrument the bytes came off** long after the backup was
taken.

**A backup only DNX can read would be a way of losing music slowly.** This one degrades into a
folder of ordinary files the moment you need it to.`,
      },
      {
        heading: "What manifest.json is for",
        body: `A \`.dn2prj\` does not know which slot it came from, and the instrument addresses
projects by number. The manifest records the slot, the path, the instrument and its firmware for
every file — which is what makes putting one back possible.

Firmware is **left out when the instrument did not answer**, rather than guessed.`,
      },
    ],
  },

  {
    key: "settings",
    title: "Settings",
    intro: `**settings** in the tool row opens preferences that apply to every tool. They last for
this browser, and none of them is about your projects.`,
    sections: [
      {
        id: "settings-rows",
        heading: "What is in it",
        body: `- **Back up the +Drive** — see *Backup*.
- **Erase the wavetable region** — take every wavetable off the instrument. See *Erasing the
  wavetable region* below.
- **Hide the probe** — keep the probe out of the tool row. On unless you turn it off.
- **DNX folder** — where DNX saves the files it makes. See *The DNX folder* below.
- **Motion** — honour your system's reduced-motion setting, or overrule it.
- **Stored preferences** — clear everything DNX has kept: these settings, the DNX folder, panel
  states, and whether writing is armed. **Your projects are never stored.**
- **DNX** — the source, under the AGPL-3.0.`,
        image: { src: "help/settings-sheet.png", alt: "The settings sheet open over the manager, showing the instrument, application and about groups" },
      },
      {
        heading: "The DNX folder",
        body: `Choose a folder once and DNX saves into it without asking, one subfolder for each kind
of file. The subfolders are made the first time something goes in them.

\`\`\`
the folder you chose/
  Exports/                 project files from Export, in the manager, the library and the expander
  Backups/                 .dnx backups of a whole +Drive
  Copies before writing/   what was on the instrument before DNX replaced it
  Probe/                   captures and raw +Drive reads from the probe
\`\`\`

**Nothing is replaced.** A name already taken gets a number, as a download would:
\`SKETCHPAD (1).dn2prj\`.

**Files go to your downloads instead** when no folder is chosen, when the browser cannot save into
a folder (Chrome and Edge can, Firefox and Safari cannot), or when the browser no longer has
permission. The status line says which.

**Chrome can ask again after a restart.** Settings then shows the folder as needing permission:
press **Allow**. **Forget** stops using the folder and leaves its files where they are.`,
      },
      {
        id: "settings-erase",
        heading: "Erasing the wavetable region",
        body: `**Erase…** takes every wavetable and every wavetable pool off the instrument, putting
its +Drive back to how it left the factory. It is for selling the instrument, sending it for
repair, or going back to the official firmware for good. Nothing else uses it.

**FORMAT +DRIVE and a factory reset do not do this.** They leave the wavetables where they are, so
this is the only way to remove them.

Before you start:

1. The instrument must be running the custom firmware, connected, and chosen in the **library**.
2. Open the **Wavetables** tab once, so DNX can ask the instrument what it can do.
3. Choose a **DNX folder** in these settings. DNX saves one file per wavetable, and a browser
   blocks that many downloads — without a folder, **Erase…** will not run.
4. Turn on **WRITE** in the tool row.

Then:

1. Press **Erase…**. DNX reads every wavetable off the instrument and saves a copy into your DNX
   folder. On a full instrument this takes several minutes, and the bar says how far it has got.
2. Read the question. It says how many wavetables and pools are going, lists them by name, and
   says how much was saved.
3. Press **Erase the region**, or **Cancel**. Cancelling sends nothing, and the copies stay.
4. DNX reads the instrument back and tells you it is empty.

**The copies are the only way back.** There is no undo on the instrument itself. Put a wavetable
back by dragging its file onto a free slot in the **Wavetables** tab.

**Do this before you put the official firmware back on.** The official firmware has no way to
reach these wavetables, so going back first means installing the custom firmware again to erase,
then the official one again afterwards.

**It clears the pool of every project, not only the one you are looking at.** A pool is kept on the
+Drive rather than inside a project file, so no project is edited by this: your projects, sounds
and kits are kept somewhere else and are not touched.

**What stays behind is the TBL setting on each sound.** It keeps the number it had and plays the
built-in Prim, because the wavetable that number pointed at is gone. Point those sounds at a new
wavetable once you have put one back.`,
      },
      {
        heading: "Why the write switch is not in here",
        body: `It is a mode you turn on to do something and off again, not a preference you set once.
Its value is being visible without going to look for it — behind a menu you could be armed with
nothing on screen saying so.`,
      },
    ],
  },
];

/** The page a tool opens on. A tool with no entry opens the overview. */
export const HELP_FOR_TOOL: Record<string, string> = {
  expander: "expander",
  manager: "manager",
  library: "library",
  probe: "probe",
};
