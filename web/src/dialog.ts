/**
 * Asking the person at the instrument something, in the app's own language.
 *
 * ## The fault this exists to fix
 *
 * Every question DNX asked was a `window.confirm` — twelve of them across the four tools. Three
 * separate costs, and only the first is cosmetic:
 *
 * 1. **It is not the app.** A Chrome-chrome box quoting `\n\n`-joined text appears over a dark
 *    panelled interface that has its own buttons, its own type and its own idea of what a warning
 *    looks like. The tool row exists so the four pages read as one app; a native box undoes that
 *    at exactly the moment the user is being asked to commit to something.
 * 2. **It blocks the renderer, and the debugger with it.** A page waiting on `confirm` is
 *    indistinguishable from a hung page — no paint, no timers, and CDP itself stops answering. On
 *    2026-08-12 that cost an hour and was solved only when the user sent a screenshot. Anything
 *    that can look like a hang, on a tool whose long operations genuinely take minutes, is a bad
 *    trade for a free dialog.
 * 3. **It cannot say anything.** `confirm` takes one string. The questions here have shape — a
 *    list of tracks about to be destroyed, a plan with per-track findings, a byte count — and all
 *    of it had to be flattened into a paragraph with newlines in it.
 *
 * ## Why `<dialog>` and not a div
 *
 * `showModal()` gives the focus trap, the inert background, the `::backdrop` and Escape-to-cancel
 * for nothing. Writing those by hand is how a modal ends up keyboard-reachable from behind.
 *
 * **Escape means no; a click on the backdrop means nothing at all.**
 *
 * Safety is not the reason — dismissing is already safe by construction, since `returnValue` is
 * `""` unless a button set it and every non-deliberate path resolves `false`. There is no
 * dismissal that means yes, and there never was.
 *
 * The reason is that **the dialog carries the information the decision is made from**. The
 * manager's destroy question lists the patterns about to be lost; the library's lists what a kit
 * would change on each of sixteen tracks. Reported the first time somebody used one: *"there was
 * a confirmation dialogue to destroy some info. I clicked outside it and it went away."* Nothing
 * was destroyed, and that is not the cost — the cost is that reading it again means performing
 * the whole operation again, and a scrolling list invites exactly the stray click that loses it.
 *
 * So light dismiss is off. `showModal()` already leaves it off in Chrome unless `closedby="any"`
 * asks for it; the earlier version turned it on by hand with a click listener, which is what the
 * user hit. Escape and Cancel remain, which is two ways out of a modal that never traps anyone.
 *
 * **`help.ts` keeps its backdrop click, deliberately.** Help holds no decision and no state, so
 * dismissing it costs a reader nothing and the convenience is real. The rule is not "modals do
 * not light-dismiss" — it is that a panel you can lose by accident must not be one you were
 * reading in order to answer something.
 *
 * ## The dangerous button is not the default one
 *
 * When `danger` is set the **cancel** button takes focus, so a stray Enter on a dialog that just
 * appeared does nothing. `window.confirm` focuses OK, which is the wrong default for a question
 * like "this destroys work that cannot be recovered".
 *
 * ## Text is text
 *
 * Every string here reaches the DOM through `textContent`, never `innerHTML`. The bodies carry
 * pattern names, preset names and file names — all of it data from a project file or a disk, none
 * of it ours, and a preset called `<img onerror=…>` is a preset somebody is allowed to make.
 */

/** What both kinds of question share. */
interface AskCommon {
  /** The one-line question, shown as the dialog's heading. */
  title: string;
  /** Paragraphs of explanation. Each becomes a `<p>`; none of it is parsed as HTML. */
  body?: readonly string[];
  /**
   * Itemised detail — the tracks that would be destroyed, the findings of a plan.
   *
   * Separate from `body` because these are the part somebody scans rather than reads, and because
   * a long one has to be allowed to scroll while the question and the buttons stay put.
   */
  list?: readonly string[];
  /** The dismissive button. Defaults to "Cancel". */
  cancelLabel?: string;
}

export interface ConfirmOptions extends AskCommon {
  /** The affirmative button. Name the action — "Write", "Replace" — never "OK". */
  confirmLabel: string;
  /** Marks the affirmative button destructive and moves initial focus to cancel. */
  danger?: boolean;
}

export interface TextOptions extends AskCommon {
  /** Prefilled, and selected on open so typing replaces it. */
  value?: string;
  maxLength?: number;
  placeholder?: string;
  confirmLabel?: string;
}

/**
 * Ask a yes/no question. Resolves `false` for every kind of dismissal.
 *
 * Never rejects: a caller writing `if (await askConfirm(…))` should not need a `try`.
 */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const { dialog, body } = frame(options);

    const form = document.createElement("form");
    form.method = "dialog";

    const row = document.createElement("div");
    row.className = "askbuttons";

    const cancel = cancelButton(options.cancelLabel ?? "Cancel", dialog);
    const confirm = button(options.confirmLabel);
    confirm.classList.add(options.danger ? "danger" : "primary");

    // Cancel first in the DOM so it is first in the tab order, and visually left of the action.
    row.append(cancel, confirm);
    form.append(row);
    body.append(form);

    open(dialog, () => resolve(dialog.returnValue === "confirm"));
    (options.danger ? cancel : confirm).focus();
  });
}

/**
 * Ask for a line of text. Resolves `undefined` if dismissed — **not** `""`, which is a legitimate
 * answer for a name and is exactly what the device stores when you clear one.
 */
export function askText(options: TextOptions): Promise<string | undefined> {
  return new Promise((resolve) => {
    const { dialog, body } = frame(options);

    const form = document.createElement("form");
    form.method = "dialog";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "askinput";
    input.value = options.value ?? "";
    if (options.maxLength !== undefined) input.maxLength = options.maxLength;
    if (options.placeholder !== undefined) input.placeholder = options.placeholder;

    const row = document.createElement("div");
    row.className = "askbuttons";
    const cancel = cancelButton(options.cancelLabel ?? "Cancel", dialog);
    const confirm = button(options.confirmLabel ?? "OK");
    confirm.classList.add("primary");
    row.append(cancel, confirm);

    // **The input goes inside the form.** It did not, the first time — it was a sibling of the
    // button row — and pressing Enter in the box did nothing at all, because implicit submission
    // needs the field to be *in* the form it submits. `prompt()` accepts Enter, so a replacement
    // that silently does not is a downgrade nobody would report as a bug; they would just click.
    form.append(input, row);
    body.append(form);

    open(dialog, () => resolve(dialog.returnValue === "confirm" ? input.value : undefined));

    input.focus();
    input.select();
  });
}

/** The dialog, its heading, its prose and its list — everything above the buttons. */
function frame(options: AskCommon): { dialog: HTMLDialogElement; body: HTMLElement } {
  const dialog = document.createElement("dialog");
  dialog.className = "ask";

  const body = document.createElement("div");
  body.className = "askbody";

  const heading = document.createElement("h2");
  heading.textContent = options.title;
  body.append(heading);

  for (const paragraph of options.body ?? []) {
    const p = document.createElement("p");
    p.textContent = paragraph;
    body.append(p);
  }

  if (options.list && options.list.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "asklist";
    for (const item of options.list) {
      const li = document.createElement("li");
      li.textContent = item;
      ul.append(li);
    }
    body.append(ul);
  }

  dialog.append(body);
  return { dialog, body };
}

/**
 * The affirmative button — and **the only submit button in the form**, deliberately.
 *
 * Implicit submission activates the first submit button in tree order, so a cancel button that
 * also submitted would make Enter mean *no* in `askText`, where focus sits in the box and Enter is
 * the obvious way to accept a name. Leaving exactly one submit button means Enter can only ever
 * mean yes, without ordering the DOM against the tab order to arrange it.
 */
function button(label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "submit";
  element.className = "btn";
  element.value = "confirm";
  element.textContent = label;
  return element;
}

/**
 * The dismissive button, which closes without setting `returnValue`.
 *
 * `type="button"` keeps it out of implicit submission, and closing with no argument leaves
 * `returnValue` as `""` — the same state Escape produces, so both dismissals settle identically
 * and there is only one "no" to reason about.
 */
function cancelButton(label: string, dialog: HTMLDialogElement): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "btn";
  element.textContent = label;
  element.addEventListener("click", () => dialog.close());
  return element;
}

/**
 * Show it, and undo everything when it closes.
 *
 * **The browser does not put focus back.** `help.ts` measured the same thing: after `close()` the
 * active element is `BODY`, so somebody who answered a question with the keyboard was returned to
 * the top of the document rather than to the button they pressed. Captured before `showModal`,
 * because after it the active element is already inside the dialog.
 */
function open(dialog: HTMLDialogElement, settle: () => void): void {
  const opener = document.activeElement;

  // **Stated rather than left to the default.** `showModal()` does not light-dismiss unless
  // `closedby="any"` asks for it, so this line changes nothing today — and that is the point: it
  // makes the absence of backdrop dismissal a decision in the source, where the header explains
  // it, instead of a browser default that a future `closedby` could quietly reverse.
  //
  // Set as an attribute because the `closedBy` **property** is not in TypeScript's DOM library
  // yet, though Chrome implements both — measured, `"closedBy" in document.createElement("dialog")`
  // is true. The attribute is the same switch without a cast asserting a type we would be inventing.
  dialog.setAttribute("closedby", "closerequest");

  dialog.addEventListener("close", () => {
    // Settle first: the caller's continuation is what the user is waiting for, and removing the
    // element is bookkeeping.
    settle();
    dialog.remove();
    if (opener instanceof HTMLElement) opener.focus();
  });

  document.body.append(dialog);
  dialog.showModal();
}
