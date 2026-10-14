/**
 * One instrument, described well enough to choose between two of them.
 *
 * ## Why this is not in `devicesource.ts`
 *
 * That module is MIDI plumbing: ports, sessions, listeners, permissions. This is a value type and
 * the sentence a person reads in a picker — no MIDI, no DOM, no I/O. Two responsibilities, and
 * keeping them together had a concrete cost: `test/devicechoice.test.ts` imports `describeChoice`,
 * which dragged all of `devicesource.ts` into the Node program, where `MIDIInputMap` does not
 * exist. `tsc` reported it and the test suite did not, because `tsx` strips types rather than
 * checking them.
 *
 * So the split is not tidiness. **A description of an instrument should be readable without a
 * browser**, and the moment that stopped being true was the moment the type checker started
 * failing on a file nothing had changed.
 */

/** One instrument found on the ports, described well enough to choose between. */
export interface DeviceChoice {
  /**
   * Dump-protocol product id, so a `ConnectOptions.want` can be built from it.
   *
   * **Absent when nothing has asked the instrument yet.** Every entry found on the MIDI ports has
   * one, because being found there means it answered a `Device` request. An emulator entry does
   * not: booting an image takes half a minute and this list is built before anybody has chosen
   * one, so the only value available would be inferred from the image's filename. Absent is the
   * honest answer, and the real one arrives from the firmware's own reply on open.
   */
  productId?: number;
  /** What the instrument called itself. */
  name: string;
  /**
   * Its MIDI input port.
   *
   * **The only field that separates two of the same model.** Two Digitone IIs on one firmware are
   * identical in every other respect, so a picker that dropped this would be a coin toss with
   * extra steps.
   */
  port: string;
  /**
   * The instrument's firmware string, or **absent when it did not answer**.
   *
   * Left absent rather than filled in, for the same reason `ConnectedDevice` does: a value we made
   * up is the plausible-looking wrong field this codebase keeps paying for.
   */
  firmwareVersion?: string;
}

/**
 * What marks a choice as the emulator rather than something on the MIDI ports.
 *
 * A prefix on `port` rather than a new field, because `port` is already the thing that addresses
 * one instrument and both pages carry it around for exactly that purpose. Here rather than in
 * `emulatorsource.ts` so that this module — which needs no browser — can tell the two apart
 * without importing one.
 */
export const EMULATOR_PREFIX = "emulator:";

/** True when a chosen port names an emulator image instead of a MIDI port. */
export function isEmulatorPort(port: string | undefined): boolean {
  return port !== undefined && port.startsWith(EMULATOR_PREFIX);
}

/**
 * One line naming an instrument, for a picker.
 *
 * The port disambiguates two of the same model, so it is shown — except for an emulator, whose
 * port is an internal key and whose name already says which image it is. Printing it there would
 * add `emulator:waverider` after a line that has just said waverider.
 */
export function describeChoice(choice: DeviceChoice): string {
  const port = isEmulatorPort(choice.port) ? "" : choice.port;
  return (
    `${choice.name}${choice.firmwareVersion ? ` · ${choice.firmwareVersion}` : ""}` +
    `${port ? ` · ${port}` : ""}`
  );
}
