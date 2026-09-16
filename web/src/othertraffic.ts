/**
 * Noticing that another application is on the instrument's MIDI port.
 *
 * Asked for by the owner: *"we should build an elektron transfer detector so we can show a pop-up
 * to the users when it is running and there might be conflicts."*
 *
 * ## The detector already existed as a constant
 *
 * `messageids.ts` starts this page's ids at **8,192** for one reason, written there:
 * *"Elektron Transfer numbers from the low hundreds, and sharing a port with it is normal on this
 * desk."* So a reply carrying a `respId` below 8,192 **cannot be ours**, by construction rather
 * than by inference. That is a positive signal that something else is talking to the instrument,
 * not a guess made after something failed.
 *
 * It is the same judgement the probe's capture card has made since 2026-07 — *"answers an id we
 * never sent"* — lifted out so every page can make it, and so the wording is written once.
 *
 * ## Why it is worth telling somebody
 *
 * Sharing the port is not cosmetic. It has cost this project three times, each recorded in
 * `KNOWN-ISSUES.md`:
 *
 * - a `/soundbanks/A` listing came back **35 of 256** slots with Transfer running, and a backup
 *   taken like that would have saved part of a bank and called it saved;
 * - a sweep for unknown message codes read Transfer's traffic as the instrument's answers and a
 *   whole line of reasoning was built on it;
 * - two unrelated replies were cut at exactly 885 bytes by Overbridge on the same port.
 *
 * None of those announce themselves. A short warning at the top of the page does.
 *
 * ## What this does not claim
 *
 * It says **another application**, never **Elektron Transfer**, as a fact. Transfer is the one
 * that is usually running and is named as the likely cause, but an old session of DNX in another
 * tab produces the same evidence. Naming the wrong application confidently would send somebody
 * looking in the wrong place.
 */

import { FIRST_MESSAGE_ID } from "./messageids.js";

/** Ids below this belong to somebody else. See `messageids.ts` for why the floor is where it is. */
export const FOREIGN_BELOW = FIRST_MESSAGE_ID;

/**
 * Whether a reply's id is one this page could never have issued.
 *
 * Only the low range is judged. An id at or above the floor that we did not issue is *also* not
 * ours, but proving that needs the allocator's history and the answer is the same either way —
 * so the cheap, certain half is the one used.
 */
export function isForeignReply(respId: number | undefined): boolean {
  return respId !== undefined && respId >= 0 && respId < FOREIGN_BELOW;
}

/** What the page says when it has seen traffic that is not its own. */
export function describeOtherTraffic(count: number): string {
  const replies = count === 1 ? "one reply" : `${count.toLocaleString()} replies`;
  return (
    `Another application is using this instrument's MIDI port. DNX has seen ${replies} answering ` +
    `a request it never sent. **Elektron Transfer or Overbridge is the usual cause**, and the two ` +
    `of them sharing a port with DNX have truncated a directory listing to a third of its length ` +
    `and had one application's traffic read as the other's answer. Close it and read again.`
  );
}

type Listener = (count: number) => void;

let count = 0;
const listeners = new Set<Listener>();

/**
 * Record one incoming reply.
 *
 * Called from the one place every API reply passes through, so no page has to remember to do it.
 * Cheap on purpose: a 12.9 MB project read is about 6,300 replies.
 */
export function noteReply(respId: number | undefined): void {
  if (!isForeignReply(respId)) return;
  count += 1;
  for (const listener of listeners) listener(count);
}

/** How many foreign replies this page has seen. */
export function foreignReplyCount(): number {
  return count;
}

/** True once anything not ours has arrived. */
export function otherTrafficSeen(): boolean {
  return count > 0;
}

/** Hear about foreign traffic. Called immediately when some has already been seen. */
export function onOtherTraffic(listener: Listener): () => void {
  listeners.add(listener);
  if (count > 0) listener(count);
  return () => listeners.delete(listener);
}

/** Forget what has been seen. **Tests only** — a page counts for its whole life. */
export function resetOtherTrafficForTest(): void {
  count = 0;
  listeners.clear();
}

/* ---- saying so ------------------------------------------------------------------------- */

/** Stored when the warning has been dismissed. Per tab, because the port is per tab. */
const DISMISSED = "dnx-other-traffic-dismissed";

/**
 * Put the warning under the tool row, and keep it up to date.
 *
 * **Installed by `renderToolNav`, so every page has it and no page had to be told.** It is a strip
 * rather than a modal: the owner asked for a pop-up, and a modal over a page that may be halfway
 * through a 12.9 MB read would interrupt the very operation the warning is about. This says the
 * same thing without taking the page away, and it can be dismissed.
 *
 * The count keeps rising while the other application talks, which is the useful part: a number
 * that climbs while you watch is the difference between "it happened once" and "it is happening".
 */
export function installOtherTrafficWarning(container: HTMLElement): void {
  let strip: HTMLElement | undefined;
  let countEl: HTMLElement | undefined;

  onOtherTraffic((seen) => {
    try {
      if (sessionStorage.getItem(DISMISSED) === "true") return;
    } catch {
      // Storage off. Showing the warning is the safer failure.
    }
    if (!strip) {
      strip = document.createElement("div");
      strip.className = "othertraffic";
      strip.setAttribute("role", "status");

      const text = document.createElement("p");
      text.className = "othertraffic-say";
      text.innerHTML =
        "<b>Another application is using this instrument's MIDI port.</b> " +
        "Elektron Transfer and Overbridge are the usual causes. Sharing a port has truncated a " +
        "directory listing to a third of its length and had one application's traffic read as the " +
        "other's answer, so close it and read again.";

      countEl = document.createElement("span");
      countEl.className = "othertraffic-count";

      const close = document.createElement("button");
      close.type = "button";
      close.className = "othertraffic-close";
      close.textContent = "Dismiss";
      close.addEventListener("click", () => {
        try {
          sessionStorage.setItem(DISMISSED, "true");
        } catch {
          // Then it comes back on the next reply, which is not the worst outcome for a warning.
        }
        strip?.remove();
        strip = undefined;
      });

      strip.append(text, countEl, close);
      container.append(strip);
    }
    if (countEl) {
      countEl.textContent =
        seen === 1 ? "1 reply to a request DNX never sent" : `${seen.toLocaleString()} replies to requests DNX never sent`;
    }
  });
}
