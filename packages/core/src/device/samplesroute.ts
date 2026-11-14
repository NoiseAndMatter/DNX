/**
 * The firmware's `/samples` route: send a sample in parts, list the store, delete a sample.
 *
 * **One job: the conversation.** The bytes are `sample/routerecords.ts`. The page decides what
 * to send and asks the person. This module sends it and proves that it landed.
 *
 * ## What counts as proof
 *
 * Stock answers the commit (`0x59`) before the firmware's code runs, so that answer says nothing
 * about the card. After each part, `/samples/info` says what the firmware did with it:
 *
 * - its handled count (+36) is higher than before the part, so the record is about this part
 * - the result is 0
 * - the xxHash32 is DNX's own of that part's bytes, which the firmware read back from the card
 * - the upload expects part `n + 1`, or it closed after the last part
 *
 * After the last part, `/samples/index` must list the id with the path and the length sent.
 *
 * ## A send that stops
 *
 * A pulled cable or a power cut leaves the upload open on the instrument. The next send of the
 * same file reads `info`, sees its own id open, and goes on from the part the firmware expects.
 * An open upload of another file blocks every new one, so a send drops it first. That upload is
 * not a stored file yet, so the drop loses no sample.
 */

import { IDS_FOR, type MessageIds } from "./messageids.js";
import { safeWriteSamplePart } from "./safewrite.js";
import { deleteRequest, listRequest, wholeListing } from "./storage.js";
import { type ApiTransport, readStoredFile } from "./storagesession.js";
import { readFormOption } from "./storagewrite.js";
import {
  LONGEST_FILE,
  RESULT,
  SampleRouteError,
  type IndexRow,
  type SamplesIndex,
  type SamplesInfo,
  buildPart,
  parseIndex,
  parseInfo,
  partBytes,
  partCount,
  resultText,
  sha256Hex,
  storePathProblem,
  unhex,
} from "../sample/routerecords.js";
import { xxHash32 } from "../waverider/xxhash32.js";

export const SAMPLES = "/samples";
export const INFO_PATH = "/samples/info";
export const INDEX_PATH = "/samples/index";

const TIMEOUT_MS = 10_000;
/** Sends of one part before the send stops. */
const TRIES_PER_PART = 3;
/** Reads of `info` before DNX says the part was not handled. */
const INFO_READS = 20;
const INFO_PAUSE_MS = 100;

export interface RouteHost {
  transport: ApiTransport;
  ids: MessageIds;
  /** The page's write switch. Every write calls it first. */
  gate: () => void;
  timeoutMs?: number;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Whether the instrument has the route: `/` lists `samples`. */
export async function hasSamplesRoute(host: Pick<RouteHost, "transport" | "ids" | "timeoutMs">): Promise<boolean> {
  const msgId = host.ids.reserve(IDS_FOR.oneMessage);
  const reply = await host.transport.request(listRequest(msgId, "/"), msgId, host.timeoutMs ?? TIMEOUT_MS);
  return wholeListing(reply, "/").entries.some((entry) => entry.name === "samples");
}

async function readRecord(host: Pick<RouteHost, "transport" | "ids" | "timeoutMs">, path: string, ids: number): Promise<Uint8Array> {
  const file = await readStoredFile(path, {
    transport: host.transport,
    ...readFormOption(path),
    msgId: host.ids.reserve(ids),
    timeoutMs: host.timeoutMs ?? TIMEOUT_MS,
  });
  return file.bytes;
}

export async function readInfo(host: Pick<RouteHost, "transport" | "ids" | "timeoutMs">): Promise<SamplesInfo> {
  return parseInfo(await readRecord(host, INFO_PATH, IDS_FOR.oneObject));
}

/** 1,024 rows of 200 bytes is about 100 chunks of 2,048. */
const INDEX_IDS = 160;

export async function readIndex(host: Pick<RouteHost, "transport" | "ids" | "timeoutMs">): Promise<SamplesIndex> {
  return parseIndex(await readRecord(host, INDEX_PATH, INDEX_IDS));
}

/**
 * Delete the stored file with `id`, or drop the open upload with that id.
 *
 * True when the firmware handled it: the result is 0. False when the store did not hold the id.
 */
export async function deleteSample(host: RouteHost, id: string): Promise<boolean> {
  host.gate();
  unhex(id);
  const before = await readInfo(host);
  const path = `${SAMPLES}/${id}/`;
  const msgId = host.ids.reserve(IDS_FOR.oneMessage);
  await host.transport.request(deleteRequest(msgId, path), msgId, host.timeoutMs ?? TIMEOUT_MS);
  const after = await handledSince(host, before.handled);
  if (after.result === RESULT.good) return true;
  if (after.result === RESULT.absent) return false;
  throw new SampleRouteError(`the delete of ${id.slice(0, 12)} failed: ${resultText(after.result)}`);
}

/** Read `info` until its handled count is above `count`. */
async function handledSince(host: RouteHost, count: number): Promise<SamplesInfo> {
  for (let read = 0; read < INFO_READS; read++) {
    const info = await readInfo(host);
    if (info.handled !== count) return info;
    await pause(INFO_PAUSE_MS);
  }
  throw new SampleRouteError(
    "the instrument answered the part and did not handle it. Send the plan again to go on.",
  );
}

export interface UploadOptions {
  /** The store path, `samples/...`. */
  path: string;
  /** The native file. */
  file: Uint8Array;
  onProgress?: (sent: number, total: number) => void;
  onStatus?: (message: string) => void;
}

export type UploadOutcome =
  /** The store lists the file with the id, the path and the length sent. */
  | { kind: "stored"; id: string; parts: number; resumedAt: number }
  /** The store held the id already, under `path`. Nothing was sent. */
  | { kind: "present"; id: string; path: string };

/**
 * Send one native file to `path`, and prove it landed.
 *
 * Throws when a part cannot go in. An upload that stops stays open on the instrument, and a
 * second call with the same file goes on from where it stopped.
 */
export async function uploadSample(host: RouteHost, options: UploadOptions): Promise<UploadOutcome> {
  const { path, file } = options;
  const status = options.onStatus ?? ((): void => {});
  host.gate();
  const why = storePathProblem(path);
  if (why) throw new SampleRouteError(why);
  if (file.length === 0 || file.length > LONGEST_FILE) {
    throw new SampleRouteError(`a sample is 1 byte to 64 MiB, and this one is ${file.length} bytes`);
  }

  const id = await sha256Hex(file);
  const idBytes = unhex(id);

  const index = await readIndex(host);
  const held = index.rows.find((row) => row.id === id);
  if (held) return { kind: "present", id, path: held.path };

  let info = await readInfo(host);
  const partSize = info.partSize;
  const parts = partCount(file.length, partSize);

  let n = 0;
  if (info.open && info.id === id && info.whole === file.length) {
    n = info.next;
    status(`Going on from part ${n + 1} of ${parts}.`);
  } else if (info.open) {
    status("Dropping an unfinished upload of another file…");
    await deleteSample(host, info.id);
    info = await readInfo(host);
  }
  const resumedAt = n;

  let tries = 0;
  let restarted = false;
  while (n < parts) {
    const bytes = partBytes(file, n, partSize);
    const container = buildPart({ part: n, whole: file.length, id: idBytes, path, bytes });
    const before = info.handled;
    await safeWriteSamplePart({
      transport: host.transport,
      path: `${SAMPLES}/${n}`,
      bytes: container,
      gate: host.gate,
      msgId: host.ids.reserve(IDS_FOR.oneObject),
      timeoutMs: host.timeoutMs ?? TIMEOUT_MS,
    });
    info = await handledSince(host, before);

    const last = n === parts - 1;
    if (info.result === RESULT.good) {
      if (info.sum !== xxHash32(bytes)) {
        await deleteSample(host, id).catch(() => false);
        throw new SampleRouteError(
          `part ${n + 1} of ${parts}: the card holds other bytes than DNX sent. The upload is dropped.`,
        );
      }
      const moved = last ? !info.open : info.open && info.id === id && info.next === n + 1;
      if (!moved) {
        throw new SampleRouteError(`part ${n + 1} of ${parts} went in, and the upload did not move on`);
      }
      n += 1;
      tries = 0;
      options.onProgress?.(Math.min(file.length, n * partSize), file.length);
      continue;
    }
    if (info.result === RESULT.exists && n === 0) {
      const again = (await readIndex(host)).rows.find((row) => row.id === id);
      return { kind: "present", id, path: again?.path ?? path };
    }
    if ((info.result === RESULT.resend || info.result === RESULT.cardLost) && ++tries < TRIES_PER_PART) {
      status(`Part ${n + 1} of ${parts}: ${resultText(info.result)}. Sending it again.`);
      continue;
    }
    if (info.result === RESULT.notNext && info.open && info.id === id) {
      n = info.next;
      continue;
    }
    if ((info.result === RESULT.notNext || info.result === RESULT.order) && !restarted) {
      restarted = true;
      n = 0;
      status("Starting the file again from part 1.");
      continue;
    }
    throw new SampleRouteError(`part ${n + 1} of ${parts}: ${resultText(info.result)}`);
  }

  const row: IndexRow | undefined = (await readIndex(host)).rows.find((one) => one.id === id);
  if (!row || row.length !== file.length || row.path !== path) {
    throw new SampleRouteError(`the store does not list ${path} with the id and the length sent`);
  }
  return { kind: "stored", id, parts, resumedAt };
}
