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
 *
 * **The bodies follow ASD-STE100 Simplified Technical English.** Procedures are numbered imperative
 * steps of at most 20 words, descriptions at most 25, active voice, one instruction per sentence,
 * and a CAUTION before the step it applies to. UI names are bolded as the UI spells them.
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
    intro: `DNX reads, edits and writes Elektron **Digitone** and **Digitone II** projects. It
connects to the instruments through MIDI. It operates fully in this browser.`,
    sections: [
      {
        heading: "Nothing leaves this machine",
        body: `DNX reads, edits and writes all files **in the browser**. It does not send files to a
server. When you close the tab, DNX keeps nothing.

DNX does not need a network connection. Load the page one time, and it continues to operate
without a network.`,
      },
      {
        heading: "The tools, always in the same order",
        body: `The row at the top always shows the tools in the same order. Each tool has a fixed
position.

| tool | use it to |
|---|---|
| **expander** | move the sounds of a Digitone 1 project onto the 16 tracks of a Digitone II |
| **manager** | move patterns between slots, banks and projects, and analyse a pattern |
| **library** | move presets and kits between the pool of a project and the +Drive library, and manage wavetables |
| **probe** | send single messages to an instrument when there is a problem |

The probe is hidden. To show it, turn off **Settings → Hide the probe**. The probe is in the last
position, so the other tools do not move.

To go to the next tool or the previous tool, push \`Ctrl\`+\`Alt\`+\`→\` or \`Ctrl\`+\`Alt\`+\`←\`.
On Spanish, German and UK-extended keyboards, \`Ctrl\`+\`Alt\` is AltGr. On these keyboards, DNX
ignores the shortcuts while you type in a field.`,
        image: { src: "help/overview-toolrow.png", alt: "The DNX tool row: expander, manager, library, probe, the write switch, settings and source" },
      },
      {
        heading: "The front page and the version",
        body: `When you open DNX, it shows a front page. The line below the animation shows the
version, for example **v0.9.0-beta.1 · 11f8a9c**. The second part identifies the build.

**When you report a problem, give the two parts.** Two copies of DNX with the same version number
can be different builds.

- **The first time you open DNX**, the animation is longer. The page asks you to choose a DNX
  folder.
- **To go directly to the tools**, turn on **Settings → Skip the boot screen**.
- **To go back to the front page**, click the DNX name at the top left.

DNX operates only in a **Chromium browser**, for example Chrome, Edge, Brave or Arc. Firefox and
Safari do not have Web MIDI, so they cannot connect to an instrument. The front page tells you
this.`,
      },
      {
        heading: "A Digitone and a Digitone II",
        body: `DNX operates with the two instruments. Some functions are different on each.

| | Digitone | Digitone II |
|---|---|---|
| **Expander** | the source: a file, the connected instrument, or its +Drive | the destination: blank, a file, its +Drive, or the loaded project |
| **Manager:** open a project file, open from the +Drive, save to it | yes | yes |
| **Manager:** move, copy, swap, clear and rename patterns | yes | yes, but not patterns in a storage version that DNX cannot edit |
| **Manager:** Open device, read the loaded project | no: use Browse +Drive | yes |
| **Manager:** the 16 tracks of a pattern | no | yes |
| **Manager:** songs | no | yes |
| **Manager:** Insights | yes | yes |
| **Library:** browse presets, search, tags, rename | yes | yes |
| **Library:** machine column | no: one FM engine | yes |
| **Library:** kits | no: there are no kits on its +Drive | yes |
| **Library:** pool audit, and add presets to a pool | the project must be a Digitone II; DNX converts Digitone presets | yes |
| **Library:** wavetables | no | yes, with the Waverider firmware |
| **Backup** | projects and sounds | projects, sounds and kits |
| **Probe** | yes | yes |

When two instruments are connected, a list shows them. Choose one instrument in that list.

In Insights, a Digitone II pattern has a **RESET** setting and a **CHANGE** setting. DNX has not
found these settings in a Digitone 1 pattern. For a Digitone 1, these two tiles show **?**.`,
      },
      {
        heading: "What DNX will not do",
        body: `- DNX does not write to an instrument until you turn on **WRITE**. Refer to
  *Safeguards*.
- Before DNX writes, it reads the destination and saves a copy.
- DNX does not open a Digitone II pattern in a storage version that it cannot read.`,
      },
    ],
  },

  {
    key: "expander",
    title: "Expander",
    intro: `A Digitone 1 has four tracks. To play more sounds, producers **sound-lock trigs**, so
that one track plays many sounds. The expander puts each sound on its own track of the 16 tracks
on a Digitone II.`,
    sections: [
      {
        id: "expander-io",
        heading: "Pick a source and a destination",
        body: `**Source** is the Digitone 1 project that you expand. It can come from a file, from a
connected instrument, or from the +Drive of an instrument.

**Destination** is the Digitone II project that receives the result.

- **Blank** starts from an empty project.
- **From file** and **Connect a Digitone II** use a project that you have. The other parts of
  that project do not change.`,
        image: { src: "help/expander-in.png", alt: "The IN row: source and destination pickers, each offering a file, a connected instrument, or its +Drive" },
      },
      {
        id: "expander-options",
        heading: "Choosing what to expand",
        body: `**Selected patterns** expands the patterns that you select. **Whole project** expands
all patterns.

Five options change the track layout:

| option | what it does |
|---|---|
| **Contiguous** | fills tracks from the first free track, with no gaps |
| **Compact** | assigns tracks for each pattern, so two patterns can use one track for different sounds |
| **Freed MIDI** | uses the MIDI tracks that the DN1 project does not use |
| **Aggregate by name** | puts sounds with the same name on one track |
| **Percussion low** | puts percussion on the lower tracks |

**Rules** shows the plan before DNX applies it.`,
        image: { src: "help/expander-options.png", alt: "The expansion options row with Selected patterns, Whole project and the five layout switches" },
      },
      {
        id: "expander-out",
        heading: "Apply, then export or write",
        body: `**Apply** makes the expansion in the destination on this page. DNX does not save it.
To cancel the expansion, push **Undo**.

- **Export .dn2prj** saves a project file in your downloads.
- **Write to instrument** sends the project to a connected Digitone II. **WRITE** must be on.`,
      },
    ],
  },

  {
    key: "manager",
    title: "Manager",
    intro: `Move patterns between slots, banks and projects, with the sounds that they use. Open a
project from a file, from an instrument, or from the +Drive of an instrument.`,
    sections: [
      {
        id: "grid",
        heading: "The grid",
        body: `Each slot shows its bank letter and number, the pattern name, and the contents: the
number of trigs and locks, or *empty*.

- Click a slot to select it.
- **Shift**-click to select a range.
- **Ctrl**-click to add one slot.

The selection stays when you change banks. Thus you can select A1 and B1 together.

A slot that shows *storage version we do not read* has a pattern from a firmware that DNX does not
know. DNX shows this slot, but you cannot edit it.`,
        image: { src: "help/manager-grid.png", alt: "The pattern grid showing a bank of sixteen slots with names and trig counts" },
      },
      {
        id: "operations",
        heading: "Move, copy, swap, rename, clear",
        body: `The operations apply to the selection.

- **Move** removes the pattern from the source slot. **Copy** keeps it there.
- **Swap** exchanges two slots.
- **Rename** changes the name of a pattern.
- **Clear** empties a slot.

**DNX keeps sound locks correct.** A lock refers to a slot number in the sound pool of the
project. When you copy a pattern to a different project, DNX changes these numbers, so the pattern
plays the same sounds.

DNX does not send operations to an instrument. **Undo** and **Redo** apply to all operations in
the session.`,
        image: { src: "help/manager-operations.png", alt: "The Operations panel with Move, Copy, Swap, Rename and Clear, and the current selection listed beside it" },
      },
      {
        id: "open-device",
        heading: "Opening from an instrument",
        body: `**Open device…** reads the project that is loaded on the instrument.

**Browse +Drive…** shows the 128 project slots. Choose one slot to open it. This project is
**read-only**. A write goes to the *active* project of the instrument, not to the slot that you
opened. Example: changes for slot 47 go to the active project.

- To get a file, push **Export**.
- To write to a slot, push **Save to +Drive…**.`,
        image: { src: "help/manager-drive.png", alt: "The +Drive project picker listing slots by number and name" },
      },
      {
        id: "open-backup",
        heading: "Opening a project out of a backup",
        body: `**Open a backup…** reads a \`.dnx\` file and shows its contents: the instrument, the
date of the backup, and each project, sound and kit. Choose a project to open it. The grid,
**Undo** and **Export** operate on it as on a usual project.

**When you open a backup, DNX does not write to an instrument.** The browser reads the file.

DNX counts and names the sounds and kits, but you cannot use them yet.

If a part of the backup is damaged, DNX **names the missing items at the top**. The other items
open.`,
        image: { src: "help/backup-picker.png", alt: "The contents of a backup: the instrument and date it was taken, its projects listed by slot, and its sounds and kits counted" },
      },
      {
        id: "songs",
        heading: "Songs",
        body: `The song panel shows the 16 songs of a project and the rows in each song. When an
operation moves a pattern, DNX changes the song rows that refer to it. Thus each song plays the
same patterns as before.`,
        image: { src: "help/manager-song.png", alt: "The song panel showing the sixteen song slots and the rows of the selected one" },
      },
    ],
  },

  {
    key: "insights",
    title: "Insights",
    intro: `**Insights** analyses what a pattern plays.

1. Select one or more patterns in the grid.
2. Push **Insights**.

When you select more than one pattern, Insights compares them.

Insights reads the two instruments. A Digitone 1 pattern has four synth tracks, four MIDI tracks
**A** to **D**, eight voices and 64 steps. Insights shows it with these values. DNX cannot find
the reset setting in a Digitone 1 file, so these tiles show **?**.`,
    sections: [
      {
        id: "cycle",
        heading: "The length of a pattern",
        body: `Each track can have its own length and its own speed. Thus a pattern does not always
repeat when its longest track repeats.

- **Polymeter** is the number of steps until all track lengths align.
- **Repeats every** is what you hear. **PATTERN RESET** sends all tracks back to step one, also
  tracks that are not at their end.

Example: a pattern has tracks of 12, 16 and 64 steps. It repeats after 192 steps. If RESET is 64,
the pattern repeats after 64 steps.`,
        image: { src: "help/insights-cycle.png", alt: "The play time and cycle card, with tempo, window, repeat length and tracks in play" },
      },
      {
        id: "reset",
        heading: "What the reset interrupts",
        body: `If the reset is not a multiple of a track length, the reset stops that track before
its end. This occurs at the same step each time. You hear a part that is wrong on each repeat. The
instrument does not show this.

- A stop that removes no trigs shows as a dashed outline.
- A stop that removes notes shows as a filled area with a count.`,
        image: { src: "help/insights-reset.png", alt: "The reset ruler showing each track's complete passes and where the reset interrupts it" },
      },
      {
        id: "dormant",
        heading: "Trigs the sequencer never reaches",
        body: `When you make a track shorter, the trigs on the removed pages stay in the file. Thus a
16-step track can have notes on steps 33 to 45. These notes do not play until you make the track
longer.

Insights shows these trigs, their steps, and the **LEN** that makes each track play them. The
instrument does not show this.

All other values on the page count only the trigs that play.`,
        image: { src: "help/insights-dormant.png", alt: "The card naming tracks that hold trigs past their own length, with the steps and the LEN that reaches them" },
      },
      {
        id: "pitch",
        heading: "Voices, pitch and key",
        body: `A Digitone II plays **16 voices** at the same time. A chord trig uses one voice for
each note. The voice chart shows where a pattern needs more voices than the instrument has.

The key is an **estimate**. It shows the key that agrees best with the notes in a time window. The
key can change during the pattern.`,
        image: { src: "help/insights-pitch.png", alt: "The pitch content card with the per-track pitch bars and the key timeline" },
      },
      {
        id: "compare",
        heading: "Comparing patterns",
        body: `When you select more than one pattern, the page starts with a comparison. It shows:

- if the patterns have the same tempo
- which pattern has the shortest cycle
- which patterns lose notes because of the reset
- a bar for each pattern, with its length before it repeats

**The bars show steps.** If the tempos are different, you cannot compare the times. The page tells
you when this occurs.`,
        image: { src: "help/insights-compare.png", alt: "The comparison card with one bar per selected pattern and a caret marking the one analysed below" },
      },
    ],
  },

  {
    key: "library",
    title: "Library",
    intro: `The library shows the **sound pool** of a project next to the **+Drive library** of the
instrument. A trig can preset-lock only a preset that is in the pool. The library holds 2,048
presets.

The list next to **Browse** sets what you work with: **Presets**, **Kits** or **Wavetables**.
The wavetable sections are at the end of this page.`,
    sections: [
      {
        id: "pool-vs-library",
        heading: "The pool and the library",
        body: `The Elektron manual gives the difference: *"the primary benefit of presets loaded to
the pool is the possibility for them to be preset locked."*

Use this page to move presets between the two:

- Add a preset from the library to the pool.
- Keep a preset in the library only.
- Load a kit into a pattern.`,
        image: { src: "help/library-two-panes.png", alt: "The library: a project's sound pool on one side and the instrument's +Drive library on the other" },
      },
      {
        heading: "What it writes",
        body: `When you drag a preset from the library into the pool, DNX **changes the project on
this page**. DNX does not write to the instrument. The file on your computer does not change until
you push **Export project**. To cancel all changes, load the page again.

**Rename… is different**: it changes a preset on the instrument.`,
      },
      {
        heading: "A Digitone or a Digitone II",
        body: `**Connect an instrument…** operates with the two instruments. When two are connected, a
list shows them. Choose one instrument, then push the button again.

- **A Digitone has no kits on its +Drive.** You can browse only its presets.
- **Its presets show tags but no machine.** A Digitone has one FM engine.
- Rename operates the same on the two instruments.
- The pool reads only Digitone II projects. Presets move in one direction only. Refer to the next
  section.`,
      },
      {
        heading: "Presets move in one direction",
        body: `You can add a **Digitone 1 preset to a Digitone II project**. DNX converts the preset
when you drop it into the pool. **You cannot move a Digitone II preset to a Digitone 1.**

- **Only FM TONE has an equivalent.** WAVETONE, FM DRUM and SWARMER do not exist on a Digitone.
- **The third LFO is not available.** A Digitone II has three LFOs. A Digitone has two.
- **Other settings are not available.** A Digitone sound has 302 bytes. 226 of them have a known
  source in the 359 bytes of a Digitone II preset. 53 more never change, so DNX could fill them.
  The other 23 bytes hold settings that a Digitone II preset does not have. DNX does not guess
  these values.

The library opens only **Digitone II projects** for pool work. You can browse, tag, search and
rename the presets of a Digitone.`,
      },
      {
        heading: "Renaming a preset",
        body: `Before you start:

- **WRITE** is on.
- The preset is not a factory preset. The instrument does not let you rename factory presets. To
  rename one, save a copy to a free slot on the instrument, then rename the copy.

1. Browse a preset bank.
2. Click a preset.
3. Push **Rename…**.
4. Type the new name. The maximum is 16 characters. The instrument has no lowercase, so DNX
   stores lowercase as uppercase.
5. Read the question.
6. Confirm.

Before DNX sends the name, it saves the current preset to *Copies before writing* in the DNX
folder, or to your downloads. The file is a **.dn2snd** from a Digitone II or a **.dnsnd** from a
Digitone.

After the write, DNX reads the slot and compares it with what it sent. Then DNX reads the bank
again, so the new name comes from the instrument.`,
      },
      {
        id: "library-search",
        heading: "Finding a preset",
        body: `- **Search** filters by name.
- **Occupied only** hides empty slots.
- **Refresh** reads the instrument again.`,
        image: { src: "help/library-search.png", alt: "A search narrowing a bank to 90 of its 256 slots, the tag chips re-counted against the match, and the presets that matched" },
      },
      {
        id: "wavetable-modes",
        heading: "The Wavetables mode",
        body: `See the wavetables that a project can play, and the slots on the instrument that hold
them.

Before you start:

- A Digitone II with the Waverider firmware.
- **WRITE** can be off. This mode only reads.

1. Push **Connect an instrument…**.
2. Choose **Wavetables** in the list next to **Browse**.
3. Choose a project in the **Project** list. **Working project** is the project that is loaded on
   the instrument. This is the project that you hear.

The left pane shows the **wavetable pool** of the project: 128 slots. Each slot refers to a store
slot.

The right pane shows the **wavetable store** of the instrument: 256 slots with one table each. All
projects use the same store.

The **TBL** setting of a sound selects a pool slot. The pool slot refers to a store slot.`,
        image: { src: "help/wavetables-pane.png", alt: "The Wavetables mode: a project's 128-slot wavetable pool on the left, the instrument's 256-slot store on the right, and store rows saying which pool slot each table is in" },
      },
      {
        heading: "Store slot, pool slot, and the number in a sound",
        body: `Each table in the pool has two numbers:

- **Store slot, 0 to 255.** The position of the table on the instrument. It is the same for all
  projects.
- **Pool slot, 1 to 128.** The position of the table in the pool of this project. Set **TBL** to
  this number.

On the instrument, **TBL** shows **T:002** for pool slot 2. Below **T:001** are the two built-in
waveforms, **PRIM** and **HARM**.

One table can be in store slot 9 and pool slot 2. In a different project, the same table can be
in a different pool slot. Each cell shows its store slot and its pool slot.`,
      },
      {
        heading: "Seeing what a table looks like",
        body: `The preview shows **all frames of a table**, one behind the other.

1. Click an occupied row in the **+Drive wavetables** pane.
2. Move **Position** to select one frame.

The selected frame is bright, with a dashed line below it. The other frames are dim. **Position**
is the same value as **WT.POS** on a sound. Example: frame 24 of 64 is a position of 0.365.

- DNX reads each table from the instrument one time. When you select it again, DNX does not read
  it again.
- **Refresh** clears all tables that DNX has read.
- **Play** plays the selected frame. **Sweep** plays all frames from the first to the last. DNX
  makes these sounds in the browser. DNX sends nothing to the instrument.
- This pane does not change the instrument. **Position** changes only the preview.`,
        image: { src: "help/wavetables-preview.png", alt: "The wavetable preview: every frame of a 64-frame table stacked front to back, the picked frame drawn bright with a dashed line under it, and the Position and Volume sliders under it reading frame 24 of 64 at 0.365" },
      },
      {
        id: "wavetable-import",
        heading: "Putting a wavetable on the instrument",
        body: `Drop audio files on the store, examine them, then write them.

Before you start:

- A Digitone II with the Waverider firmware.
- **WRITE** is on, in the tool row.
- Elektron Transfer and Overbridge are closed.

1. Choose **Wavetables** next to **Browse**.
2. Choose a project in the **Project** list.
3. Drag audio files from your computer onto a free slot in the **+Drive wavetables** list. During
   the drag, the destination slots are bright. Occupied slots that DNX skips are dim.
4. The slots become amber and show **staged**. DNX has sent nothing.
5. Click a staged row.
6. Set **name**, **waves** and **points**.
7. Push **Play** to hear one frame, or **Sweep** to hear all frames.
8. Push **Write staged tables**. A question shows each slot that DNX will write.

**waves** sets the number of frames. When you set more waves than the file has, DNX cuts the file
into that number of parts. DNX stretches each part to a full wave.

**blend** keeps the waves of the file and adds mixed waves between them. The original waves do not
change when *(new waves − 1)* is a multiple of *(file waves − 1)*. Example: 7 waves to 61. At
other values, DNX also mixes the original waves a little. **blend** is off when the file does not
divide into full waves.

- To move a staged table, drag its row onto a different free slot.
- **Remove** removes one table from the list.
- **Discard all** clears the list.
- When you leave this mode, DNX discards all staged tables.

DNX reads a **WAV** file without changes. The browser reads other formats. The browser can change
the number of samples. The panel tells you when this occurs.`,
        image: { src: "help/wavetables-import.png", alt: "Three audio files staged on free store slots, marked amber and reading staged, with the panel below showing the name, the waves and points, and the Play and Write staged tables buttons" },
      },
      {
        id: "wavetable-add-to-pool",
        heading: "Making a table playable: put it in the pool",
        body: `A table in the store does not play until it is in the pool of a project. You choose
the pool slot. A sound uses this number.

Before you start:

- A table is in the **+Drive wavetables** list.
- **WRITE** is on, in the tool row.

1. Choose **Wavetables** next to **Browse**.
2. Choose the project in the **Project** list.
3. In the **+Drive wavetables** list, click the table. To select a range, **Shift**-click a
   second table. To add or remove one table, **Ctrl**-click it (**Cmd**-click on a Mac).
4. Drag the tables onto the pool slot for the first table. The other tables go into the slots
   after it. The slot shows the number of tables and the tables that they replace.
5. Read the question. It shows each table, each slot, and the current contents of each slot.
6. Confirm.

You can also click a pool slot and push **Add to pool**. If you do not select a pool slot, DNX uses
the first free slot.

On the instrument, set **TBL** on the sound to the pool slot number. For pool slot 5, **TBL** shows
**T:005**.

Before DNX sends the new pool, it saves the current pool as a file on your computer. This file is
the only way to undo the change.

If the pool changes on the instrument after DNX reads it, DNX does not write. The pane then shows
the pool as it is on the instrument. Do the edit again.

If the project **follows the store**, the question tells you. After the write, the project plays
only the tables in its list. New tables in the store do not go into this project until you add
them.

All projects use the same store. Each project has its own pool. Thus one table can be pool slot 3
in one project and pool slot 40 in a different project. When you add a table to one pool, other
pools do not change.`,
      },
      {
        id: "wavetable-shape",
        heading: "Choosing the shape of a table",
        body: `**waves** is the number of frames in the table. **points** is the length of each frame.

DNX reads the length of the file and proposes a shape. The panel shows the shape and if DNX
resamples the file.

- **The length divides exactly.** The file is probably in that shape.
- **More than one shape can divide a file.** Change the values if you know the correct shape.
- **The instrument cannot play some shapes.** DNX writes the table, but it does not play. The panel
  tells you before you write.

DNX makes each table as loud as possible. Thus tables from different files have the same level.`,
      },
      {
        id: "wavetable-pool-kinds",
        heading: "The three kinds of pool",
        body: `A pool is a record on the **+Drive**. Each project slot has one. The pool is not in the
project file. To read a pool, connect the instrument.

The line below the pool shows the kind of pool:

- **No pool of its own.** The project plays **no** wavetables. A sound with a **TBL** number plays
  the built-in **PRIM** until you add tables to the pool.
- **Follows the store.** The project plays all stored tables in store-slot order. It also plays
  new tables when you add them to the store.
- **A list.** The pool has the slots that a person chose, on the instrument or in DNX.

**Use a list for a project that you make.** A list keeps each table in the pool slot that you
choose.

When a project follows the store, a new table in a free store slot before the other tables moves
all subsequent pool slots by one. Sounds keep their **TBL** numbers, so they play different
tables. To prevent this, give the project a list.

A project from before the Waverider firmware has no pool of its own. It plays no wavetables until
you add tables to it.`,
      },
      {
        heading: "When a cell says MISSING",
        body: `**MISSING** means that the pool refers to an empty store slot. A sound set to that pool
slot plays a built-in waveform.

To correct it:

1. Push **Refresh**. DNX reads the pool and the store again.
2. Click the cell.
3. Do one of these steps:
   - Push **Remove from pool** to empty the slot.
   - Put a table in the slot with **Add to pool**.
   - On the instrument, set the sound to a different pool slot.

DNX does not clear a MISSING entry automatically. **Add to pool** skips MISSING entries and uses
the first empty slot.

**Do not keep a MISSING entry.** If you write a different table into that store slot, the entry
refers to the new table in all projects.

The Waverider firmware notes describe what the instrument does with a MISSING entry: [A pool entry
whose table is gone](https://github.com/angellinares/dn2_firmware_explore/blob/main/docs/for-dnx-waverider-pool.md#a-pool-entry-whose-table-is-gone-asked-by-dnx-2026-10-14).`,
        image: { src: "help/wavetables-missing.png", alt: "A pool cell naming a store slot that is empty, reading MISSING, with a note saying the table was deleted and the slot now plays the built-in waveform" },
      },
      {
        id: "wavetable-remove",
        heading: "Taking a table out of a pool, and deleting one",
        body: `There are two procedures:

- **Remove from pool** changes the list of one project.
- **Delete table** removes the table from the instrument, for all projects.

Before you start:

- **WRITE** is on, in the tool row.

**To remove a table from the pool of this project:**

1. Click the pool slot in the left pane.
2. Push **Remove from pool**.

The table stays in the store, and the other projects keep it. The slot becomes empty. A sound with
that **TBL** number plays the built-in **PRIM**. The other slots do not move. If you do not select
a slot, the next **Add to pool** uses this empty slot.

**To delete a table from the instrument:**

**CAUTION:** There is no undo on the instrument. The copy that DNX saves is the only way to restore
the table.

1. Click the table in the **+Drive wavetables** list.
2. Push **Delete table** in the preview header. DNX saves a copy to your computer.
3. Read the question. It shows the pool slots of this project that refer to the table. These cells
   show **MISSING** after the delete. The question does not show other projects.
4. Confirm.

After the delete, remove the MISSING entries with **Remove from pool**.

**To restore a deleted table:**

1. Drag its saved copy onto a free slot in the **+Drive wavetables** list.
2. Push **Write staged tables**.

DNX restores the table with the same shape and name. DNX does not convert it or change its level.
For a restore, the name and shape fields are off.`,
      },
      {
        id: "wavetable-limits",
        heading: "What this mode cannot tell you",
        body: `The pane does not show:

- **The shape of a table.** The listing does not give the number of waves or the wave length.
- **The size of a table.** All slots show the same fixed size.
- **The sounds that use a pool slot.** DNX must read all sounds of a saved project to find them.
  The project on the instrument is not saved until you save it.
- **The other projects that use a table.** DNX reads the pool of one project at a time. A
  different project can refer to the same table.

The instrument does not play a table that has a shape that the pool cannot play. The instrument
shows no name for it. The table stays in the store.`,
      },
      {
        heading: "When an instrument has no wavetables",
        body: `When you choose **Wavetables**, DNX asks the instrument for its functions. There are
three possible replies:

- **The instrument has wavetables.** The mode reads the store.
- **The instrument has no wavetables.** The firmware does not have the wavetable store.
- **DNX cannot ask.** The cause can be a timeout, a port that a different program uses, or an
  incorrect reply. Choose **Wavetables** again.

If the third reply occurs again, close Elektron Transfer and Overbridge. Then try again. Some
instruments do not tell which functions they have. Then the mode stays off and the warning stays
on the screen.`,
      },
    ],
  },

  {
    key: "probe",
    title: "Probe",
    intro: `Use the probe when there is a problem. It sends single messages to an instrument and shows
the reply. If there is no reply, it shows that. The probe is hidden. To show it, turn off
**Settings → Hide the probe**.`,
    sections: [
      {
        id: "session",
        heading: "Finding an instrument",
        body: `**Probe** identifies the connected instrument. **Listen** shows each message that comes
in. Use it to see if an instrument is silent or busy.

**Turn on Listen before you send a request.** Listen receives the reply. If Listen is off, DNX
sends nothing, and the status bar tells you.

If a request times out, or a listing is short, make sure that no other application uses the port.
When Overbridge or Elektron Transfer uses the port, the replies are short.

1. Close the two applications.
2. Send the request again.`,
        image: { src: "help/probe-connect.png", alt: "The probe's output and input pickers with the identify and listen controls" },
      },
      {
        id: "requests",
        heading: "Asking for one object",
        body: `Request one pattern, kit, sound or settings object by its number. The probe shows the
bytes of the reply. **Read project** reads a full project, one object at a time.`,
        image: { src: "help/probe-request.png", alt: "The request row: what to ask for, which object number, and the reply" },
      },
      {
        id: "drive",
        heading: "The +Drive",
        body: `List a directory, or read a file by its path. The +Drive has three directories:

| path | contents |
|---|---|
| \`/projects\` | 128 project slots |
| \`/soundbanks/A\`..\`H\` | 256 sounds in each bank |
| \`/kits/A\`..\`H\` | 128 kits in each bank |

**CAUTION:** **Read file** is marked as dangerous. An earlier version of it stopped a Digitone 1
three times. Each time, the instrument needed a power cycle, and unsaved work was lost.`,
        image: { src: "help/probe-drive.png", alt: "A listing of /soundbanks/A: the request that was sent, the cursor to continue from, and the seven presets that came back with their sizes" },
      },
      {
        id: "writing",
        heading: "Writing",
        body: `- **Write back** writes a captured record to its initial slot.
- **Write to slot** copies a pattern into a different slot.
- **Read → write** copies a +Drive file.

For the three functions, **WRITE** must be on. Before DNX sends data, it saves a copy of the
destination to your downloads. After the write, it reads the result to check it. If DNX cannot
save the copy, it does not write.

**Write back** also makes sure that the slot did not change after the capture. If the slot
changed, the question tells you.`,
      },
    ],
  },

  {
    key: "safeguards",
    title: "Safeguards",
    intro: `These functions prevent loss of work. There is no undo on the instrument.`,
    sections: [
      {
        heading: "Nothing is written until you arm it",
        body: `**WRITE** in the tool row is **off** at the start. When it is off, no control can send
data to an instrument. Each of these controls tells you this.

When you turn it on, a **red** frame shows around the page, in all tools. **WRITE** stays on until
you close the browser session or turn it off. When you change tools, it stays on.

To turn it off, click it one time.`,
        image: { src: "help/safeguards-write-armed.png", alt: "The tool row with WRITE ARMED lit in red and the red frame around the whole page" },
      },
      {
        heading: "Every write backs up first, and refuses without one",
        body: `Before DNX sends data, it does these steps:

1. **It reads the destination from the instrument again.**
2. **It tells you what changed**, if the instrument changed.
3. **It saves a copy** of the data that it will replace. If it cannot save the copy, it does not
   write.
4. **It asks you**, and shows what it will do.
5. **It writes.**
6. **It reads the data again and compares it.**

You cannot turn off step 3.`,
      },
      {
        heading: "What a confirmation tells you",
        body: `A confirmation shows:

- the file, its size, and its full path
- the current contents of that path, and the time that DNX read them

**DNX does not write over an occupied +Drive slot.** The list shows only free slots, and the
confirmation tells you this.

The confirm button is red. At the start, **Cancel** has the focus.`,
        image: { src: "help/safeguards-confirm.png", alt: "A write confirmation naming the instrument, the destination slots and what they currently hold" },
      },
      {
        heading: "Close Elektron Transfer and Overbridge first",
        body: `**Only one application at a time can use the USB port of an instrument correctly.** When
Elektron Transfer or Overbridge is open, DNX sends messages and gets replies, but the replies are
**short**. The instrument has no problem.

In DNX, this shows as:

- A preset bank that shows **35 of 256** slots, or a +Drive listing that shows **45 of 128**
  projects.
- A project or preset that stops before the end of the read.
- A request that gets no reply.

DNX checks each listing. If a listing is not complete, DNX does not show it. The message names the
two applications.

1. Close Elektron Transfer and Overbridge.
2. Push the button again.

You do not have to reset the instrument.`,
      },
      {
        heading: "If something goes wrong",
        body: `- Before each write, DNX saves a copy of the destination to your downloads. If DNX cannot
  save the copy, it does not write. You can write the copy back to the instrument.
- If the instrument refuses a write, DNX shows the message from the instrument.
- After each write, DNX reads the data again. If the instrument did not store the data, DNX tells
  you.`,
      },
    ],
  },

  {
    key: "backup",
    title: "Backup",
    intro: `**Settings → Back up the +Drive** reads all of an instrument into one \`.dnx\` file. The
backup does not change the instrument.

The backup is available in all tools when an instrument is connected. It is not available in the
probe.`,
    sections: [
      {
        id: "backup-contents",
        heading: "What it reads",
        body: `The backup reads each occupied slot in each directory of the +Drive:

| | | |
|---|---|---|
| projects | up to 128 | the two instruments |
| sounds | 8 banks of 256 | the two instruments |
| kits | 8 banks of 128 | Digitone II only |

DNX reads the list of directories from the instrument. A Digitone 1 has no \`/kits\` directory.

DNX skips empty slots. Examples:

- A Digitone II with 18 projects, 1,835 sounds and 16 kits: **1,869 items, 1.7 MB, approximately
  one minute.**
- A Digitone 1 with 55 projects and 1,364 sounds: **1,419 items, 1.0 MB.**

DNX reads the projects first. If the backup stops, it has the projects.`,
        image: { src: "help/backup-progress.png", alt: "The backup running, with a row for each kind of thing showing how many of its slots have been read" },
      },
      {
        heading: "A .dnx is a zip",
        body: `Change the extension to \`.zip\` to open the file in Explorer, in Finder, or in an
archive program. Each file in it is a usual Elektron file. Elektron Transfer accepts these files.

\`\`\`
manifest.json
projects/001 PRESETS.dn2prj
soundbanks/A/001 HIDDEN TEARS.dn2snd
kits/A/001 SOLID.dn2kit
\`\`\`

This example is from a Digitone II. A Digitone 1 backup has \`.dnprj\` and \`.dnsnd\` files and no
\`kits\` directory. The file extensions identify the instrument.`,
      },
      {
        heading: "What manifest.json is for",
        body: `A \`.dn2prj\` file does not contain its slot number. The instrument identifies projects
by number. For each file, the manifest records the slot, the path, the instrument and its firmware.
DNX uses this data to restore a file to its slot.

If the instrument does not give its firmware, the manifest does not include it.`,
      },
    ],
  },

  {
    key: "settings",
    title: "Settings",
    intro: `**settings** in the tool row opens the preferences for all tools. This browser keeps
them. They do not change your projects.`,
    sections: [
      {
        id: "settings-rows",
        heading: "What is in it",
        body: `- **Back up the +Drive**: refer to *Backup*.
- **Erase the wavetable region**: remove all wavetables from the instrument. Refer to *Erasing
  the wavetable region* below.
- **Hide the probe**: hide the probe in the tool row. It is on at the start.
- **DNX folder**: the folder where DNX saves its files. Refer to *The DNX folder* below.
- **Motion**: use the reduced-motion setting of your system, or ignore it.
- **Stored preferences**: clear all data that DNX keeps: these settings, the DNX folder, panel
  states, and the **WRITE** state. **DNX does not keep your projects.**
- **DNX**: the source code, under the AGPL-3.0.`,
        image: { src: "help/settings-sheet.png", alt: "The settings sheet open over the manager, showing the instrument, application and about groups" },
      },
      {
        heading: "The DNX folder",
        body: `Choose a folder one time. Then DNX saves its files into it without a question. Each
type of file has a subfolder. DNX makes a subfolder when it first needs it.

\`\`\`
the folder you chose/
  Exports/                 project files from Export, in the manager, the library and the expander
  Backups/                 .dnx backups of a whole +Drive
  Copies before writing/   the data on the instrument before DNX replaced it
  Probe/                   captures and raw +Drive reads from the probe
\`\`\`

**DNX does not replace files.** If a name is in use, DNX adds a number, for example
\`SKETCHPAD (1).dn2prj\`.

**DNX saves to your downloads** in these conditions:

- You did not choose a folder.
- The browser cannot save into a folder. Chrome and Edge can. Firefox and Safari cannot.
- The browser does not have permission.

The status line tells you which condition applies.

**After a restart, Chrome can ask for permission again.** Then Settings shows that the folder
needs permission. Push **Allow**. **Forget** stops the use of the folder. The files stay in the
folder.`,
      },
      {
        id: "settings-erase",
        heading: "Erasing the wavetable region",
        body: `**Erase…** removes all wavetables and all wavetable pools from the instrument. The +Drive
then has no wavetables, as it was from the factory. Use it before you sell the instrument, before
you send it for repair, or before you install the official firmware again.

**FORMAT +DRIVE and a factory reset do not remove the wavetables.** Only **Erase…** removes them.

**Erase…** is in Settings in all tools when an instrument is connected. It is not available in the
probe.

Before you start:

- The instrument has the Waverider firmware and is connected.
- A **DNX folder** is set in Settings. DNX saves one file for each wavetable. A browser does not
  permit that many downloads, so **Erase…** does not start without a folder.
- **WRITE** is on, in the tool row.

**CAUTION:** There is no undo on the instrument. The copies in your DNX folder are the only way to
restore the wavetables.

1. Push **Erase…**. A question shows the number of wavetables that DNX will copy.
2. Push **Save the copies**, or **Cancel**. If you cancel, DNX copies nothing and sends nothing.
3. DNX reads each wavetable from the instrument and saves a copy in your DNX folder. On a full
   instrument, this takes some minutes. The bar shows the progress. If DNX cannot save a copy in
   the folder, it stops and erases nothing.
4. Read the second question. It shows the number of wavetables and pools to erase, their names,
   and the size of the copies.
5. Push **Erase the region**, or **Cancel**. If you cancel, DNX sends nothing. The copies stay.
6. DNX reads the instrument again and tells you that the region is empty.

To restore a wavetable, drag its file onto a free slot in the **Wavetables** mode of the library.

**Erase the wavetables before you install the official firmware.** The official firmware cannot
remove them. If you install it first, you must install the Waverider firmware again to erase.

**The erase clears the pool of all projects.** The pools are on the +Drive, not in the project
files. The erase does not change your projects, sounds or kits.

**The TBL setting of each sound does not change.** These sounds play the built-in **PRIM**. After
you restore a wavetable, set the sounds to it again.`,
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
