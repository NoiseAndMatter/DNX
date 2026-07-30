/**
 * Collect SysEx a device sends us, and say what arrived.
 *
 * **Nothing here transmits.** The Digitone can be told to send from its own front panel —
 * `SETTINGS > SYSEX DUMP > SYSEX SEND`, either a whole project or one pattern — so the receive
 * path can be proven with the safety question entirely absent. That ordering is deliberate: the
 * risky half of any transfer feature is sending, and there is no reason to do it before we can
 * read what comes back.
 *
 * ## What a capture is worth
 *
 * A capture is byte-identical in form to the 419 native dumps already in the corpus, so the
 * moment one is saved, every existing tool works on it — `npm run inspect`, the pattern reader,
 * the diff. That is why this collects and saves rather than parsing cleverly: the parsing is
 * already written and already tested.
 *
 * The comparison it unlocks is the point. A pattern dumped from a device, held against the same
 * pattern read out of the project file, tests our reader against **live device output** rather
 * than against files Elektron's importer wrote — and those two have agreed with each other all
 * along partly because they come from the same place.
 *
 * ## Sizes
 *
 * A single DN2 pattern is 89,088 bytes before the 8-in-7 expansion, so one pattern dump is
 * around 102 KB and a whole project is on the order of 13 MB across many messages. Nothing here
 * renders per message for that reason; it summarises, and the bytes go to a file.
 */

import { SYSEX_END, SYSEX_START, parseMessage } from "../sysex/container.js";
import { ELEKTRON_MANUFACTURER_ID, PRODUCT_NAMES } from "../sysex/devices.js";
import { RESPONSE_BIT, decodeMessage, isApiMessage } from "./api.js";
import { DUMP_MESSAGES } from "./capabilities.js";

/** One kind of message seen, and how much of it. */
export interface CaptureGroup {
  productId: number;
  /** `Digitone II`, or the raw id when it is a product we have no name for. */
  product: string;
  dumpType: number;
  /** `PatternKit dump`, or `unknown` — the same naming the probe uses elsewhere. */
  name: string;
  count: number;
  /**
   * Distinct object numbers seen, so a project dump shows *which* patterns arrived.
   *
   * **Fewer than `count` does not mean messages were lost.** The object number is a single 7-bit
   * SysEx byte, so it counts `0`–`127` and then reports `0` for everything after — observed on a
   * Digitone sending banks of 182 and 256 sounds. Beyond 128 objects the number carries no
   * information and only **send order** identifies a record.
   */
  objects: number[];
  /** True when more messages arrived than there are distinct object numbers. */
  numbersExhausted: boolean;
  bytes: number;
  /** Messages whose stored checksum disagrees with the recomputed one. */
  badChecksum: number;
}

/** API traffic, which is a different protocol and must not be described as a dump. */
export interface ApiGroup {
  /** The code as it appeared, e.g. `0x81` a Device reply or `0xd3` a directory listing. */
  code: number;
  /** `Device reply`, `directory listing reply`, or `unknown 0x…`. */
  name: string;
  count: number;
  bytes: number;
  /**
   * How many carried a `respId` — i.e. answered someone's request.
   *
   * **Whose request, this cannot say.** A capture is bytes off an input port; it has no record of
   * what was sent, so it cannot tell our reply from Elektron Transfer's. That distinction matters
   * enough to have caused a false positive already — see `KNOWN-ISSUES.md` — but it belongs to
   * whoever allocated the message ids, not here. Counting the fact and stopping is the honest
   * version.
   */
  replies: number;
  /**
   * The distinct request ids these answered, so **whoever did the asking can check**.
   *
   * This module cannot tell our traffic from another application's, but the code that allocated the
   * ids can, and it needs the ids to do it. Reported rather than resolved: the layering is the
   * point — the summariser states a fact about the bytes and the caller supplies the knowledge it
   * has and the bytes do not.
   *
   * Capped at `MAX_RESP_IDS`. A capture of Transfer's idle poll carries thousands of distinct ids
   * and nobody reads the four-thousandth; the first few settle whose they are.
   */
  respIds: number[];
}

/** Enough to identify a source, few enough that a 5,973-message capture stays cheap. */
export const MAX_RESP_IDS = 8;

export interface CaptureSummary {
  messages: number;
  bytes: number;
  groups: CaptureGroup[];
  /**
   * API messages, counted separately.
   *
   * **Added after a capture of 5,973 of them was reported as `product 16` with every checksum
   * BAD.** This summariser is a *dump* parser: fed `F0 00 20 3C 10 00 …` it reads byte 4 as a
   * product and byte 6 as a dump type, and invents both. That mangling hid Elektron Transfer
   * polling the device for the best part of an hour, and a wrong result was recorded on the
   * strength of it.
   *
   * The two protocols share a wire and nothing else. Anything that summarises a capture has to say
   * which it is looking at.
   */
  api: ApiGroup[];
  /** Complete SysEx messages that are not Elektron's, ignored but counted. */
  foreign: number;
  /** Messages that could not be parsed as a dump at all. */
  unparsed: number;
  /**
   * Bytes at the end that begin a message with no `F7` behind them.
   *
   * Reported rather than dropped. Stopping a listen mid-transfer produces exactly this, and a
   * summary that quietly ignored the tail would describe a truncated capture as a complete one.
   */
  trailingBytes: number;
}

/**
 * Accumulates raw MIDI as it arrives.
 *
 * Bytes are appended exactly as received and never rewritten, because the saved file has to be a
 * faithful capture — the whole value of it is being able to say *"this is what the device sent"*
 * without our interpretation in the middle.
 */
export class DumpCapture {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;

  /** Feed one MIDI message. Non-SysEx traffic is dropped: clock and notes are not a dump. */
  add(data: Uint8Array): void {
    if (data.length === 0 || data[0] !== SYSEX_START) return;
    this.chunks.push(Uint8Array.from(data));
    this.total += data.length;
  }

  get byteLength(): number {
    return this.total;
  }

  get isEmpty(): boolean {
    return this.total === 0;
  }

  /** Everything received so far, concatenated — the exact bytes to write to a `.syx`. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.total);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  clear(): void {
    this.chunks.length = 0;
    this.total = 0;
  }

  summarise(): CaptureSummary {
    return summariseCapture(this.bytes());
  }
}

/**
 * What is in a capture, grouped by product and dump type.
 *
 * Tolerant on purpose. A capture is raw wire data that may be truncated — the user can stop
 * listening mid-transfer — so a message that will not parse is **counted, not thrown**. A
 * summary that refuses to describe an imperfect capture is useless exactly when it is needed.
 */
export function summariseCapture(data: Uint8Array): CaptureSummary {
  const groups = new Map<string, CaptureGroup>();
  let foreign = 0;
  let unparsed = 0;
  let messages = 0;

  const api = new Map<number, ApiGroup>();

  const { complete, trailingBytes } = splitTolerantly(data);
  for (const raw of complete) {
    messages++;

    if (!isElektron(raw)) {
      foreign++;
      continue;
    }

    // **Checked before the dump parser gets it.** An API message is Elektron's, well-formed, and
    // nothing like a dump — but a dump parser will happily describe one, wrongly and confidently.
    if (isApiMessage(raw)) {
      try {
        const frame = decodeMessage(raw);
        const group = api.get(frame.code) ?? {
          code: frame.code,
          name: apiName(frame.code),
          count: 0,
          bytes: 0,
          replies: 0,
          respIds: [],
        };
        group.count++;
        group.bytes += raw.length;
        if (frame.respId !== undefined) {
          group.replies++;
          if (group.respIds.length < MAX_RESP_IDS && !group.respIds.includes(frame.respId)) {
            group.respIds.push(frame.respId);
          }
        }
        api.set(frame.code, group);
      } catch {
        unparsed++;
      }
      continue;
    }

    try {
      const message = parseMessage(raw);
      const key = `${message.productId}:${message.dumpType}`;
      const group = groups.get(key) ?? {
        productId: message.productId,
        product: PRODUCT_NAMES[message.productId] ?? `product ${message.productId}`,
        dumpType: message.dumpType,
        name: DUMP_MESSAGES[message.dumpType] ?? "unknown",
        count: 0,
        objects: [],
        numbersExhausted: false,
        bytes: 0,
        badChecksum: 0,
      };
      group.count++;
      group.bytes += message.byteLength;
      if (!group.objects.includes(message.objNr)) group.objects.push(message.objNr);
      if (message.storedChecksum !== message.computedChecksum) group.badChecksum++;
      groups.set(key, group);
    } catch {
      unparsed++;
    }
  }

  for (const group of groups.values()) {
    group.objects.sort((a, b) => a - b);
    group.numbersExhausted = group.count > group.objects.length;
  }

  return {
    messages,
    bytes: data.length,
    groups: [...groups.values()].sort((a, b) => a.productId - b.productId || a.dumpType - b.dumpType),
    api: [...api.values()].sort((a, b) => a.code - b.code),
    foreign,
    unparsed,
    trailingBytes,
  };
}

/**
 * What each API code is, as a noun. `apiName` adds "request" or "reply".
 *
 * `0x53`–`0x5a` are the +Drive storage codes, which appear in no public source including
 * elk-herd — `docs/device-storage.md` §1 has where each name came from. `0x03` is named for what
 * it is *observed* to be rather than what it means: Transfer polls it continuously and the answer
 * never changes (§4).
 */
const API_NAMES: Record<number, string> = {
  0x01: "Device",
  0x02: "Version",
  0x03: "idle poll",
  0x09: "Query",
  0x10: "DirList",
  0x53: "directory listing",
  0x54: "open",
  0x55: "read",
  0x56: "close",
  0x5a: "mutation ack",
};

/**
 * Name an API code, including the storage codes no public source documents.
 *
 * A reply carries the request's code `+0x80`, so `0xd3` is `0x53` answered. Named rather than
 * numbered because a capture full of `0xd3` tells a reader nothing and `directory listing reply`
 * tells them what happened.
 */
export function apiName(code: number): string {
  const isReply = (code & RESPONSE_BIT) !== 0;
  const request = code & ~RESPONSE_BIT;
  const name = API_NAMES[request];
  return name === undefined
    ? `unknown 0x${request.toString(16).padStart(2, "0")}`
    : `${name}${isReply ? " reply" : " request"}`;
}

/**
 * Split into complete messages, keeping whatever is left over.
 *
 * `splitMessages` throws on an unterminated message, which is right for a file — a `.syx` that
 * stops mid-message is corrupt and should say so. A **live capture** is different: the user can
 * stop listening at any moment, so a partial trailing message is the normal shape of a capture
 * rather than a fault, and refusing to summarise it would fail exactly when something has gone
 * wrong and the summary is what you need.
 */
function splitTolerantly(data: Uint8Array): { complete: Uint8Array[]; trailingBytes: number } {
  const complete: Uint8Array[] = [];
  let at = 0;

  while (at < data.length) {
    const start = data.indexOf(SYSEX_START, at);
    if (start === -1) return { complete, trailingBytes: 0 };
    const end = data.indexOf(SYSEX_END, start + 1);
    if (end === -1) return { complete, trailingBytes: data.length - start };
    complete.push(data.subarray(start, end + 1));
    at = end + 1;
  }

  return { complete, trailingBytes: 0 };
}

function isElektron(raw: Uint8Array): boolean {
  return (
    raw.length > ELEKTRON_MANUFACTURER_ID.length + 1 &&
    ELEKTRON_MANUFACTURER_ID.every((b, i) => raw[i + 1] === b)
  );
}

/**
 * A filename that says what it holds without being opened.
 *
 * Captures pile up during a session — a pattern, then a project, then the same from the other
 * machine — and three files called `capture.syx` are three files nobody can tell apart an hour
 * later, let alone next week.
 */
export function captureFileName(summary: CaptureSummary, when = new Date()): string {
  const stamp =
    `${String(when.getHours()).padStart(2, "0")}${String(when.getMinutes()).padStart(2, "0")}`;
  const biggest = summary.groups.slice().sort((a, b) => b.bytes - a.bytes)[0];
  if (!biggest) {
    // No dumps, but API traffic is still worth a name. The capture that started all this — nearly
    // an hour of Elektron Transfer talking to a Digitone 1 — was saved as
    // `product16_Project_5973msg_1353.syx`, and both halves of that name were inventions of the
    // dump parser. `API_5973msg` says the true thing and no more.
    const apiMessages = summary.api.reduce((n, group) => n + group.count, 0);
    if (apiMessages > 0) return `API_${apiMessages}msg_${stamp}.syx`;
    return `CAPTURE_${stamp}.syx`;
  }

  const product = biggest.product.replace(/[^A-Za-z0-9]+/g, "");

  // Named for the **whole** capture, not its largest group. A project dump is 128 PatternKit,
  // 119 Sound and one ProjectSettings, and calling that file `PatternKit_128x` made the user
  // reasonably think the other 120 messages had been lost. They were in the file all along; only
  // the name lied.
  if (summary.groups.length > 1) {
    return `${product}_Project_${summary.messages}msg_${stamp}.syx`;
  }

  const kind = biggest.name.replace(/\s*dump\s*/i, "").replace(/[^A-Za-z0-9]+/g, "") || `type${biggest.dumpType.toString(16)}`;
  return `${product}_${kind}_${biggest.count}x_${stamp}.syx`;
}

export { SYSEX_END, SYSEX_START };
