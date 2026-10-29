/**
 * The commands the device library adds to every page's settings sheet.
 *
 * **The one place the shell names a device command.** `instrumentcommands.ts` wires DNX's own
 * backup and then each entry here. A fork for other hardware edits this list; no shared module
 * changes. Each entry registers itself with `registerInstrumentCommand` in `settings.ts`.
 */

import { type StatusWriter } from "./statusbar.js";
import { wireDevslotsCapture } from "./devslotscapture.js";
import { wireWavetableErase } from "./wavetableerase.js";

export interface DeviceCommandHost {
  status: StatusWriter;
  /** A pane whose listing the command invalidates, where the page has one. */
  reread?(): Promise<void>;
  /** The page holds the ports itself. The command shows this sentence and cannot run. */
  held?: string;
}

export const DEVICE_COMMANDS: readonly ((host: DeviceCommandHost) => void)[] = [
  wireWavetableErase,
  wireDevslotsCapture,
];
