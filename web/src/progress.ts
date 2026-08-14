/**
 * How far through a long operation is — in the status bar, on every page.
 *
 * ## The complaint this answers
 *
 * *"It is ok to see the bytes arriving but userwise it is not clear how far in the task is at."*
 * Exactly right. `8,124,416 bytes…` says the thing is alive; it says nothing about whether that is
 * a quarter of the way or nearly done, and the operations here run for a minute.
 *
 * ## Two modes, because not every load knows its size
 *
 * | | knows the total? |
 * |---|---|
 * | reading the active project, dump by dump | **yes** — the plan is 257 objects |
 * | writing patterns back | **yes** — the changed slots are counted first |
 * | reading a bank's tags | **yes** — the occupied slots are counted first |
 * | reading a file off the +Drive | **no** |
 *
 * That last row is not an oversight. A `DriveProject` reports `allocated`, which is *"a flat 4 MiB
 * on every project, **not** the file's size"* — and a real project is 12.9 MB. The `0x54` open
 * reply's five spare bytes were checked too, in case they declared a length; across captures they
 * read 2,048 and 16, which look like chunk counts against that fixed allocation. **A percentage
 * built on either would sail past 100% and then keep going**, which is worse than no percentage.
 *
 * So `at()` draws a real bar and `working()` draws a moving one that promises nothing. A caller
 * that does not know its total says so rather than guessing.
 *
 * ## Beside the status bar, never inside it
 *
 * It belongs at the foot of the page, because that is where anyone already looks to find out what
 * the tool is doing, and no page needed new markup for it.
 *
 * But **not as a child of `#status`**, which was the first attempt and did not work at all: that
 * element's text is written with `textContent`, which replaces every child it has. The bar was
 * being built and then deleted by the next message about the very operation it was drawing — and
 * since messages arrive throughout a read, it was deleted more or less immediately. `statusbar.ts`
 * is explicit that it owns that element's contents; the mistake was mine for appending into it.
 *
 * So this owns its own fixed element at the foot of the window, right-aligned, clear of the
 * sentence. Nothing it does can disturb the status bar, and nothing the status bar does can
 * disturb it.
 */

export interface Progress {
  /**
   * Draw a real bar.
   *
   * `done` may exceed `total` without breaking anything — a plan that grew mid-run should not also
   * produce a bar wider than its track — but it is clamped rather than hidden, because a bar stuck
   * at 100% while work continues is a question worth someone asking.
   */
  at(done: number, total: number, label: string): void;
  /** Draw a moving bar for work whose size is not known. The label carries whatever is. */
  working(label: string): void;
  /** Put the bar away. Safe to call when nothing is showing. */
  done(): void;
}

/**
 * The page's progress bar.
 *
 * One per page rather than one per operation: two long operations at once is the concurrency
 * hazard `messageids.ts` exists for, and a second bar would be drawing a race rather than
 * reporting one.
 */
export function progressBar(): Progress {
  let bar: HTMLElement | undefined;
  let fill: HTMLElement | undefined;
  let text: HTMLElement | undefined;

  const build = (): void => {
    if (bar) return;

    bar = document.createElement("div");
    bar.className = "progress";
    // Announced, because a bar that only exists visually tells a screen reader nothing about a
    // minute of silence.
    bar.setAttribute("role", "progressbar");

    fill = document.createElement("i");
    text = document.createElement("b");
    bar.append(fill, text);
    // The body, not the status element — see the note above.
    document.body.append(bar);
  };

  return {
    at(done, total, label) {
      build();
      const safe = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
      const percent = Math.round(safe * 100);
      bar!.classList.remove("working");
      bar!.setAttribute("aria-valuenow", String(percent));
      bar!.setAttribute("aria-valuetext", `${percent}% — ${label}`);
      fill!.style.width = `${percent}%`;
      text!.textContent = `${percent}%`;
    },

    working(label) {
      build();
      bar!.classList.add("working");
      bar!.removeAttribute("aria-valuenow");
      bar!.setAttribute("aria-valuetext", label);
      // Cleared rather than left at its last width: a stalled bar that still shows 60% is a claim,
      // and this mode exists precisely because there is nothing to claim.
      fill!.style.width = "";
      text!.textContent = "";
    },

    done() {
      bar?.remove();
      bar = undefined;
      fill = undefined;
      text = undefined;
    },
  };
}

/**
 * Bytes, for a label that has no percentage to offer.
 *
 * Rounded to one decimal above a megabyte, because `8,124,416 bytes` changes every digit twice a
 * second and reads as noise — the point of the number is the sense of scale, not the value.
 */
export function describeBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${bytes} bytes`;
}
