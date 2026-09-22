/**
 * Nothing reaches an instrument until somebody says so.
 *
 * ## What this is for
 *
 * Every write in this codebase already goes through `safeWriteRecords` or `safeWriteFile`, which
 * back up, confirm, write and read back. That sequence makes a write **correct**. It does not make
 * it **intended**: the confirmation appears after the button is pressed, and by then the person has
 * already decided. A misread label, a stale selection, a click on the wrong row of a grid — the
 * safe-write path handles all of those impeccably and still writes to the instrument.
 *
 * So there is a switch, and it is off. Arming it is a separate act from performing a write, and it
 * cannot be done by accident on the way to something else.
 *
 * ## Two layers, on purpose, and it is the same shape as `WritePermit`
 *
 * `requireWriteEnabled()` is the gate that matters, and it throws before anything sends a byte.
 * **A button that somebody forgot to disable still cannot write.**
 *
 * It reaches the writes two ways. `safeWriteRecords` and `safeWriteFile` take a `gate` as a
 * **required** option, so a caller that forgets one does not compile and a caller that reached
 * them some other way is refused before the transport is touched; this page passes
 * `requireWriteEnabled` as that option, and the core workflows pass their host's copy of it. The
 * probe's two direct dump writes build a message and hand it to `output.send`, with no options
 * object to carry anything, so they call this themselves on the line before.
 *
 * The visual half is the affordance: gated controls go flat and stop accepting clicks. That is what
 * a person actually experiences, and it is the half that is easy to get wrong, because every page
 * already has its own reasons to enable and disable those buttons. So this does not fight that
 * logic — it layers on top of it, and `test/writeenable.test.ts` fails if a control that writes is
 * not registered here.
 *
 * `writepermit.ts` makes the same bet: a type nobody outside one module can construct, plus a test
 * that scans the source for the shortcut. The permit stops the accident; the test stops the
 * workaround. This is that pattern one level up, where the person is.
 *
 * ## Why it survives navigation, and why that was the harder call
 *
 * The four tools are four documents, so a naive implementation disarms every time you move between
 * them. That is safer in the narrow sense and worse in practice: somebody expanding a project in
 * the expander and checking it in the manager would re-arm three or four times in a minute, and a
 * switch you press reflexively is not a decision any more. It would be theatre.
 *
 * So the state lives in `sessionStorage` and survives navigation within one browsing session. It
 * does **not** survive a new tab, a restart, or a reopened browser, because those are the moments
 * where somebody has stopped paying attention. The cost of persistence is somebody forgetting they
 * armed it, which is why the armed state is loud rather than a lit pixel.
 */

const KEY = "dnx.writeEnabled";

/** Thrown by `requireWriteEnabled`. A refusal, not a fault. */
export class WriteDisabled extends Error {
  constructor() {
    super(
      "Writing to the instrument is switched off. Turn on WRITE in the toolbar, then try again. " +
        "Nothing was sent.",
    );
    this.name = "WriteDisabled";
  }
}

let armed = read();
const listeners = new Set<(on: boolean) => void>();

/*
 * **Every browser global here is reached through a guard, so this module imports under Node.**
 * `requireWriteEnabled` is the gate the whole feature rests on, and a gate that can only be
 * exercised by opening a browser is a gate nobody re-checks. The DOM half is still verified by
 * hand; the state machine is verified by `test/writeenable.test.ts` on every run.
 */
const hasDom = typeof document !== "undefined";

function read(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "on";
  } catch {
    // Private mode, storage disabled, or not a browser at all. Off is the answer that cannot hurt
    // anybody.
    return false;
  }
}

/** Whether writes are currently allowed. */
export function isWriteEnabled(): boolean {
  return armed;
}

/** Arm or disarm. Every registered control and every listener is updated. */
export function setWriteEnabled(on: boolean): void {
  armed = on;
  try {
    sessionStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // The switch still works for this page; it simply will not survive navigation.
  }
  for (const listener of listeners) listener(on);
  applyGates();
}

/** Run `listener` on every change, and once now. */
export function onWriteEnableChange(listener: (on: boolean) => void): void {
  listeners.add(listener);
  listener(armed);
}

/**
 * The gate. Call before anything that sends bytes to an instrument.
 *
 * **This is the guarantee, not the disabled button.** A control that a page forgot to register is
 * still stopped here, which is the whole reason the check is not simply `if (button.disabled)`.
 */
export function requireWriteEnabled(): void {
  if (!armed) throw new WriteDisabled();
}

/* ---- the visible half ------------------------------------------------------------------- */

const gated = new Set<HTMLElement>();

/**
 * The attribute a control carries to say it writes to an instrument.
 *
 * **The markup is the register, not a list in a module.** A list has to be kept in step with six
 * controls across three pages by whoever adds the seventh, and the failure is silent: an
 * unregistered button looks armed and behaves armed. Marking the control itself means adding one
 * cannot forget, and `test/writeenable.test.ts` fails when a `btn danger` appears without either
 * this attribute or a documented reason it does not write.
 */
export const WRITES_DEVICE = "data-writes-device";

/**
 * Find and gate every control that writes, plus any extra ids a page builds after load.
 *
 * Ids that are not on the page are ignored rather than thrown over: the four tools share this
 * module and none of them has every control.
 */
export function gateWriteControls(...ids: readonly string[]): void {
  if (!hasDom) return;
  // `forEach` rather than `for..of`: this module is imported by a Node test, and the Node
  // tsconfig's lib has no iterator on `NodeListOf`.
  document.querySelectorAll<HTMLElement>(`[${WRITES_DEVICE}]`).forEach((el) => gated.add(el));
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) gated.add(el);
  }
  applyGates();
}

function applyGates(): void {
  if (!hasDom) return;
  for (const el of gated) {
    el.setAttribute("data-write-gated", armed ? "on" : "off");
    /*
     * `aria-disabled` rather than `disabled`. Each page has its own reasons to disable these — no
     * device open, nothing selected, a slot that cannot be written — and setting the real property
     * here would either be overwritten by that logic on its next pass or overwrite it. The click is
     * stopped below instead, so the two systems never argue about one property.
     */
    el.setAttribute("aria-disabled", armed ? "false" : "true");
    if (!armed) el.setAttribute("title", "Writing is switched off. Turn on WRITE in the toolbar.");
    else if (el.getAttribute("title")?.startsWith("Writing is switched off")) el.removeAttribute("title");
  }
}

/**
 * Swallow clicks on gated controls while disarmed.
 *
 * Capture phase, so it runs before any handler the page bound to the button itself. Without that
 * the page's own listener fires first and the refusal arrives as an error message about something
 * the person is not trying to do.
 */
if (hasDom) document.addEventListener(
  "click",
  (event) => {
    if (armed) return;
    const target = (event.target as HTMLElement | null)?.closest("[data-write-gated]");
    if (!target || target.getAttribute("data-write-gated") !== "off") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    flash(target as HTMLElement);
  },
  true,
);

/** Say why nothing happened, on the control that was pressed and on the switch that stopped it. */
function flash(el: HTMLElement): void {
  for (const target of [el, document.getElementById("writeenable")]) {
    if (!target) continue;
    target.classList.add("write-refused");
    // Long enough to be seen, short enough that a second refusal reads as a second refusal.
    setTimeout(() => target.classList.remove("write-refused"), 900);
  }
}

/** The switch itself. Rendered into the tool row, so it is on every page. */
export function renderWriteEnable(container: HTMLElement): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "writeenable";
  button.className = "writeenable";
  button.addEventListener("click", () => setWriteEnabled(!armed));

  onWriteEnableChange((on) => {
    // The whole page is edged in red while armed. The switch is one control in a row of five, and
    // the state it holds is worth more attention than its own width can buy.
    document.documentElement.classList.toggle("write-armed", on);
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "WRITE ARMED" : "WRITE OFF";
    button.title = on
      ? "The instrument can be written to. Click to switch writing off."
      : "Nothing can reach the instrument. Click to allow writing.";
  });

  container.append(button);
  /*
   * Gating happens here rather than in each page's setup, because every page mounts the tool row
   * and none of them can therefore forget. A page that builds a write control later calls
   * `gateWriteControls` again with its id.
   */
  gateWriteControls();
  return button;
}
