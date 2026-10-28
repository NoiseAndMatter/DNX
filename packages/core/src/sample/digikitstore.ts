/**
 * Samples in digikit's card store, through digikit's own client.
 *
 * The store is the `samples/` folder of digikit's card store (`docs/design/digikit-store.md` in
 * digikit). Only digikit's runtime writes it, so uploads need that runtime in the image. The protocol, the writer, the verify
 * and the WAV converter are digikit's, vendored unchanged under `vendor/digikit/`. This module adds
 * the one thing DNX has that digikit's client does not: a transport over DNX's own `SysexPort`.
 *
 * ## What counts as proof
 *
 * - **A write is proven by VERIFY**, the device's sha256 of a fresh card read, compared with the
 *   sha256 of the bytes sent. END already checks the hash of the bytes received, so VERIFY is the
 *   check that the card holds them.
 * - **LIST gives the path, the size and the sha256.** It does not give the first sector: the table
 *   holds it, and no command returns it.
 */

import type { SysexPort } from "../device/port.js";
import { DkSession, hexSha256, type DkInfoFull, type DkTransport } from "../vendor/digikit/dkupload-core.js";
import { Sample, prepareUpload, type Prepared } from "../vendor/digikit/dksample.js";
import { STORE_FOLDER, openSamples, type SamplesBackend } from "../vendor/digikit/samples.js";

export { STORE_FOLDER, hexSha256, type DkInfoFull, type DkTransport, type Prepared, type SamplesBackend };

/** The first bytes of every digikit message: SysEx, the non-commercial id 7D, then "dk". */
const DK_PREFIX = [0xf0, 0x7d, 0x64, 0x6b] as const;

const isDkMessage = (bytes: Uint8Array): boolean =>
  bytes.length > DK_PREFIX.length && DK_PREFIX.every((b, i) => bytes[i] === b);

/**
 * A `SysexPort` as digikit's transport: send one message, receive the next digikit message.
 *
 * Every other message on the port is ignored, so the stock API's traffic cannot reach the session.
 * `close` drops the listener. It does not close the port, which other conversations may share.
 */
export function dkTransport(port: SysexPort): DkTransport & { close(): void } {
  const ready: Uint8Array[] = [];
  let waiting: ((bytes: Uint8Array) => void) | undefined;
  const stop = port.subscribe((bytes) => {
    if (!isDkMessage(bytes)) return;
    if (waiting) {
      const deliver = waiting;
      waiting = undefined;
      deliver(bytes);
    } else {
      ready.push(bytes);
    }
  });
  return {
    send: (msg) => port.send(msg),
    recv: (timeoutMs, signal) => {
      const next = ready.shift();
      if (next) return Promise.resolve(next);
      return new Promise<Uint8Array | null>((resolve) => {
        const done = (value: Uint8Array | null): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (waiting === deliver) waiting = undefined;
          resolve(value);
        };
        const deliver = (bytes: Uint8Array): void => done(bytes);
        const onAbort = (): void => done(null);
        const timer = setTimeout(() => done(null), timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        waiting = deliver;
      });
    },
    close: stop,
  };
}

/** The converter, from the bytes of `dksample.wasm`. */
export function loadConverter(wasm: BufferSource): Promise<Sample> {
  return Sample.create(wasm);
}

/** The session and the samples back end on one transport. One session per transport. */
export function openDigikitStore(transport: DkTransport): { session: DkSession; samples: SamplesBackend } {
  const session = new DkSession(transport);
  return { session, samples: openSamples("digikit", { session }) };
}

/** A WAV as the native file the store holds. The name loses its `.wav`, as digikit names it. */
export function prepareWav(converter: Sample, fileName: string, wav: Uint8Array): Prepared {
  const prepared = prepareUpload(converter, fileName, wav);
  if (prepared.kind !== "converted") throw new Error(`${fileName} is not a WAV file`);
  return prepared;
}

/** One stored file, as LIST gives it after a verified upload. */
export interface StoredRecord {
  path: string;
  size: number;
  sha256: string;
  /** The device's sha256 equals the host's, over the whole file. */
  verified: boolean;
}

/**
 * Upload one prepared file into `folder`, verify it, and return what LIST says of it.
 *
 * Throws when VERIFY disagrees or when LIST does not hold the path with the size and sha256 sent,
 * so a caller cannot report an unproven write.
 */
export async function putAndVerify(
  store: { session: DkSession; samples: SamplesBackend },
  folder: string,
  file: Prepared,
  onProgress?: (sent: number, total: number) => void,
): Promise<StoredRecord> {
  await store.samples.put(folder, file, onProgress);
  const check = await store.samples.verify(folder, file);
  if (!check.ok) throw new Error(`VERIFY of ${folder}/${file.name} failed: ${check.message}`);
  const path = `${STORE_FOLDER}/${folder}/${file.name}`;
  const entry = (await store.session.list(path)).find((e) => e.path === path);
  if (!entry || entry.size !== file.stored.length || entry.sha256 !== check.host) {
    throw new Error(`LIST does not hold ${path} with the size and sha256 sent`);
  }
  return { path, size: entry.size, sha256: entry.sha256, verified: true };
}
