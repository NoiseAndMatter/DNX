/**
 * What a transfer would send: the samples a project needs that the device does not hold.
 *
 * **One job: the plan.** Nothing is sent from here. A sample the device holds is matched by
 * identity (hash and size), so a sample the device has under another name, or in another folder,
 * is not sent again.
 *
 * ## The time estimate
 *
 * The Data API moves about 350 KB/s ("Sample region plan", 2026-10-21), so 1 GB takes about 50
 * minutes. That is `DATA_API_BYTES_PER_SECOND`, and a caller passes its own rate when a faster
 * path exists. The estimate counts the samples' bytes only, not the protocol's overhead.
 */

import type { SampleDeviceStore } from "./devicestore.js";
import { sampleKey, type SampleId } from "./identity.js";

/** The Data API's measured rate, about 350 KB/s. */
export const DATA_API_BYTES_PER_SECOND = 350_000;

export interface TransferPlan {
  /** Needed and not on the device, in the order first asked for. */
  send: SampleId[];
  /** Needed and already on the device. */
  present: SampleId[];
  sendBytes: number;
  /** The estimate in seconds at `bytesPerSecond`. */
  seconds: number;
  bytesPerSecond: number;
}

/** Plan what to send, from what is needed and what the device holds. */
export function planTransfer(
  needed: readonly SampleId[],
  onDevice: readonly SampleId[],
  bytesPerSecond: number = DATA_API_BYTES_PER_SECOND,
): TransferPlan {
  const held = new Set(onDevice.map(sampleKey));
  const seen = new Set<string>();
  const send: SampleId[] = [];
  const present: SampleId[] = [];
  for (const id of needed) {
    const key = sampleKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    (held.has(key) ? present : send).push({ ...id });
  }
  const sendBytes = send.reduce((sum, id) => sum + id.size, 0);
  return { send, present, sendBytes, seconds: sendBytes / bytesPerSecond, bytesPerSecond };
}

/** The same plan, asking the device what it holds. The one read a plan needs. */
export async function planTransferTo(
  store: Pick<SampleDeviceStore, "holdings">,
  needed: readonly SampleId[],
  bytesPerSecond?: number,
): Promise<TransferPlan> {
  return planTransfer(needed, await store.holdings(), bytesPerSecond);
}
