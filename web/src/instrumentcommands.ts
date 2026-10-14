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
 * with `provideInstrument`; a tool that has already asked the wavetable gate lends that too, so
 * the press does not ask the same question twice.
 */

import { backupJob } from "./backupjob.js";
import { type StatusWriter } from "./statusbar.js";
import { instrumentSelect, reachInstrument } from "./instrument.js";
import { registerBackup, registerInstrumentSelect } from "./settings.js";
import { wireWavetableErase } from "./wavetableerase.js";
import { type WaveriderSupport } from "@noiseandmatter/dnx-core/device/waveridersupport.js";

let lentSupport: (() => WaveriderSupport | undefined) | undefined;

/**
 * Lend the gate's answer, from a tool that has already asked this instrument.
 *
 * Asked at the moment of use rather than stored, so an instrument that has gone takes its answer
 * with it. See the Wavetables mode, which drops its own on a reconnection.
 */
export function provideWaveriderSupport(find: () => WaveriderSupport | undefined): void {
  lentSupport = find;
}

export interface InstrumentCommandsHost {
  /**
   * Where progress goes, on a page that has a status bar.
   *
   * Optional because the front page and the expander have none and the commands are still theirs
   * to offer: the job pane in the sheet carries the same words, and it is the one every page has.
   */
  status?: StatusWriter;
  /** A pane whose listing an erase invalidates, where the page has one. */
  reread?(): Promise<void>;
}

/** Register both commands with the settings sheet. Call once per page. */
export function wireInstrumentCommands(host: InstrumentCommandsHost = {}): void {
  const say: StatusWriter = host.status ?? (() => undefined);

  // So a refusal that says *which of these two instruments* can be acted on inside the sheet.
  registerInstrumentSelect(instrumentSelect);
  registerBackup(
    backupJob({
      device: async () => await reachInstrument((message) => say(message)),
      status: say,
    }),
  );

  wireWavetableErase({
    support: () => lentSupport?.(),
    status: say,
    ...(host.reread ? { reread: host.reread } : {}),
  });
}
