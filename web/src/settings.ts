/**
 * The settings sheet: one surface for what applies to the whole application.
 *
 * ## Where it goes, and what that cost
 *
 * A sheet over the page, opened from the tool row, closing back to where you were. Three shapes
 * were mocked and compared in `web/mockups/settings.html`. A fifth tool spends a permanent screen
 * position in a row that earns its keep by never moving, for something you touch twice a month. A
 * pinned drawer buys you reading a setting beside the thing it changes, and none of these settings
 * change what you are looking at. The sheet costs one word in the tool row.
 *
 * ## What belongs here
 *
 * Preferences that outlive the page and apply to every tool. `arrival.js` has carried the argument
 * for months: the motion preference is built, honoured, and reachable only by typing
 * `?motion=always` into the address bar, which is not a preference anybody has.
 *
 * ## What does not
 *
 * **The write switch stays in the tool row.** You turn it on to do a thing and off again. It earns
 * that place by being visible without you going to look. Put it behind a menu and you can be armed
 * with nothing on screen saying so, which is the state the red frame exists to prevent.
 *
 * ## The copy is for the person using the application
 *
 * Every string below is what a musician reads. The case for a setting existing belongs in this
 * comment. A description that explains why the developers added something tells the reader nothing
 * they can act on.
 */

/**
 * Where to get the source.
 *
 * **A licence term, not a courtesy.** AGPL-3.0 section 13 says anyone interacting with the program
 * remotely must be offered the source of the version they are running, and a page served from
 * Pages is never downloaded. It lives here rather than in `toolnav.ts` so the import runs one way:
 * the tool row needs the settings sheet, and the sheet must not need the tool row.
 */
export const SOURCE_URL = "https://github.com/NoiseAndMatter/DNX";

/** `arrival.js` owns this key and reads it before paint. These three values are its whole range. */
const MOTION_KEY = "dnx-motion";
type Motion = "system" | "always" | "never";
const MOTIONS: readonly Motion[] = ["system", "always", "never"];

/**
 * Everything this application stores, which is the list "clear" clears.
 *
 * Held here rather than found by prefix, so clearing cannot reach a key some other page on the
 * same origin owns. `dnx-results-` is a prefix and is expanded when clearing.
 */
const STORED = {
  local: [MOTION_KEY, "dnx-hide-probe", "dnx-skip-boot", "dnx-seen"],
  localPrefixes: ["dnx-results-"],
  session: ["dnx-nav-direction", "dnx.writeEnabled"],
};

function readMotion(): Motion {
  try {
    const value = localStorage.getItem(MOTION_KEY);
    return MOTIONS.includes(value as Motion) ? (value as Motion) : "system";
  } catch {
    return "system";
  }
}

function writeMotion(value: Motion): void {
  try {
    localStorage.setItem(MOTION_KEY, value);
  } catch {
    // Private mode, or storage disabled. The choice applies to nothing, and saying so on the page
    // would be noise about a browser setting the person already made.
  }
}

/** Clear every preference this application stores. Projects are not stored and cannot be here. */
function clearStored(): number {
  let cleared = 0;
  try {
    for (const key of STORED.local) {
      if (localStorage.getItem(key) !== null) { localStorage.removeItem(key); cleared++; }
    }
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && STORED.localPrefixes.some((p) => key.startsWith(p))) {
        localStorage.removeItem(key);
        cleared++;
      }
    }
  } catch { /* nothing stored, nothing to clear */ }
  try {
    for (const key of STORED.session) {
      if (sessionStorage.getItem(key) !== null) { sessionStorage.removeItem(key); cleared++; }
    }
  } catch { /* as above */ }
  return cleared;
}

/* ---- what a page lends the sheet ------------------------------------------------------------ */

/**
 * Backing up needs an instrument, and the sheet has no business knowing how to find one.
 *
 * `chooseDevice` is private to the manager: it owns the port picker, the connection, and what to do
 * when two Digitones are plugged in. The sheet is shared by four pages and three of them have no
 * device at all.
 *
 * So the manager lends it a function. A page that has not registers nothing, and the row says where
 * to go rather than offering a button that cannot work.
 */
export interface JobReport {
  /** What is happening, in words. */
  say(message: string): void;
  /**
   * How far through, as a row per kind.
   *
   * **One bar cannot say what a long backup is doing.** 1,835 sounds and 18 projects share a total,
   * so a bar at 40% is somewhere in the sounds and gives no clue whether the projects are safely
   * read. A row each says that at a glance, and says which kinds have not started.
   */
  at(stages: readonly ProgressStage[]): void;
}

export interface ProgressStage {
  kind: string;
  done: number;
  total: number;
  state: "pending" | "reading" | "done";
}

export type BackupRunner = (report: JobReport) => Promise<void>;

let runBackup: BackupRunner | undefined;

/**
 * The select the instrument commands choose with, lent by whoever wired them.
 *
 * Registered rather than imported: this module is also typechecked by the node project, and a
 * device import drags WebMIDI's types in with it. The same reason the runners are lent.
 */
let instrumentSelect: (() => HTMLElement) | undefined;

export function registerInstrumentSelect(find: () => HTMLElement): void {
  instrumentSelect = find;
}

/** Called by a page that can reach an instrument. */
export function registerBackup(runner: BackupRunner): void {
  runBackup = runner;
}

/**
 * A command the device library adds to the instrument group, beside the backup.
 *
 * **Registered, so this sheet names no device.** The erase of a Waverider wavetable region is the
 * first, and it registers itself from `wavetableerase.ts` through `devicecommands.ts`. A fork for
 * other hardware changes that list and nothing here.
 *
 * Every such command writes to an instrument, so its button carries the write switch's attribute
 * and the danger colour. Its id is the control's id: `test/writeenable.test.ts` names it, because
 * a button built at open is invisible to the scan of the pages' markup.
 */
export interface InstrumentCommand {
  id: string;
  title: string;
  /** What it does and what it costs, said before anybody presses it. */
  description: string;
  /** The button. */
  label: string;
  /** A help section, `page/section`, for its own `?`. */
  help?: string;
  /**
   * Read when the sheet is built and again at the press.
   *
   * **Asked for, rather than handed over.** A registered snapshot goes stale the moment somebody
   * connects an instrument or moves to another, and the control would then show a reason that was
   * true when the page loaded. A function has no second copy to keep in step.
   */
  offer: () => CommandOffer;
}

export interface CommandOffer {
  /** The job, when it can run. */
  run?: BackupRunner;
  /** Why it cannot, in words the control shows. Ignored when `run` is set. The command's own sentence. */
  unavailable?: string;
}

const instrumentCommands = new Map<string, InstrumentCommand>();

/** Called by a page as it wires its commands. A second registration of an id replaces the first. */
export function registerInstrumentCommand(command: InstrumentCommand): void {
  instrumentCommands.set(command.id, command);
}

/** The registered commands' ids, for `test/writeenable.test.ts`. */
export function instrumentCommandIds(): string[] {
  return [...instrumentCommands.keys()];
}

/**
 * A row per kind: a name, a count, a state, and a bar.
 *
 * Rebuilt rather than diffed. Four rows at a few updates a second is nothing, and a renderer that
 * patches in place is where a stale row survives a change nobody notices.
 */
function drawStages(host: HTMLElement, stages: readonly ProgressStage[]): void {
  const label: Record<string, string> = {
    projects: "Projects", soundbanks: "Sounds", kits: "Kits",
    // The erase's one stage. It is the copying, which is the part that takes minutes.
    tables: "Tables copied",
  };
  const said: Record<string, string> = {
    pending: "Pending", reading: "In progress", done: "Complete",
  };
  host.replaceChildren(...stages.map((stage) => {
    const row = document.createElement("div");
    row.className = "stage";
    row.dataset["state"] = stage.state;

    const name = document.createElement("span");
    name.className = "what";
    name.textContent = label[stage.kind] ?? stage.kind;

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${stage.done.toLocaleString()}/${stage.total.toLocaleString()}`;

    const state = document.createElement("span");
    state.className = "state";
    state.textContent = said[stage.state]!;

    const track = document.createElement("span");
    track.className = "track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", name.textContent);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(stage.total));
    track.setAttribute("aria-valuenow", String(stage.done));
    const fill = document.createElement("span");
    fill.className = "fill";
    fill.style.width = `${stage.total > 0 ? Math.round((stage.done / stage.total) * 100) : 0}%`;
    track.append(fill);

    row.append(name, count, state, track);
    return row;
  }));
}

import { action, group, row, segmented, toggle } from "./formrow.js";
import { PREFERENCES_CHANGED, announcePreferencesChanged, readHideProbe, writeHideProbe } from "./probevisibility.js";
import { allowFolder, chooseFolder, folderState, folderSupported, forgetFolder } from "./dnxfolder.js";
import { installHelpMarkers } from "./helpmarker.js";
import { readSkipBoot, writeSkipBoot } from "./seen.js";
import { openOverlay, type Overlay } from "./overlay.js";
import { WRITES_DEVICE, gateWriteControls } from "./writeenable.js";

/**
 * The DNX folder's control: the folder's name, and what can be done about it.
 *
 * **Drawn from what the browser says now, not from what was chosen.** Chrome can drop the permission
 * after a restart, and a name shown without saying so reads as a folder that works.
 */
function folderControl(): HTMLElement {
  const holder = document.createElement("span");
  holder.className = "folder-control";
  const shown = document.createElement("span");
  shown.className = "folder-name";
  shown.textContent = "Downloads";
  holder.append(shown);
  if (!folderSupported()) return holder;

  const draw = async (): Promise<void> => {
    const state = await folderState().catch(() => ({ kind: "none" } as const));
    const set = state.kind === "set";
    shown.textContent = set
      ? state.permission === "granted" ? state.name : `${state.name}, needs permission`
      : "Downloads";
    choose.textContent = set ? "Change…" : "Choose…";
    allow.hidden = !set || state.permission === "granted";
    forget.hidden = !set;
  };
  const choose = action("Choose…", () => {
    chooseFolder().then(() => draw(), (error: unknown) => {
      // Closing the picker is an answer, not a failure. Any other refusal says why, an AbortError
      // included: a tab driven through DevTools aborts every picker it intercepts, with its own message.
      const refusal = error as { name?: string; message?: string };
      if (refusal.name === "AbortError" && /user aborted/i.test(refusal.message ?? "")) return;
      shown.textContent = `Not used: ${error instanceof Error ? error.message : String(error)}`;
    });
  });
  const allow = action("Allow", () => { void allowFolder().finally(() => draw()); });
  const forget = action("Forget", () => { void forgetFolder().finally(() => draw()); });
  allow.hidden = true;
  forget.hidden = true;
  holder.append(choose, allow, forget);
  void draw();
  return holder;
}

/* ---- the sheet ----------------------------------------------------------------------------- */

let sheet: Overlay | undefined;

function build(panel: HTMLElement): HTMLElement {
  panel.id = "settings-sheet";

  const header = document.createElement("header");
  const title = document.createElement("h3");
  title.textContent = "Settings";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "sheet-close";
  close.textContent = "Close";
  close.addEventListener("click", () => closeSettings());
  header.append(title, close);
  panel.append(header);

  const note = document.createElement("span");
  note.className = "set-note";

  /*
   * **Hidden until something is running.** A bar sitting at zero on a panel nobody has pressed
   * anything on reads as a thing that is stuck.
   */
  const bar = document.createElement("div");
  bar.className = "set-stages";
  bar.hidden = true;

  /**
   * Both instrument jobs talk to the same device over the same transport, so only one runs.
   *
   * They also share the one bar and the one note below the group, which is the other half of the
   * reason: two jobs writing to one progress area would each report the other's work.
   */
  const instrumentJobs: HTMLButtonElement[] = [];
  const busy = (on: boolean, except?: HTMLButtonElement): void => {
    for (const button of instrumentJobs) {
      if (button !== except) button.disabled = on;
    }
  };
  /** Start a long job: claim the bar, the note and the other button. */
  const startJob = (button: HTMLButtonElement, runner: BackupRunner): void => {
    button.disabled = true;
    busy(true, button);
    bar.hidden = false;
    bar.replaceChildren();
    void runner({
      say: (message) => { note.textContent = message; },
      at: (stages) => drawStages(bar, stages),
    }).finally(() => {
      button.disabled = false;
      busy(false);
    });
  };

  panel.append(group("The instrument", [
    row(
      "Back up the +Drive",
      "Read every project, sound and kit the connected instrument holds into one .dnx file. Empty " +
        "slots are skipped. Nothing on the instrument is changed.",
      (() => {
        const holder = document.createElement("span");
        holder.className = "erase-control";
        const button = action("Back up…", () => {
          if (runBackup) startJob(button, runBackup);
        });
        holder.append(button);
        if (runBackup) {
          instrumentJobs.push(button);
        } else {
          /*
           * **The reason beside the button, never in its `title`.** A disabled button takes no
           * pointer events in Chrome, so its tooltip never appears: before 2026-10-14 this row
           * was a greyed *Back up…* with its reason invisible, and the owner asked why it was
           * disabled. Every page but the probe registers a runner now, so this is the probe's
           * sentence — it holds the MIDI ports its own way, and a second connection underneath it
           * is the one thing this command must not do.
           */
          button.disabled = true;
          const why = document.createElement("span");
          why.className = "why";
          why.textContent =
            "The probe holds the instrument's ports itself. Back up from any other tool.";
          holder.append(why);
        }
        return holder;
      })(),
    ),
    ...[...instrumentCommands.values()].map((command) =>
      row(
        command.title,
        command.description,
        (() => {
          const holder = document.createElement("span");
          holder.className = "erase-control";
          // Read now for the control's state, and read again at the press: the connection can go
          // away while the sheet is open, and the run is the thing that must not be stale.
          const offer = command.offer();
          const button = action(command.label, () => {
            const run = command.offer().run;
            if (run) startJob(button, run);
          });
          button.classList.add("danger");
          button.id = command.id;
          // The register the write switch reads. `openSettings` re-runs `gateWriteControls` once the
          // sheet is in the document, because this element did not exist when the tool row did.
          button.setAttribute(WRITES_DEVICE, "");
          instrumentJobs.push(button);
          holder.append(button);

          if (!offer.run) {
            button.disabled = true;
            /*
             * **Written beside the button, not into its `title`.** A disabled button takes no
             * pointer events in Chrome, so its tooltip never appears, and the reason is the point.
             */
            const why = document.createElement("span");
            why.className = "why";
            why.textContent = offer.unavailable ?? "Connect an instrument in this tool first.";
            holder.append(why);
          }
          return holder;
        })(),
        command.help,
      )),
  ], "backup/backup-contents"));
  /*
   * **The select these two commands choose an instrument with, where the page has none of its
   * own.** `chooseDevice` refuses until somebody picks when two Digitones answer, and a refusal
   * that cannot be acted on is worse than no command at all. It stays hidden until it has
   * options, which is every case but that one.
   */
  if (instrumentSelect) panel.append(instrumentSelect());
  panel.append(bar, note);

  panel.append(group("This application", [
    row(
      "Skip the boot screen",
      "The front page plays DNX starting up. While this is on, opening DNX goes straight to the " +
        "tools.",
      toggle("Skip the boot screen", readSkipBoot(), writeSkipBoot),
    ),
    row(
      "Hide the probe",
      "The probe is for asking an instrument questions when something is wrong. While this is on, it " +
        "stays out of the tool row.",
      (() => {
        const control = toggle("Hide the probe", readHideProbe(), writeHideProbe);
        // Follows Clear, which puts the preference back to its default while the sheet is open.
        const follow = (): void => {
          if (!control.isConnected) { window.removeEventListener(PREFERENCES_CHANGED, follow); return; }
          const input = control.querySelector("input");
          if (input) input.checked = readHideProbe();
        };
        window.addEventListener(PREFERENCES_CHANGED, follow);
        return control;
      })(),
    ),
    row(
      "DNX folder",
      folderSupported()
        ? "Save exports, backups, the copies taken before a write and probe captures straight into a " +
          "folder you choose, each kind in its own subfolder. Until you choose one, files go to your downloads."
        : "Files go to your downloads. Saving into a folder you choose needs Chrome or Edge.",
      folderControl(),
    ),
    row(
      "Motion",
      "Honour your system's reduced-motion setting, or overrule it.",
      segmented(MOTIONS, { system: "System", always: "Always", never: "Never" }, readMotion(),
        writeMotion),
    ),
    row(
      "Stored preferences",
      "The settings on this page, the DNX folder, the panel states, and whether writing is armed. " +
        "Your projects are never stored, and forgetting the folder leaves its files where they are.",
      action("Clear", (button) => {
        button.disabled = true;
        const cleared = clearStored();
        // The folder is kept in IndexedDB, which answers later, so the count waits for it.
        void forgetFolder().catch(() => false).then((forgot) => {
          const total = cleared + (forgot ? 1 : 0);
          button.textContent = total === 0 ? "Nothing stored" : `Cleared ${total}`;
          // Cleared preferences go back to their defaults on this page too, the probe hidden among them.
          announcePreferencesChanged();
        });
      }),
    ),
  ], "settings/settings-rows"));

  const source = document.createElement("a");
  source.className = "act";
  source.href = SOURCE_URL;
  source.target = "_blank";
  source.rel = "noopener";
  source.textContent = "Source";
  panel.append(group("About", [
    row("DNX", "Free software under the AGPL-3.0. Read it, fork it, change it.", source),
  ]));

  return panel;
}

export function openSettings(from?: HTMLElement): void {
  if (sheet) return;
  sheet = openOverlay({
    className: "sheet",
    label: "Settings",
    ...(from === undefined ? {} : { opener: from }),
    // Escape and a click outside close it without going through `closeSettings`, and a stale
    // reference here makes the guard above refuse every later open.
    onClose: () => { sheet = undefined; },
  });
  build(sheet.panel);
  // The sheet's instrument commands write to an instrument and are built here, after the tool row ran
  // its scan. Re-running it is how the switch comes to hold a control that did not exist yet.
  gateWriteControls();
  installHelpMarkers(sheet.panel);
  sheet.panel.querySelector<HTMLElement>("button, a")?.focus();
}

export function closeSettings(): void {
  sheet?.close();
  sheet = undefined;
}

/** True while the sheet is open. Exported for tests and for a caller that must not stack sheets. */
export function settingsOpen(): boolean {
  return sheet?.open === true;
}

/** The link that opens it, rendered into the tool row so every page has one. */
export function renderSettingsLink(container: HTMLElement): HTMLElement {
  const link = document.createElement("button");
  link.type = "button";
  link.className = "settingslink";
  link.textContent = "settings";
  link.title = "Settings for the whole application";
  link.addEventListener("click", () => openSettings(link));
  container.append(link);
  return link;
}
