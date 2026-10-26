/**
 * The device's sample store, as DNX sees it: an interface and nothing more, until format v1.
 *
 * **Why only an interface.** The device-side layout is not agreed. The proposal is an ekFS-format
 * region from sector `0x641000`, where the wavetable store ends, rebased so its block numbers
 * stay valid ("Sample region plan", 2026-10-21). The transport may change too: digikit is
 * exploring a faster upload path (`docs/design/digikit-upload.md` in ElekLabs/digikit). So every
 * caller talks to this interface, and the implementation follows when the format and the
 * transport are settled. Nothing in DNX writes samples to a device today.
 *
 * The device holds a cache of a project's samples. DNX holds the master copy, so the device is
 * asked what it has by identity and sent only what it lacks (`transfer.ts`).
 */

import type { StoredSample } from "./format.js";
import type { SampleId } from "./identity.js";

export interface SampleDeviceStore {
  /** Every sample the device holds, by identity. */
  holdings(): Promise<SampleId[]>;
  /** Send one sample. `onProgress` reports bytes sent of the total. */
  put(id: SampleId, sample: StoredSample, onProgress?: (sent: number, total: number) => void): Promise<void>;
  /** Remove one sample from the device. The master copy is not touched. */
  remove(id: SampleId): Promise<void>;
}
