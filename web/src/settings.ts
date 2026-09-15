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
  local: [MOTION_KEY],
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
export interface BackupReport {
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

export type BackupRunner = (report: BackupReport) => Promise<void>;

let runBackup: BackupRunner | undefined;

/** Called by a page that can reach an instrument. */
export function registerBackup(runner: BackupRunner): void {
  runBackup = runner;
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

import { action, group, row, segmented } from "./formrow.js";
import { allowFolder, chooseFolder, folderState, folderSupported, forgetFolder } from "./dnxfolder.js";
import { installHelpMarkers } from "./helpmarker.js";
import { openOverlay, type Overlay } from "./overlay.js";

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
  panel.append(group("The instrument", [
    row(
      "Back up the +Drive",
      "Read every project, sound and kit the connected instrument holds into one .dnx file. Empty " +
        "slots are skipped. Nothing on the instrument is changed.",
      runBackup
        ? action("Back up…", (button) => {
            button.disabled = true;
            bar.hidden = false;
            bar.replaceChildren();
            void runBackup!({
              say: (message) => { note.textContent = message; },
              at: (stages) => drawStages(bar, stages),
            }).finally(() => { button.disabled = false; });
          })
        : (() => {
            const disabled = action("Back up…", () => {});
            disabled.disabled = true;
            disabled.title = "Open the manager to reach an instrument";
            return disabled;
          })(),
    ),
  ], "backup/backup-contents"));
  panel.append(bar, note);

  panel.append(group("This application", [
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
