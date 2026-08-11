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
  /** Dump-protocol product id, so a `ConnectOptions.want` can be built from it. */
  productId: number;
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

/** One line naming an instrument, for a picker. The port disambiguates, so it is always shown. */
export function describeChoice(choice: DeviceChoice): string {
  return (
    `${choice.name}${choice.firmwareVersion ? ` · ${choice.firmwareVersion}` : ""}` +
    `${choice.port ? ` · ${choice.port}` : ""}`
  );
}
