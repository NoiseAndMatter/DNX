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
export async function chooseDevice(picker: DevicePicker): Promise<ConnectedDevice> {
  if (picker.port !== undefined) return await connectDevice({ port: picker.port });

  const found = await listDevices();
  if (found.length === 0) {
    throw new DeviceSourceError(
      "No Digitone answered on any MIDI port pair. Connect it over USB, and check that no other " +
        "application is holding it.",
    );
  }
  if (found.length === 1) {
    picker.port = found[0]!.port;
    return await connectDevice({ port: picker.port });
  }

  renderDevicePicker(picker, found);
  if (!picker.select.value) {
    throw new DeviceSourceError(
      `${found.length} instruments are connected: ${found.map((f) => f.name).join(", ")}. ` +
        `Choose one from the list and try again.`,
    );
  }
  picker.port = picker.select.value;
  return await connectDevice({ port: picker.port });
}

function renderDevicePicker(picker: DevicePicker, found: DeviceChoice[]): void {
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
  if (found.some((f) => f.port === previous)) select.value = previous;
}
