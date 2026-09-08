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
        heading: "Four tools, always in the same order",
        body: `The row at the top never reorders, so each tool keeps a permanent screen position.

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
grid and press *Insights*. Selecting more than one compares them.`,
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
a preset has to be for a trig to preset-lock it; the library is where 2,048 of them live.`,
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
**Export project**.

A mistake costs a reload, not a recording.`,
      },
      {
        id: "library-search",
        heading: "Finding a preset",
        body: `**Search** filters by name. **Occupied only** hides empty slots, which is most of a
library most of the time. **Refresh** re-reads the instrument.`,
        image: { src: "help/library-search.png", alt: "A search narrowing a bank to 90 of its 256 slots, the tag chips re-counted against the match, and the presets that matched" },
      },
    ],
  },

  {
    key: "probe",
    title: "Probe",
    intro: `The tool you open when something is wrong. It sends single messages to an instrument and
shows exactly what came back, including nothing.`,
    sections: [
      {
        id: "session",
        heading: "Finding an instrument",
        body: `**Probe** identifies what is connected. **Listen** shows every message arriving,
which is how you tell a silent device from a busy one.

**Listen has to be on before anything asks a question**, on this page: it is what collects the
reply. Press a request without it and the status bar says so and nothing is sent.

If a request times out, the first thing to check is whether **another application has the port**.
Overbridge or Elektron Transfer holding it produces truncated replies that look exactly like a
protocol bug.`,
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

All three need **WRITE** to be on and read the result back to check it.

**Write to slot** and **Read → write** save a copy of the destination to your downloads
before sending anything, and refuse the write if that copy cannot be taken. **Write back**
returns a record to the slot it came from, so the capture on screen is that copy: save it first
if you want it on disk.`,
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
- **Motion** — honour your system's reduced-motion setting, or overrule it.
- **Stored preferences** — clear everything DNX has kept: these settings, panel states, and whether
  writing is armed. **Your projects are never stored.**
- **DNX** — the source, under the AGPL-3.0.`,
        image: { src: "help/settings-sheet.png", alt: "The settings sheet open over the manager, showing the instrument, application and about groups" },
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
