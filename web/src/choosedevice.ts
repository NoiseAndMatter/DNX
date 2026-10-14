/**
 * Connect to the instrument the person meant, on a page where either one is a legitimate subject.
 *
 * Written for the manager, and moved here when the library began connecting a Digitone as well as a
 * Digitone II. Two pages choosing an instrument two ways is how one of them starts guessing again.
 *
 * **A page cannot pick for you and should not pretend to.** The expander can: its two devices have
 * fixed roles, so `connectDevice({ want: DN1 })` says everything. Here either instrument is a
 * subject, and taking whichever answered first was the reported bug: *"I have no way to select what
 * device to load/use."*
 *
 * With one device connected nothing changes: it is found, used, and no picker appears. With two, the
 * picker appears **empty** and this refuses until something is chosen. The empty first option is the
 * point: a select that defaulted to its first entry would quietly reintroduce the guess this exists
 * to remove.
 */

import {
  type ConnectedDevice,
  type DeviceChoice,
  DeviceSourceError,
  connectDevice,
  describeChoice,
  listDevices,
} from "./devicesource.js";
import { isEmulatorPort } from "./devicechoice.js";

export interface DevicePicker {
  /** The select that appears when more than one instrument answers. */
  readonly select: HTMLSelectElement;
  /**
   * The chosen instrument's port, once there has been a choice.
   *
   * Remembered so the choice happens once rather than at every operation. A page clears it when its
   * select changes, which is the only way to move to the other instrument.
   */
  port: string | undefined;
}

export function devicePicker(select: HTMLSelectElement): DevicePicker {
  return { select, port: undefined };
}

/** The instrument to work with: the one chosen, the only one there, or a refusal asking to choose. */
export async function chooseDevice(
  picker: DevicePicker,
  onStatus?: (message: string) => void,
): Promise<ConnectedDevice> {
  const connect = async (port: string): Promise<ConnectedDevice> =>
    await connectDevice({ port, ...(onStatus ? { onStatus } : {}) });

  if (picker.port !== undefined) return await connect(picker.port);

  const found = await listDevices();
  if (found.length === 0) {
    throw new DeviceSourceError(
      "No Digitone answered on any MIDI port pair. Connect it over USB, and check that no other " +
        "application is holding it.",
    );
  }

  /*
   * **The automatic choice is about instruments, not entries.** `listDevices` offers emulator
   * images beside whatever answered on the ports, and they must not change what happens when an
   * instrument is connected: one instrument still wins outright, with however many images listed
   * next to it. The picker is still drawn in that case, showing the instrument as the choice,
   * because taking the emulator deliberately is the whole point of listing it.
   *
   * With no instrument answering and exactly one image, that image is taken — the case the bridge
   * was built for, and refusing it would mean a picker with one option. With several images and no
   * instrument it refuses and asks, because the images are not interchangeable and guessing
   * between them is the mistake `docs/emulator-tests.md` was written about.
   */
  const instruments = found.filter((f) => !isEmulatorPort(f.port));
  const automatic =
    instruments.length === 1
      ? instruments[0]
      : instruments.length === 0 && found.length === 1
        ? found[0]
        : undefined;

  if (found.length > 1) renderDevicePicker(picker, found, automatic?.port);
  if (automatic) {
    picker.port = automatic.port;
    return await connect(picker.port);
  }

  if (!picker.select.value) {
    throw new DeviceSourceError(
      `${found.length} devices are available: ${found.map((f) => f.name).join(", ")}. ` +
        `Choose one from the list and try again.`,
    );
  }
  picker.port = picker.select.value;
  return await connect(picker.port);
}

/**
 * Show the list, and show which entry is in use when one was obvious.
 *
 * `preselect` is only ever the choice the caller is about to make anyway. The empty first option
 * stays the default in every other case, because a select that quietly defaulted to its first
 * entry would reintroduce the guess this control exists to remove.
 */
function renderDevicePicker(picker: DevicePicker, found: DeviceChoice[], preselect?: string): void {
  const { select } = picker;
  const previous = select.value;
  select.hidden = false;
  select.replaceChildren(
    Object.assign(document.createElement("option"), {
      value: "",
      textContent: "— which device? —",
    }),
    ...found.map((f) =>
      Object.assign(document.createElement("option"), {
        value: f.port,
        textContent: describeChoice(f),
      }),
    ),
  );
  // Kept across a re-list, so listing again does not silently move the page to another instrument.
  const keep = found.some((f) => f.port === previous) ? previous : preselect;
  if (keep !== undefined && found.some((f) => f.port === keep)) select.value = keep;
}
