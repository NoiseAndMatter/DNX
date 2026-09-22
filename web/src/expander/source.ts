/**
 * The Digitone 1 being expanded: where it came from, and how to get another one.
 *
 * ## What it owns
 *
 * Three pieces of state that were loose module variables in `main.ts` and had to be kept in step by
 * hand: the opened project, the connected instrument, and its +Drive listing. They belong together
 * because they are one question — *which Digitone 1 project are we expanding?* — and because the
 * listing is only meaningful for the connection it came from. Holding them apart is how a stale
 * listing gets read against a different device.
 *
 * ## What it deliberately does not own
 *
 * **The DOM.** It reports through callbacks and returns values; `main.ts` decides what a badge says
 * and which buttons light up. `planning.ts` was extracted the same way and for the same payoff: a
 * module that neither reads nor writes the page can be asked questions in a test.
 *
 * **The grid.** Which bank is showing, and which patterns are selected, are questions about the
 * *view* of a source rather than about the source, and they change when nothing here has.
 *
 * ## A file and a slot are the same thing by the time they land
 *
 * Both routes end at `adopt`, deliberately. They produce an image and a label, everything
 * downstream already treats them identically, and two setters would be two chances for one route
 * to forget to tell the page it changed.
 */

import {
  type ConnectedDevice,
  DeviceSourceError,
  connectDevice,
  listDeviceProjects,
} from "../devicesource.js";
import { type DriveProject } from "@noiseandmatter/dnx-core/device/drive.js";
import { type Progress } from "../progress.js";
import { projectInSlot, readDriveSlot } from "../drivepicker.js";
import { deviceFor } from "@noiseandmatter/dnx-core/librarian/device.js";
import { readProjectName } from "@noiseandmatter/dnx-core/project/dn1.js";
import { ProductId } from "@noiseandmatter/dnx-core/sysex/devices.js";
import { openProject } from "../project.js";
import { slotLabel } from "./sourcename.js";

/** A Digitone 1 project, and what to call it. */
export interface LoadedSource {
  image: Uint8Array;
  /** For the top bar: a file name, or the slot it was read from. */
  label: string;
}

export interface SourceHooks {
  /** Called whenever a different project has been adopted. */
  onChange(source: LoadedSource): void;
  /** Progress and news, in the words the status bar should show. */
  onStatus(message: string): void;
  /**
   * How far through, for the page's bar.
   *
   * Handed in rather than reached for, the same way `onStatus` is: this module talks to an
   * instrument and has no business knowing which element on the page reports it.
   */
  progress: Progress;
}

export class Source {
  #project: LoadedSource | undefined;
  #connected: ConnectedDevice | undefined;
  #projects: DriveProject[] | undefined;

  constructor(private readonly hooks: SourceHooks) {}

  /** The project being expanded, or `undefined` before one is chosen. */
  get project(): LoadedSource | undefined {
    return this.#project;
  }

  /** Its image, which is what every caller actually wanted. */
  get image(): Uint8Array | undefined {
    return this.#project?.image;
  }

  /** True once an instrument has answered, which is what lets browsing be offered. */
  get connected(): boolean {
    return this.#connected !== undefined;
  }

  async fromFile(file: File): Promise<void> {
    this.hooks.onStatus(`Reading ${file.name}…`);
    const loaded = await openProject(file);
    this.adopt({ image: loaded.image, label: file.name });
  }

  /**
   * Find the Digitone 1 among whatever is plugged in.
   *
   * `want` rather than "whichever answers first": this page's whole premise is a Digitone 1 to read
   * from and a Digitone II to write to, at the same time, so the roles are fixed and a guess would
   * be wrong half the time.
   */
  async connect(): Promise<string> {
    this.hooks.onStatus("Looking for a Digitone 1…");
    this.#connected = await connectDevice({ want: ProductId.DN1 });
    // A new instrument invalidates the old listing rather than merging with it.
    this.#projects = undefined;
    this.hooks.onStatus(`${this.#connected.name} connected. Browse its +Drive to pick a project.`);
    return this.#connected.name;
  }

  /**
   * List the Digitone 1's stored projects.
   *
   * **The +Drive, not the dump protocol.** Reading the *active* project record by record needs a
   * donor for the ~0.49% no dump carries, and for a Digitone 1 that donor would have to be a
   * Digitone 1 project — which this page cannot produce, and which is exactly why the manager
   * refuses that route. The stored file needs no donor at all: every byte is there, any slot, and
   * the read is verified byte-for-byte against Elektron's own export.
   */
  async listProjects(): Promise<DriveProject[]> {
    const connected = this.#connected;
    if (!connected) throw new DeviceSourceError("connect a Digitone 1 first");

    this.hooks.onStatus(`Listing projects on ${connected.name}…`);
    this.#projects = await listDeviceProjects(connected);
    return this.#projects;
  }

  /** Read one stored project and adopt it. `index` is the slot the listing gave. */
  async openSlot(index: number): Promise<void> {
    const connected = this.#connected;
    if (!connected) throw new DeviceSourceError("connect a Digitone 1 first");
    const project = projectInSlot(this.#projects, index);

    const opened = await readDriveSlot(connected, project, {
      onStatus: (message) => this.hooks.onStatus(message),
      progress: this.hooks.progress,
    });

    // Checked after the read rather than before, because the +Drive listing does not say what
    // family a stored project is — only the payload does. A DN2 project on a DN1's +Drive should be
    // impossible, and "should be impossible" is not the same as "cannot happen".
    if (deviceFor(opened.image).kind !== "dn1") {
      throw new DeviceSourceError(
        `Slot ${project.index} holds a Digitone II project, which this page expands *to* rather ` +
          `than from.`,
      );
    }

    this.adopt({
      image: opened.image,
      label: slotLabel(readProjectName(opened.image), project.name, project.index),
    });
  }

  private adopt(source: LoadedSource): void {
    this.#project = source;
    this.hooks.onChange(source);
  }
}
