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
export const SOURCE_URL = "https://github.com/angellinares/DNX";

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
export type BackupRunner = (report: (message: string) => void) => Promise<void>;

let runBackup: BackupRunner | undefined;

/** Called by a page that can reach an instrument. */
export function registerBackup(runner: BackupRunner): void {
  runBackup = runner;
}

/* ---- the sheet ----------------------------------------------------------------------------- */

let sheet: HTMLElement | undefined;
let scrim: HTMLElement | undefined;
let opener: HTMLElement | undefined;

function row(name: string, description: string, control: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = "set-row";
  const label = document.createElement("span");
  label.className = "label";
  const title = document.createElement("b");
  title.textContent = name;
  const why = document.createElement("span");
  why.textContent = description;
  label.append(title, why);
  const holder = document.createElement("span");
  holder.className = "control";
  holder.append(control);
  el.append(label, holder);
  return el;
}

function segmented<T extends string>(
  options: readonly T[], labels: Record<T, string>, current: T, onPick: (value: T) => void,
): HTMLElement {
  const group = document.createElement("span");
  group.className = "seg";
  group.setAttribute("role", "group");
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = labels[option];
    button.setAttribute("aria-pressed", String(option === current));
    button.addEventListener("click", () => {
      // `forEach` rather than `for..of`: a Node test imports this module, and the Node tsconfig's
      // lib has no iterator on `NodeListOf`.
      group.querySelectorAll("button").forEach((other) => {
        other.setAttribute("aria-pressed", String(other === button));
      });
      onPick(option);
    });
    group.append(button);
  }
  return group;
}

function action(label: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "act";
  button.textContent = label;
  button.addEventListener("click", () => onClick(button));
  return button;
}

function group(title: string, rows: readonly HTMLElement[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "set-group";
  const heading = document.createElement("h4");
  heading.textContent = title;
  section.append(heading, ...rows);
  return section;
}

function build(): HTMLElement {
  const panel = document.createElement("aside");
  panel.className = "sheet";
  panel.id = "settings-sheet";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Settings");

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
  panel.append(group("The instrument", [
    row(
      "Back up the +Drive",
      "Read every project, sound and kit off the connected instrument into one .dnx file. Empty " +
        "slots are skipped. Nothing on the instrument is changed.",
      runBackup
        ? action("Back up…", (button) => {
            button.disabled = true;
            const say = (message: string): void => { note.textContent = message; };
            void runBackup!(say).finally(() => { button.disabled = false; });
          })
        : (() => {
            const disabled = action("Back up…", () => {});
            disabled.disabled = true;
            disabled.title = "Open the manager to reach an instrument";
            return disabled;
          })(),
    ),
  ]));
  panel.append(note);

  panel.append(group("This application", [
    row(
      "Motion",
      "Honour your system's reduced-motion setting, or overrule it.",
      segmented(MOTIONS, { system: "System", always: "Always", never: "Never" }, readMotion(),
        writeMotion),
    ),
    row(
      "Stored preferences",
      "The settings on this page, the panel states, and whether writing is armed. Your projects " +
        "are never stored.",
      action("Clear", (button) => {
        const cleared = clearStored();
        button.textContent = cleared === 0 ? "Nothing stored" : `Cleared ${cleared}`;
        button.disabled = true;
      }),
    ),
  ]));

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

/** Close on Escape, from anywhere, because a sheet you cannot dismiss by reflex is a trap. */
function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") closeSettings();
}

export function openSettings(from?: HTMLElement): void {
  if (sheet) return;
  opener = from;

  scrim = document.createElement("div");
  scrim.className = "sheet-scrim";
  scrim.addEventListener("click", () => closeSettings());

  sheet = build();
  document.body.append(scrim, sheet);
  document.addEventListener("keydown", onKey);
  sheet.querySelector<HTMLElement>("button, a")?.focus();
}

export function closeSettings(): void {
  document.removeEventListener("keydown", onKey);
  sheet?.remove();
  scrim?.remove();
  sheet = undefined;
  scrim = undefined;
  // Focus goes back where it came from. Dropping it to the document start makes the next Tab feel
  // like a different page.
  opener?.focus();
  opener = undefined;
}

/** True while the sheet is open. Exported for tests and for a caller that must not stack sheets. */
export function settingsOpen(): boolean {
  return sheet !== undefined;
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
