/**
 * The commands that act on the instrument itself, wired once for every page.
 *
 * **The owner's rule, 2026-10-14**: *erasing the wavetables and backing up the device are
 * commands that should be available across the whole app, not depending on what tool you are
 * sitting in.* Before this, each was registered by one tool — the backup by the manager, the
 * erase by the library's Wavetables tab — so the settings sheet showed a disabled *Back up…*
 * beside an enabled *Erase…*, which reads as a page that will empty the region but not save it
 * first.
 *
 * Both now go through `instrument.ts`: the page's own connection where there is one, and a
 * connection of their own where there is not. A page calls this once and lends its instrument
 * with `provideInstrument`.
 *
 * **The backup is DNX's own; everything else is the device library's.** The commands a device
 * adds, such as the Waverider erase, are listed in `devicecommands.ts`, so this file names no
 * device and a fork for other hardware changes only that list.
 */

import { backupJob } from "./backupjob.js";
import { DEVICE_COMMANDS } from "./devicecommands.js";
import { type StatusWriter } from "./statusbar.js";
import { instrumentSelect, reachInstrument } from "./instrument.js";
import { registerBackup, registerInstrumentSelect } from "./settings.js";

export interface InstrumentCommandsHost {
  /**
   * Where progress goes, on a page that has a status bar.
   *
   * Optional because the front page and the expander have none and the commands are still theirs
   * to offer: the job pane in the sheet carries the same words, and it is the one every page has.
   */
  status?: StatusWriter;
  /** A pane whose listing a command invalidates, where the page has one. */
  reread?(): Promise<void>;
  /**
   * Set by a page that holds the instrument's ports itself, as the probe does. The device commands
   * then show this sentence and no backup runner is registered, so nothing opens a second
   * connection underneath the page.
   */
  held?: string;
}

export function wireInstrumentCommands(host: InstrumentCommandsHost = {}): void {
  const say: StatusWriter = host.status ?? (() => undefined);

  if (host.held === undefined) {
    // So a refusal that says *which of these two instruments* can be acted on inside the sheet.
    registerInstrumentSelect(instrumentSelect);
    registerBackup(
      backupJob({
        device: async () => await reachInstrument((message) => say(message)),
        status: say,
      }),
    );
  }

  for (const wire of DEVICE_COMMANDS) {
    wire({
      status: say,
      ...(host.reread ? { reread: host.reread } : {}),
      ...(host.held === undefined ? {} : { held: host.held }),
    });
  }
}
