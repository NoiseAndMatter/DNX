/**
 * A page's explanation of itself, kept out of its layout.
 *
 * ## The fault this exists to fix
 *
 * The probe opened with a 1,109-character paragraph sitting between the controls and the results.
 * It was good prose and every sentence of it was earned — which is exactly why it grew, and why
 * nobody deleted any of it. The cost was paid by the results:
 *
 * | window        | results visible | the paragraph's share |
 * |---------------|-----------------|-----------------------|
 * | 1600 x 876    | 360px           | 30%                   |
 * | 1280 x 800    | —               | 41%                   |
 * | 900 x 800     | 0px, off screen | 95%                   |
 *
 * And it is not sticky. It scrolls away after 188px, so it taxes the one screenful you most want
 * and is then gone if you actually wanted to read it — the worst of both arrangements. The next
 * longest paragraph anywhere in DNX is 81 characters; this one was 13.7 times that.
 *
 * ## Why a dialog and not `<details>`
 *
 * `<details>` was the cheaper answer and it is the wrong one twice over. Collapsed, it still holds
 * a line of the layout the results need; open, it pushes them down exactly as before — the reported
 * complaint, deferred rather than fixed. And it stays one blob, when the text is really eight
 * sentences about three different groups of controls.
 *
 * A `?` on each card's heading attaches each explanation to the thing it explains, and the modal
 * costs the layout nothing at all: measured at +2px on the controls band.
 *
 * ## The contract
 *
 * - A page carries `<template id="help">` holding one `<section data-topic="…">` per topic.
 * - Anything with `data-help="<topic>"` gets a `?` appended, opening the dialog at that topic.
 * - `dnx.css` styles `dialog.help` and `.helpq`.
 *
 * The pairing between `data-help` and `data-topic` is the kind that fails silently — a renamed
 * topic gives a `?` that opens on nothing — so `test/web.test.ts` checks both directions.
 *
 * Nothing is deleted by moving here. Help that is shorter for being hidden is help that was
 * rewritten, and the rewriting is where the accuracy goes.
 */

/** Set while a dialog is open, so closing can put focus back where the user left it. */
let opener: HTMLElement | undefined;

/**
 * Give every `[data-help]` on the page a `?`, opening one shared dialog built from `template`.
 *
 * The dialog is built once on first press rather than at load: a page that is never asked for help
 * should not pay for it, and the template is inert markup until it is cloned.
 */
export function installHelp(template: HTMLTemplateElement, title: string): void {
  let dialog: HTMLDialogElement | undefined;

  const build = (): HTMLDialogElement => {
    const built = document.createElement("dialog");
    built.className = "help";

    const body = document.createElement("div");
    body.className = "helpbody";

    const heading = document.createElement("h2");
    heading.textContent = title;
    body.append(heading, template.content.cloneNode(true));

    // `method="dialog"` closes natively, so the button works with no listener and Escape already
    // does the same thing. A close handler we own would be a second way to close, and the two
    // would have to agree forever.
    const form = document.createElement("form");
    form.method = "dialog";
    form.className = "helpclose";
    const close = document.createElement("button");
    close.className = "btn";
    close.textContent = "Close";
    form.append(close);
    body.append(form);

    built.append(body);

    // The dialog element's own box is the whole viewport-centred backdrop area only in the sense
    // that clicks landing on it are outside `.helpbody` — which is why `.helpbody` carries all the
    // padding. With padding on the dialog, a click just inside its edge would read as a backdrop
    // click and close a panel the user was aiming at.
    built.addEventListener("click", (event) => {
      if (event.target === built) built.close();
    });

    // **The browser does not restore focus for us.** Measured: after `close()` the active element
    // was `BODY`, so a keyboard user who opened help was returned to the top of the document
    // rather than to the control they were asking about.
    built.addEventListener("close", () => {
      opener?.focus();
      opener = undefined;
    });

    document.body.append(built);
    return built;
  };

  for (const host of document.querySelectorAll<HTMLElement>("[data-help]")) {
    const topic = host.dataset["help"];
    if (!topic) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "helpq";
    button.textContent = "?";
    // The heading's own words, so the label says which help this is rather than just "help".
    const about = (host.textContent ?? "").trim();
    button.setAttribute("aria-label", `What these controls do: ${about}`);
    button.title = `What these controls do: ${about}`;
    button.setAttribute("aria-haspopup", "dialog");

    button.addEventListener("click", () => {
      dialog ??= build();
      show(dialog, topic);
      opener = button;
    });

    host.append(button);
  }
}

/** Open at one topic, marked and scrolled to, without hiding the rest. */
function show(dialog: HTMLDialogElement, topic: string): void {
  // Marked rather than filtered. Somebody who presses `?` on the writing card is asking about
  // writing, and should land there — but the sentence they actually need may be one card over,
  // and a panel that showed one topic at a time would hide it.
  for (const section of dialog.querySelectorAll<HTMLElement>("[data-topic]")) {
    section.toggleAttribute("data-current", section.dataset["topic"] === topic);
  }

  dialog.showModal();
  dialog.querySelector("[data-current]")?.scrollIntoView({ block: "start" });
}
