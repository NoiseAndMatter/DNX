/**
 * The Bloom prototype's `/samples` route as a `SampleDeviceStore`.
 *
 * **Prototype, local only.** The store format is `sample/blsm.ts` and the files are
 * `sample/storefile.ts`. This composes them with the +Drive session, and it is the only module that
 * sends anything for samples.
 *
 * ## What counts as proof
 *
 * - **Holdings come from `/samples/index`**, one read of 131,136 bytes. The `/samples` listing
 *   gives only sizes and occupancy, and reading every `/samples/<n>` would move up to 8 MiB each.
 * - **A write is proven by the index**, not by the commit. A commit cannot refuse on this
 *   firmware family (see `waveriderwrite.ts`), so after the write and its read-back, the index must
 *   hold entry `n` with the identity and payload hash that were sent.
 * - **The read-back excuses the allocation.** The firmware fills the start and extent DNX sent as
 *   zero, and that changes the container CRC. `stampedFor` names those 12 bytes and nothing else.
 *
 * ## A remove takes no backup
 *
 * Every other delete in core requires a copy first, because the instrument held the only one. Here
 * DNX holds the master copy and the device holds a cache (`docs/samples.md`), so the caller is the
 * backup. The person is still asked, through `confirmDelete`, before each delete.
 */

import { type ApiTransport, readStoredFile } from "./storagesession.js";
import { type ConfirmHook, safeWriteFile } from "./safewrite.js";
import { type DriveWriteHost } from "./driveproject.js";
import { readFormOption } from "./storagewrite.js";
import { type Entry, deleteRequest, listRequest, wholeListing } from "./storage.js";
import { IDS_FOR } from "./messageids.js";
import { INDEX_ENTRIES, entryIdentity } from "../sample/blsm.js";
import { ALLOCATED_FIELD_OFFSETS, type StoreIndex, buildSampleFile, payloadOf, readIndexFile } from "../sample/storefile.js";
import type { SampleDeviceStore } from "../sample/devicestore.js";
import type { StoredSample } from "../sample/format.js";
import { type SampleId, sameSample, sampleKey } from "../sample/identity.js";
import { xxHash32 } from "../waverider/xxhash32.js";

export const SAMPLES = "/samples";
export const SAMPLE_INDEX_PATH = `${SAMPLES}/index`;
export const samplePath = (n: number): string => `${SAMPLES}/${n}`;

export class SampleStoreError extends Error {}

/** Offsets a correct write of `file` reads back differently at: the allocation and the CRC. */
export function stampedFor(file: Uint8Array): ReadonlySet<number> {
  const crc = file.length - 12;
  return new Set([...ALLOCATED_FIELD_OFFSETS, crc, crc + 1, crc + 2, crc + 3]);
}

/** The lowest entry the index does not use, or `undefined` when all 1,024 are used. */
export function firstFreeEntry(index: StoreIndex): number | undefined {
  const used = new Set(index.entries.map((e) => e.n));
  for (let n = 0; n < INDEX_ENTRIES; n++) if (!used.has(n)) return n;
  return undefined;
}

/** What a person is asked before one entry is deleted. */
export interface SampleDeleteReview {
  path: string;
  name: string;
  /** The identity, so a dialog can say which of two same-named samples goes. */
  sample: string;
}

export interface BloomSampleStoreOptions {
  transport: ApiTransport;
  host: DriveWriteHost;
  /** The name the device shows for a sample. DNX's catalog owns names; the device only displays one. */
  nameFor: (id: SampleId) => string;
  /** Asked before each delete. Required: a store without it cannot remove anything. */
  confirmDelete: ConfirmHook<SampleDeleteReview>;
  onStatus?: (message: string) => void;
  timeoutMs?: number;
}

export class BloomSampleStore implements SampleDeviceStore {
  constructor(private readonly options: BloomSampleStoreOptions) {}

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 30_000;
  }

  private status(message: string): void {
    this.options.onStatus?.(message);
  }

  /** The current group's index, read now. */
  async readIndex(): Promise<StoreIndex> {
    const { transport, host } = this.options;
    const file = await readStoredFile(SAMPLE_INDEX_PATH, {
      transport,
      ...readFormOption(SAMPLE_INDEX_PATH),
      msgId: host.ids.reserve(IDS_FOR.oneObject),
      timeoutMs: this.timeoutMs,
    });
    return readIndexFile(file.bytes);
  }

  async holdings(): Promise<SampleId[]> {
    return (await this.readIndex()).entries.map(entryIdentity);
  }

  private async listed(n: number): Promise<Entry> {
    const { transport, host } = this.options;
    const id = host.ids.reserve(IDS_FOR.oneMessage);
    const reply = await transport.request(listRequest(id, SAMPLES), id, this.timeoutMs);
    const entry = wholeListing(reply, SAMPLES).entries.find((e) => e.index === n);
    if (!entry) throw new SampleStoreError(`entry ${n} is not in the ${SAMPLES} listing`);
    return entry;
  }

  /**
   * Send one sample to the first free entry, unless the device already holds it.
   *
   * Returns `"present"` when it was already there and nothing was sent.
   *
   * Throws for every outcome that is not "stored and proven", including a cancel, so a caller
   * cannot mistake a declined write for a sent one.
   */
  async put(
    id: SampleId,
    sample: StoredSample,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<"sent" | "present"> {
    const { transport, host } = this.options;
    host.gate();

    this.status(`Reading ${SAMPLE_INDEX_PATH}…`);
    // An all-zero index file is the empty store, and the first write creates group A. Any other
    // invalid index is refused by `readIndexFile`.
    const before = await this.readIndex();
    if (before.entries.some((e) => sameSample(entryIdentity(e), id))) return "present";
    const n = firstFreeEntry(before);
    if (n === undefined) throw new SampleStoreError(`all ${INDEX_ENTRIES} sample entries are in use`);

    const name = this.options.nameFor(id);
    const bytes = buildSampleFile({ n, id, sample, name });
    const target = await this.listed(n);

    const result = await safeWriteFile({
      gate: host.gate,
      transport,
      path: samplePath(n),
      name,
      bytes,
      target,
      confirm: host.confirm,
      msgId: host.ids.reserve(IDS_FOR.oneObject),
      verifyMsgId: host.ids.reserve(IDS_FOR.oneObject),
      timeoutMs: this.timeoutMs,
      stamped: stampedFor(bytes),
      ...(this.options.onStatus === undefined ? {} : { onStatus: this.options.onStatus }),
      // The interface reports bytes of the write; the read-back that follows is not counted.
      ...(onProgress === undefined
        ? {}
        : { onProgress: (done: number, total: number, stage: string) => {
              if (stage === "write") onProgress(done, total);
            } }),
    });
    if (result.cancelled) throw new SampleStoreError(`the write of "${name}" to ${samplePath(n)} was cancelled`);

    // The index, which is the only proof. See this module's note.
    this.status(`Confirming in ${SAMPLE_INDEX_PATH}…`);
    const after = await this.readIndex();
    const stored = after.entries.find((e) => e.n === n);
    const payloadHash = xxHash32(payloadOf(sample));
    if (!stored || !sameSample(entryIdentity(stored), id) || stored.payloadHash !== payloadHash) {
      throw new SampleStoreError(
        `the commit reported success and entry ${n} does not hold ${sampleKey(id)}. The store ` +
          `refused the file after the commit was answered.`,
      );
    }
    if (!result.verified) {
      throw new SampleStoreError(
        `entry ${n} is in the index, and the read-back differs: ${result.mismatches.map((m) => m.reason).join("; ")}`,
      );
    }
    return "sent";
  }

  /** Delete every entry that holds `id`. Asks before each one. */
  async remove(id: SampleId): Promise<void> {
    const { transport, host } = this.options;
    host.gate();
    const before = await this.readIndex();
    const matches = before.entries.filter((e) => sameSample(entryIdentity(e), id));
    for (const entry of matches) {
      const path = samplePath(entry.n);
      const agreed = await this.options.confirmDelete({ path, name: entry.name, sample: sampleKey(id) });
      if (!agreed) throw new SampleStoreError(`the delete of ${path} was cancelled`);
      this.status(`Deleting ${path}…`);
      const msgId = host.ids.reserve(IDS_FOR.oneMessage);
      await transport.request(deleteRequest(msgId, path), msgId, this.timeoutMs);
    }
    const after = await this.readIndex();
    if (after.entries.some((e) => sameSample(entryIdentity(e), id))) {
      throw new SampleStoreError(`the delete was answered and the index still holds ${sampleKey(id)}`);
    }
  }
}
