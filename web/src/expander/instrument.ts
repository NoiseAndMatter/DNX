/**
 * The Digitone II this page talks to: the connection, its +Drive listing, and the two reads that
 * can produce a destination.
 *
 * ## The mirror of `source.ts`, and it has to be a separate one
 *
 * Two connections at once, on the same page, doing opposite jobs. One shared field would make
 * "connect" mean whichever button was pressed last — and the failure would be silent, because both
 * roles look identical until something is written. So the Digitone 1 has `Source` and the Digitone
 * II has this, and neither can be mistaken for the other.
 *
 * Each is asked for **by name**. With both instruments plugged in — which is this page's whole
 * premise — "the best-named port pair" is a coin toss, and vetting afterwards would reject the one
 * that happened to be enumerated first rather than the wrong one.
 *
 * ## Two reads, and they are not interchangeable
 *
 * | | reads | donor | can the result be written back? |
 * |---|---|---|---|
 * | `readActive` | the project loaded on the instrument | needed — a dump omits ~0.49% | **yes** |
 * | `openSlot` | any of the 128 stored projects | none — every byte is there | no |
 *
 * `readActive` returns a `handle`, and that handle is the only thing that makes a destination
 * writable. `openSlot` returns none, deliberately: a write goes to whatever is *loaded*, so edits
 * meant for slot 47 would land in slot 3. See `destination.ts` — the capability is the handle's
 * presence, not a flag anybody sets.
 *
 * ## What it does not own
 *
 * The DOM, and the bytes a plan produced. Those belong to `main.ts` and to planning respectively —
 * the image waiting to be written is not a property of the instrument, and calling it `device.image`
 * was what made that easy to forget.
 */

import {
  type ConnectedDevice,
  type DeviceProjectHandle,
  DeviceSourceError,
  connectDevice,
  listDeviceProjects,
  openDeviceProject,
  readProject,
  writeBack,
} from "../devicesource.js";
import { type DriveProject } from "../../../src/device/drive.js";
import { deviceFor } from "../../../src/librarian/device.js";
import { ProductId } from "../../../src/sysex/devices.js";

export interface InstrumentHooks {
  /** Progress and news, in the words the status bar should show. */
  onStatus(message: string): void;
}

/** What a stored project came back as, ready for `Destination.fill`. */
export interface StoredProject {
  image: Uint8Array;
  label: string;
  slot: number;
}

/** What the active project came back as. The `handle` is what makes it writable. */
export interface ActiveProject {
  image: Uint8Array;
  handle: DeviceProjectHandle;
  name: string;
}

export class Instrument {
  #connected: ConnectedDevice | undefined;
  #projects: DriveProject[] | undefined;

  constructor(private readonly hooks: InstrumentHooks) {}

  get connected(): boolean {
    return this.#connected !== undefined;
  }

  get name(): string | undefined {
    return this.#connected?.name;
  }

  async connect(): Promise<string> {
    this.hooks.onStatus("Looking for a Digitone II…");
    this.#connected = await connectDevice({ want: ProductId.DN2 });
    // A new instrument invalidates the old listing rather than merging with it.
    this.#projects = undefined;
    return this.#connected.name;
  }

  /** List the stored projects, so one of them can become the destination. */
  async listProjects(): Promise<DriveProject[]> {
    const connected = this.#required();
    this.hooks.onStatus(`Listing projects on ${connected.name}…`);
    this.#projects = await listDeviceProjects(connected);
    return this.#projects;
  }

  /**
   * Read one stored project off the +Drive.
   *
   * No donor: the stored file is complete, which is what makes this the cheaper route. And no
   * handle, which is what stops the result being written back to the wrong place.
   */
  async openSlot(index: number): Promise<StoredProject> {
    const connected = this.#required();
    const project = this.#projects?.find((p) => p.index === index);
    if (!project) throw new DeviceSourceError("browse the +Drive again — that listing is stale");

    this.hooks.onStatus(`Reading ${project.name} from slot ${project.index}…`);
    const opened = await openDeviceProject(connected, project, (chunks, bytes) => {
      if (chunks % 8 === 0) {
        this.hooks.onStatus(`Reading ${project.name}: ${bytes.toLocaleString()} bytes…`);
      }
    });

    // Checked after the read, because the listing does not say what family a stored project is —
    // only the payload does. The mirror of the check on the source side, and for the same reason:
    // "should be impossible" is not the same as "cannot happen".
    if (deviceFor(opened.image).kind !== "dn2") {
      throw new DeviceSourceError(
        `Slot ${project.index} holds a Digitone 1 project. This page expands *to* a Digitone II — ` +
          `open that one as the source instead.`,
      );
    }

    return {
      image: opened.image,
      label: `${connected.name} · ${project.index}. ${project.name}`,
      slot: project.index,
    };
  }

  /**
   * Read the project the musician has loaded. **The only one a write can go back to.**
   *
   * The donor supplies the ~0.49% no dump carries — header, song table, slot array. Without it
   * there is no image, only most of one.
   */
  async readActive(donorImage: Uint8Array, describeDonor: string): Promise<ActiveProject> {
    const connected = this.#required();
    this.hooks.onStatus(
      `Reading ${connected.name} with ${describeDonor} as the donor — this takes about a minute…`,
    );
    const { image, handle } = await readProject(connected, donorImage, (done, total, label) => {
      if (done % 8 === 0 || done === total) this.hooks.onStatus(`Reading: ${done}/${total} — ${label}`);
    });
    return { image, handle, name: connected.name };
  }

  /**
   * Send the accumulated changes back.
   *
   * Diffed against what the instrument gave us, not against the last merge — so every change in the
   * working project is sent, however many applies went into it.
   */
  async write(
    handle: DeviceProjectHandle,
    image: Uint8Array,
  ): Promise<Awaited<ReturnType<typeof writeBack>>> {
    return await writeBack(handle, image, (done, total, label) => {
      this.hooks.onStatus(`Writing ${done}/${total} — ${label}`);
    });
  }

  #required(): ConnectedDevice {
    if (!this.#connected) throw new DeviceSourceError("connect a Digitone II first");
    return this.#connected;
  }
}
