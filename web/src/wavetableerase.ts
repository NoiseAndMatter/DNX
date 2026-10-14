/**
 * Emptying the whole wavetable region, from the settings sheet.
 *
 * ## Why this exists, and why it is in settings rather than in the pane
 *
 * FORMAT +DRIVE and a factory reset never touch `/waverider` or `/wavepool`. So for somebody
 * returning an instrument to how Elektron shipped it — a warranty claim, a sale — there is no way
 * back short of a service-mode tool. It is not a wavetable operation in the sense the pane's other
 * controls are: it acts on the instrument rather than on a table or a project, which is the same
 * thing *Back up the +Drive* does, and that is the row it sits beside.
 *
 * The careful part is `device/wavetableerase.ts`. This is the question, the gate and the reporting.
 *
 * ## It is a two way door, and the door is the DNX folder
 *
 * The owner's condition for it existing at all: *don't, and make it a two way door*. The core
 * honours that by reading every used slot and handing each one to the backup hook **before** the
 * question is asked. But on this page the hook writes a file per table, and a full store is 256 of
 * them — which a browser offering them as downloads refuses somewhere around the tenth, silently.
 *
 * **So the folder is checked before anything is read.** With a DNX folder granted, each copy is
 * written straight to disk and there is no guard to trip; without one, the copies that are the
 * only way back would quietly not exist, which is the exact failure this control must not have.
 * It is checked at the press rather than drawn into the control's state, because permission can be
 * revoked between the sheet opening and the button being pressed, and the check costs nothing.
 *
 * ## Two questions, because they are two decisions
 *
 * This file once argued the opposite — one question, on the grounds that a confirmation before a
 * confirmation teaches people to click through both. The owner overruled it on 2026-10-14, and
 * the reason is sound: **the copying is not part of the erase.** Pressing used to start minutes
 * of reading before anybody was asked anything, and somebody who then cancelled had sat through
 * all of it for nothing.
 *
 * So the press asks first whether to save the copies, naming how many tables there are. That
 * reads and sends nothing, and cancelling it leaves the instrument and the folder untouched. Only
 * when the copies are written does the second question appear — the one that carries the counts
 * the firmware will check, and the one that ends in something being sent.
 */

import { askConfirm } from "./dialog.js";
import { type ConnectedDevice, apiTransport } from "./devicesource.js";
import { reachInstrument } from "./instrument.js";
import { readStoreListing } from "@noiseandmatter/dnx-core/device/wavepoolread.js";
import { folderState, folderSupported } from "./dnxfolder.js";
import { pageMessageIds } from "./messageids.js";
import { downloadBackup } from "./safewriteui.js";
import { type EraseOffer, type JobReport, registerErase } from "./settings.js";
import { type StatusWriter } from "./statusbar.js";
import { requireWriteEnabled } from "./writeenable.js";
import {
  type EraseReview,
  eraseWavetableStore,
} from "@noiseandmatter/dnx-core/device/wavetableerase.js";
import {
  type WaveriderSupport,
  askWaveriderSupport,
} from "@noiseandmatter/dnx-core/device/waveridersupport.js";

export interface WavetableEraseHost {
  /**
   * The gate's answer, when a tool on this page has already asked this instrument.
   *
   * Optional, and only an accelerator: the Wavetables tab asks the gate to draw its panes, so on
   * the library the answer is already in hand. Everywhere else the press asks for itself rather
   * than sending somebody to another tool to unlock a command about their instrument.
   */
  support?(): WaveriderSupport | undefined;
  status: StatusWriter;
  /** A pane holding a listing this has invalidated, where there is one. */
  reread?(): Promise<void>;
}

export function wireWavetableErase(host: WavetableEraseHost): void {
  let erasing = false;

  /**
   * Whether the control may be pressed.
   *
   * **Only what is knowable without speaking to the instrument.** It used to refuse here for a
   * missing device and for every gate state, which made the command the library's: on any other
   * page it was a disabled button, and a disabled button shows no tooltip in Chrome, so it was a
   * disabled button with no reason. The instrument and the gate are now settled at the press,
   * where asking them is allowed and the answer can be said in a sentence.
   */
  function offer(): EraseOffer {
    if (erasing) return { unavailable: "An erase is already running." };
    if (!folderSupported()) {
      return {
        unavailable:
          "Erasing saves a copy of every table first, and saving that many files needs Chrome or Edge.",
      };
    }
    return { run };
  }

  /**
   * What this build says about its wavetable store, asked now unless a tool already knows.
   *
   * Returns the sentence to refuse with, or `undefined` when the erase route is there. Every
   * state sends the reader somewhere different, which is why the whole answer is read rather than
   * its `features`: a stock Digitone II that has answered must not be told nobody has asked.
   */
  async function gateRefusal(device: ConnectedDevice, report: JobReport): Promise<string | undefined> {
    let support = host.support?.();
    if (!support) {
      report.say("Asking this instrument what it can do…");
      support = await askWaveriderSupport({ transport: apiTransport(device), ids: pageMessageIds });
    }
    if (support.state === "unsupported") {
      return "This instrument has no wavetable store, so there is nothing here to erase.";
    }
    if (support.state !== "supported") {
      return (
        "DNX could not find out what this build can do. Close Elektron Transfer and Overbridge, " +
        "then try again."
      );
    }
    if (!support.features.erase) {
      return support.features.capabilitiesKnown
        ? "This firmware does not offer the erase route."
        : "This build predates the capabilities record, so it has never said it has the erase " +
          "route — and silence is not a yes for a control that empties the whole region.";
    }
    return undefined;
  }

  /**
   * The sentences before the region goes.
   *
   * Plain text: `askConfirm` puts every one of these through `textContent`, because the names in
   * them come off somebody's instrument. Nothing here may lean on markup to carry its meaning.
   */
  function questions(review: EraseReview): string[] {
    return [
      `Every wavetable and every pool list on this instrument is removed: ` +
        `${review.tables} table${review.tables === 1 ? "" : "s"} and ` +
        `${review.lists} pool list${review.lists === 1 ? "" : "s"}. The store is shared, so this ` +
        `is every project, not one of them.`,
      review.tables === 0
        ? `Nothing was copied, because there is nothing there. Sending the request anyway is how ` +
          `an erase interrupted partway finishes.`
        : `${review.tables} cop${review.tables === 1 ? "y is" : "ies are"} already saved to your ` +
          `DNX folder, ${review.copied.toLocaleString()} bytes in all. Putting those back is how ` +
          `this is undone — there is no undo on the instrument itself.`,
      /*
       * **The consequence that is not "nothing changes".** A pool is a record on the +Drive, not
       * part of the project file, so no project is edited by this — but a sound's TBL is a number
       * held in the project, and those numbers stay. Saying only that projects are untouched
       * reads as nothing changing for them, which is false for any project that used a wavetable.
       * The firmware contract names this and the first version of this dialog left it out.
       */
      `Your projects, sounds and kits are not in this region and are not touched — a pool is a ` +
        `record on the +Drive rather than part of a project file. What stays behind is the TBL ` +
        `number on each sound: it keeps the value it has, and plays the built-in Prim, because ` +
        `the pool entry it named is gone.`,
      `FORMAT +DRIVE and a factory reset do not reach this region, which is why this exists.`,
      `Run it before putting stock firmware back on. Stock has no route to this, so flashing ` +
        `stock first means flashing Waverider again to erase, and stock again afterwards.`,
      `If anything has been written to the store since this listing was taken, the instrument ` +
        `refuses the whole thing and nothing changes.`,
    ];
  }

  /** The folder, or the sentence saying why this cannot run. Checked before anything is read. */
  async function folderReady(): Promise<string | undefined> {
    const state = await folderState().catch(() => ({ kind: "none" } as const));
    if (state.kind !== "set") {
      return (
        "Choose a DNX folder in Settings first. This saves one copy per table, and a browser " +
        "blocks that many downloads — the copies are the only way back, so it will not run " +
        "without somewhere to put them."
      );
    }
    if (state.permission !== "granted") {
      return `DNX may not write to ${state.name} yet. Press Allow beside the DNX folder above.`;
    }
    return undefined;
  }

  async function run(report: JobReport): Promise<void> {
    if (erasing) return;

    let device: ConnectedDevice;
    try {
      report.say("Looking for an instrument…");
      device = await reachInstrument((message) => report.say(message));
    } catch (error: unknown) {
      // Said rather than returning quietly: a control that does nothing is the one failure
      // somebody cannot act on.
      const gone = String(error instanceof Error ? error.message : error);
      report.say(gone);
      host.status(gone, "warn");
      return;
    }

    const gate = await gateRefusal(device, report).catch(
      (error: unknown) => `DNX could not ask this instrument what it can do: ${String(error)}`,
    );
    if (gate) {
      report.say(gate);
      host.status(gate, "warn");
      return;
    }

    const refusal = await folderReady();
    if (refusal) {
      report.say(refusal);
      host.status(refusal, "warn");
      return;
    }

    /*
     * **The first of the two questions: may DNX save the copies?**
     *
     * The listing is read here rather than taken from the core's own, because the number of
     * tables is what makes this question answerable — *83 tables, a few minutes* is a decision,
     * *this may take a while* is not. It is one message, and the core lists again at the moment
     * of erasing, which is the listing the firmware actually checks against.
     */
    let tables: number;
    try {
      report.say("Counting the tables…");
      const listing = await readStoreListing(apiTransport(device), pageMessageIds);
      tables = listing.filter((slot) => slot.occupied).length;
    } catch (error: unknown) {
      const said = `The store could not be listed, so nothing was done: ${String(error)}`;
      report.say(said);
      host.status(said, "error");
      return;
    }

    const agreed = await askConfirm({
      title:
        tables === 0
          ? "Save copies first? The store is already empty"
          : `Save a copy of ${tables} wavetable${tables === 1 ? "" : "s"} first?`,
      body: [
        tables === 0
          ? `There is nothing to copy. The erase can still be sent, which is how an erase ` +
            `interrupted partway is finished.`
          : `Every one of the ${tables} tables is read off the instrument and written into your ` +
            `DNX folder, one file each. On a full store that is a few minutes.`,
        `Nothing is sent to the instrument by this, and nothing on it changes. You are asked ` +
          `again, with the counts, before anything is erased.`,
        `Those copies are the only way back: putting one of them onto a free slot is how a table ` +
          `comes home.`,
      ],
      confirmLabel: tables === 0 ? "Carry on" : "Save the copies",
    });
    if (!agreed) {
      const said = "Nothing was copied and nothing was sent.";
      report.say(said);
      host.status(said, "info");
      return;
    }

    erasing = true;
    try {
      const result = await eraseWavetableStore({
        transport: apiTransport(device),
        host: {
          ids: pageMessageIds,
          gate: requireWriteEnabled,
          confirm: (review) =>
            askConfirm({
              title:
                review.tables === 0
                  ? "Erase the wavetable region? It is already empty"
                  : `Erase every wavetable on this instrument — ${review.tables} table${
                      review.tables === 1 ? "" : "s"
                    }?`,
              body: questions(review),
              // The names go in the scrolling list rather than a paragraph: this is the part
              // somebody scans for something they did not expect to be in it.
              ...(review.names.length === 0 ? {} : { list: review.names }),
              confirmLabel: "Erase the region",
              danger: true,
            }),
        },
        // No firmware string on purpose: with one, `downloadBackup` wraps a stored file into a
        // project container, and a wavetable slot is not a project. Same as the single delete.
        onBackup: downloadBackup(
          (message) => {
            report.say(message);
            host.status(message, "ok");
          },
          (backup) => `store slot ${backup.slots[0]}`,
        ),
        onStatus: (message) => {
          report.say(message);
          host.status(message);
        },
        onProgress: (done, total) =>
          report.at([
            {
              kind: "tables",
              done,
              total,
              state: total === 0 ? "done" : done === 0 ? "pending" : done < total ? "reading" : "done",
            },
          ]),
        timeoutMs: 120_000,
      });

      if (result.cancelled) {
        const said =
          result.tables === 0
            ? "Cancelled — nothing was sent."
            : `Cancelled — nothing was sent. The ${result.tables} copies are still saved.`;
        report.say(said);
        host.status(said, "warn");
        return;
      }
      if (result.erased) {
        const said =
          `The wavetable region is empty: ${result.tables} table(s) and ${result.lists} pool ` +
          `list(s) gone, read back from the instrument's own listings. The copies are in your ` +
          `DNX folder.`;
        report.say(said);
        host.status(said, "ok");
        return;
      }
      const said = `The region was not erased. ${result.problem ?? "The listings still show it in use."}`;
      report.say(said);
      host.status(said, "error");
    } catch (error: unknown) {
      const said = `The erase failed: ${String(error)}`;
      report.say(said);
      host.status(said, "error");
    } finally {
      erasing = false;
      // Whatever happened, the listing the panes hold is no longer evidence about the instrument.
      await host.reread?.().catch(() => undefined);
    }
  }

  registerErase(offer);
}
