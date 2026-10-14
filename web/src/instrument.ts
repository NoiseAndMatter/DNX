/**
 * Reaching an instrument from anywhere in DNX, not only from the tool that owns a port picker.
 *
 * ## Why this exists
 *
 * The settings sheet is shared by every page, and the two commands in it that act on the
 * instrument — *Back up the +Drive* and *Erase the wavetable region* — were each wired by one
 * tool. So the backup worked on the manager and nowhere else, and the erase only after the
 * library's Wavetables tab had asked the gate. The owner met both on 2026-10-14, a disabled
 * *Back up…* sitting beside an enabled *Erase…*, and ruled: **whatever tool is selected, these
 * are available as long as an instrument is connected.**
 *
 * ## The page's connection first, always
 *
 * A page that already holds a connection lends it, because the +Drive takes one conversation at a
 * time and a second connection to the same port is the bug in `read-and-write-need-separate-
 * sessions` wearing a different hat. Only when no page offers one does this connect on its own,
 * through the same `chooseDevice` every tool uses — so two Digitones are handled the one way, and
 * the select it needs is mounted in the sheet rather than left detached where nobody could reach
 * it.
 *
 * **Not yet: asking which instrument when two are connected.** The owner wants that, and deferred
 * it to its own PR on 2026-10-14 as not blocking the alpha. Until then two instruments mean the
 * page's own choice, or a refusal naming them.
 */

import { type ConnectedDevice } from "./devicesource.js";
import { type DevicePicker, chooseDevice, devicePicker } from "./choosedevice.js";

let lend: (() => ConnectedDevice | undefined | Promise<ConnectedDevice>) | undefined;
let own: DevicePicker | undefined;

/**
 * Lend the application the instrument this page is working with.
 *
 * Called by a tool that connects: the function is asked at the moment of use, never cached, so a
 * reconnection or a different instrument is picked up without anything being pushed here. A page
 * that has not connected yet lends its own choosing, so two instruments are chosen once, in the
 * tool's own select.
 */
export function provideInstrument(
  find: () => ConnectedDevice | undefined | Promise<ConnectedDevice>,
): void {
  lend = find;
}

/**
 * The select the sheet mounts, so a refusal that says *choose which instrument* can be acted on.
 *
 * One element for the life of the page: `chooseDevice` fills it and remembers the choice on the
 * picker beside it, and a second select would be a second memory of which instrument this is.
 */
export function instrumentSelect(): HTMLSelectElement {
  own ??= devicePicker(document.createElement("select"));
  own.select.hidden = own.select.options.length === 0;
  own.select.title = "Which connected instrument these commands work with";
  return own.select;
}

/** The instrument to act on: the page's, or one this connects to. Throws with the reason. */
export async function reachInstrument(onStatus?: (message: string) => void): Promise<ConnectedDevice> {
  const lent = await lend?.();
  if (lent) return lent;
  instrumentSelect();
  const found = await chooseDevice(own!, onStatus);
  own!.select.hidden = own!.select.options.length === 0;
  return found;
}
