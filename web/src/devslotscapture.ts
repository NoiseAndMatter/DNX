/**
 * The hidden diagnostics capture: a diagnostic build's `/devslots` files, in one zip, in one press.
 *
 * ## Why it exists
 *
 * The firmware side asked for it on 2026-10-29. A reported unit had project copy and paste
 * errors that survived a new project, and the saved state slots are one place that keeps state
 * through that. The probe page reads them, but it is eight paths typed by hand and a folder of
 * loose files. This is the same reads, and one file to send.
 *
 * ## Hidden, not in the menu
 *
 * The rows appear in Settings only when the page's address ends in `#diagnostics`, and a page
 * opened that way opens Settings itself. Somebody we ask to run it gets that address; nobody else
 * meets a control that needs a firmware they do not have.
 *
 * ## What the zip holds, and what it does not
 *
 * `/modinfo/0` and the files asked for, as the unit sent them, and a `manifest.json` with each
 * file's size, SHA-256 and read time. **No project, sound, kit or name from the +Drive.** The
 * working project is inside the slots, but only a block read reaches it, and only the blocks the
 * firmware side named.
 *
 * Read-only: `device/devslots.ts` lists and reads, and the route refuses writes itself.
 */

import {
  BLOCK_SOURCES,
  BLOCKS_PER_SOURCE,
  DEVSLOTS_FILES,
  MAX_BLOCKS_PER_RUN,
  blockFile,
  captureDevslots,
  parseBlockList,
} from "@noiseandmatter/dnx-core/device/devslots.js";
import { type CaptureManifest, packCapture } from "./devslotspack.js";
import { type ConnectedDevice } from "./devicesource.js";
import { claimDevice, deviceJobRefusal } from "./devicejob.js";
import { type DeviceCommandHost } from "./devicecommands.js";
import { saveFile, whereSaved } from "./dnxfolder.js";
import { connectInstrument } from "./instrument.js";
import { pageMessageIds } from "./messageids.js";
import { foreignReplyCount } from "./othertraffic.js";
import { row } from "./formrow.js";
import { settingsRows } from "./devsettings.js";
import {
  type BackupRunner,
  type DiagnosticsJobs,
  closeSettings,
  openSettings,
  registerDiagnostics,
} from "./settings.js";

/** The address fragment that shows the rows. */
export const DIAGNOSTICS_HASH = "#diagnostics";

/** The block box's id, so a test can find it. */
export const BLOCKS_INPUT = "devslotsBlocks";

const PORT_IN_USE =
  "Another application is using the instrument's MIDI port. Close Elektron Transfer and " +
  "Overbridge, then try again.";

/** The job: claim, connect, read, pack, save, and let go of everything on the way out. */
function captureJob(mode: CaptureManifest["mode"], files: () => number[]): BackupRunner {
  return async (report) => {
    let wanted: number[];
    try {
      wanted = files();
    } catch (error) {
      report.say(error instanceof Error ? error.message : String(error));
      return;
    }
    const release = claimDevice("A diagnostics capture");
    if (!release) {
      report.say(deviceJobRefusal());
      return;
    }
    let device: ConnectedDevice | undefined;
    const foreignBefore = foreignReplyCount();
    const total = wanted.length + 1;
    try {
      report.say("Looking for an instrument…");
      device = await connectInstrument((message) => report.say(message));
      report.say("Checking the firmware…");
      const captured = await captureDevslots({
        transport: device.api,
        ids: pageMessageIds,
        files: wanted,
        onFile: (path, index) => {
          report.at([{ kind: "files", done: index, total, state: "reading" }]);
          report.say(`Reading ${path} (${index + 1} of ${total})…`);
        },
      });
      report.at([{ kind: "files", done: total, total, state: "done" }]);
      const packed = await packCapture(captured, device, mode, new Date());
      const saved = await saveFile(
        new Blob([packed.bytes as BlobPart], { type: "application/zip" }),
        packed.name,
        "probe",
      );
      const open = captured.filter((f) => !f.closed).length;
      report.say(
        `Done. Send us this file: ${whereSaved(saved)}` +
          (open > 0
            ? ` The instrument did not confirm ${open} close${open === 1 ? "" : "s"}. Turn it off ` +
              `and on again before you use it.`
            : ""),
      );
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      const foreign = foreignReplyCount() > foreignBefore;
      report.say(foreign ? `${PORT_IN_USE} (${said})` : said);
    } finally {
      device?.close();
      release();
    }
  };
}

function rows(jobs: DiagnosticsJobs): HTMLElement[] {
  const capture = document.createElement("button");
  capture.type = "button";
  capture.className = "act";
  capture.id = "devslotsCapture";
  capture.textContent = "Capture";
  capture.addEventListener("click", () =>
    jobs.start(captureJob("capture", () => DEVSLOTS_FILES.map((f) => f.file))));
  jobs.track(capture);

  const input = document.createElement("input");
  input.type = "text";
  input.id = BLOCKS_INPUT;
  input.placeholder = `${blockFile(0, 0)}, ${blockFile(1, 0)}, ${blockFile(2, 0)}`;
  input.setAttribute("aria-label", "Block numbers");
  input.spellcheck = false;
  const read = document.createElement("button");
  read.type = "button";
  read.className = "act";
  read.id = "devslotsBlocksRead";
  read.textContent = "Read blocks";
  read.addEventListener("click", () =>
    jobs.start(captureJob("blocks", () => parseBlockList(input.value))));
  jobs.track(read);
  const blocks = document.createElement("span");
  blocks.className = "erase-control";
  blocks.append(input, read);

  return [
    row(
      "Capture the saved state",
      "Needs the diagnostics firmware. Reads the saved state files and the firmware record into " +
        "one zip. Nothing on the instrument is changed, and no projects or names are read.",
      capture,
    ),
    row(
      "Read blocks",
      `Type the block numbers we sent you, ${MAX_BLOCKS_PER_RUN} at most. Each is 1000 + source ` +
        `x 256 + block, with source 0 to ${BLOCK_SOURCES.length - 1} and block 0 to ` +
        `${BLOCKS_PER_SOURCE - 1}.`,
      blocks,
    ),
    ...settingsRows(jobs),
  ];
}

/** Registers the rows when the address asks for them, now or later. */
export function wireDevslotsCapture(host: DeviceCommandHost): void {
  // The probe holds the ports itself, and reads these paths by hand already.
  if (host.held !== undefined) return;
  let shown = false;
  const show = (): void => {
    if (shown || location.hash !== DIAGNOSTICS_HASH) return;
    shown = true;
    registerDiagnostics({ rows });
    // A sheet already open was drawn without the rows.
    closeSettings();
    openSettings();
  };
  window.addEventListener("hashchange", show);
  show();
}
