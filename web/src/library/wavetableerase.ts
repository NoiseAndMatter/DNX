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
 * ## One question, asked where the decision is
 *
 * Pressing starts minutes of copying before anybody is asked anything, which would be surprising
 * if the row did not say so — it does. The copying reads and sends nothing, a failure in it
 * abandons the run untouched, and the question that follows carries the counts the firmware will
 * check. There is no second dialog: a confirmation before the confirmation teaches people to click
 * through both.
 */

import { askConfirm } from "../dialog.js";
import { type ConnectedDevice, apiTransport } from "../devicesource.js";
import { folderState, folderSupported } from "../dnxfolder.js";
import { pageMessageIds } from "../messageids.js";
import { downloadBackup } from "../safewriteui.js";
import { type EraseOffer, type JobReport, registerErase } from "../settings.js";
import { type StatusWriter } from "../statusbar.js";
import { requireWriteEnabled } from "../writeenable.js";
import {
  type EraseReview,
  eraseWavetableStore,
} from "@noiseandmatter/dnx-core/device/wavetableerase.js";
import { type WaveriderFeatures } from "@noiseandmatter/dnx-core/device/waveridersupport.js";

export interface WavetableEraseHost {
  /** The instrument, when one is connected. */
  device(): ConnectedDevice | undefined;
  /**
   * What the gate said about this build, or `undefined` when it has not been asked.
   *
   * The two are different answers and the control says so differently: *no instrument* sends you
   * to connect one, *not asked* sends you to the Wavetables tab, and *asked and it cannot* is the
   * end of it.
   */
  features(): WaveriderFeatures | undefined;
  status: StatusWriter;
  /** The panes hold a listing that the erase has just invalidated. */
  reread(): Promise<void>;
}

export function wireWavetableErase(host: WavetableEraseHost): void {
  let erasing = false;

  /**
   * Whether the control may be pressed, worked out from the live state each time it is asked.
   *
   * **Computed on demand rather than pushed.** The sheet reads this when it opens, so there is
   * nothing to keep in step as instruments come and go — and no event for a future caller to
   * forget. The first version registered a snapshot at wiring time and said *connect an
   * instrument first* with one connected.
   */
  function offer(): EraseOffer {
    if (erasing) return { unavailable: "An erase is already running." };
    if (!folderSupported()) {
      return {
        unavailable:
          "Erasing saves a copy of every table first, and saving that many files needs Chrome or Edge.",
      };
    }
    if (!host.device()) return { unavailable: "Connect an instrument in the library first." };

    const features = host.features();
    if (!features) {
      return {
        unavailable: "Open the library's Wavetables tab, so DNX can ask this build what it can do.",
      };
    }
    if (!features.erase) {
      return {
        unavailable: features.capabilitiesKnown
          ? "This firmware does not offer the erase route."
          : "This build predates the capabilities record, so it has never said it has the erase " +
            "route — and silence is not a yes for a control that empties the whole region.",
      };
    }
    return { run };
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
      `Your projects, sounds and kits are not in this region and are not touched. FORMAT +DRIVE ` +
        `and a factory reset do not reach it, which is why this exists.`,
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
    const device = host.device();
    if (!device) {
      /*
       * The offer outlived the connection — the picker was changed, or the port went away, after
       * the sheet was opened. Said rather than returning quietly: a control that does nothing is
       * the one failure somebody cannot act on.
       */
      const gone = "No instrument is connected any more. Connect one in the library and try again.";
      report.say(gone);
      host.status(gone, "warn");
      return;
    }

    const refusal = await folderReady();
    if (refusal) {
      report.say(refusal);
      host.status(refusal, "warn");
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
      await host.reread().catch(() => undefined);
    }
  }

  registerErase(offer);
}
