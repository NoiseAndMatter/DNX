/**
 * Talking to a device in the **dump protocol** — the other of the two protocols on this wire.
 *
 * ## The split, same as `storageio.ts`
 *
 * What we say to the device, and what came back. Not what we tell the user about it: the verdict
 * cards, the narration and the safety confirmations stay on the page, because deciding what a reply
 * *means* is the page's job and drawing it is the page's whole purpose.
 *
 * ## Why matching is the substance
 *
 * A dump reply carries a type and an object number, and **nothing else identifies it**. The
 * protocol has no message id — that is the API's idea, not this one's — so a reply is ours because
 * it is the type and object we asked for and we were the ones asking. Two overlapping requests for
 * different objects are distinguishable; two for the same object are not, which is a property of
 * the protocol rather than of this code.
 *
 * That is also why every function here takes the object number it expects rather than accepting
 * whatever turns up. Accepting the next dump of the right *type* would read a device's unsolicited
 * transfer as an answer, and this page has already published one false finding from exactly that
 * kind of confusion on the API side.
 */

import { parseMessage } from "../../../src/sysex/container.js";
import { dumpRequest } from "../../../src/device/dumprequest.js";
import { probeRequest } from "../../../src/research/probecodes.js";
import { DeviceLink } from "../devicelink.js";

/** Long enough for a 114 KB PatternKit on a busy device. */
export const VERIFY_TIMEOUT_MS = 5000;

/**
 * Long enough that a slow answer is not read as no answer.
 *
 * An unidentified code is exactly the case where a timeout that is too short produces a **false**
 * negative, and a false negative here goes into the documentation as "does not answer".
 */
export const UNKNOWN_TIMEOUT_MS = 8000;

/** A dump reply of this type for this object, or `undefined` for anyone else's traffic. */
export function matchDump(data: Uint8Array, dumpType: number, objNr: number): Uint8Array | undefined {
  let reply;
  try {
    reply = parseMessage(data);
  } catch {
    return undefined;
  }
  if (reply.dumpType !== dumpType || reply.objNr !== objNr) return undefined;
  return reply.payload;
}

/** Options a caller may want when asking for one record back. */
export interface RequestDumpOptions {
  timeoutMs?: number;
  onSendError?: (error: unknown) => void;
  /**
   * Called if the record arrives after the wait gave up.
   *
   * **A late answer is an answer.** Without somewhere for it to go, a reply that missed the timeout
   * used to arrive, trigger a redraw, and wipe the verdict it should have completed.
   */
  onLate?: (payload: Uint8Array) => void;
}

/**
 * Ask for one patternKit back, and wait for that exact object.
 *
 * This is the read half of **the only proof a write worked**: a device that stored the bytes and a
 * device that ignored the message look identical from the sending end, and one that stored them in
 * the wrong slot looks identical to both. Only asking for the record back and comparing separates
 * those three.
 */
export function requestPatternKit(
  link: DeviceLink,
  productId: number,
  objNr: number,
  options: RequestDumpOptions = {},
): Promise<Uint8Array | undefined> {
  const { timeoutMs = VERIFY_TIMEOUT_MS, onSendError, onLate } = options;
  return link.awaitReply<Uint8Array>({
    send: () => link.output.send([...dumpRequest(productId, { code: 0x60, objNr })]),
    match: (data) => matchDump(data, 0x50, objNr),
    timeoutMs,
    ...(onSendError ? { onSendError } : {}),
    ...(onLate ? { onLate } : {}),
  });
}

/**
 * Send an unidentified request code and return whatever answers, parsed.
 *
 * **Anything at all counts**, not only the response the `+0x10` convention predicts. An unknown
 * request answering with an unexpected code would be the most interesting outcome available, and
 * matching strictly on the convention would throw it away — which is the opposite of the point of
 * sending it.
 */
export function tryCode(
  link: DeviceLink,
  productId: number,
  code: number,
  objNr: number,
  onSendError?: (error: unknown) => void,
): Promise<ReturnType<typeof parseMessage> | undefined> {
  return link.awaitReply({
    send: () => link.output.send([...probeRequest(productId, { code, objNr })]),
    match: (data) => {
      try {
        return parseMessage(data);
      } catch {
        return undefined;
      }
    },
    timeoutMs: UNKNOWN_TIMEOUT_MS,
    ...(onSendError ? { onSendError } : {}),
  });
}
