/**
 * What this page is connected to, and every id it has put on the wire.
 *
 * ## One place that knows which instrument we are talking to
 *
 * Three things travel together and were read from six different sections: the MIDI access the
 * browser granted, which two ports the instrument is, and the **dump-protocol** product id the
 * last probe worked out. Any module that sends needs all three, and none of them is that module's
 * business to own.
 *
 * The product id is converted from the API id the `Device` response gives, because they are
 * different numbering spaces: the API says 20 and 43, the dump framing wants 0x0D and 0x15. The
 * first request this project ever sent went out addressed to 43 and was rightly ignored.
 *
 * ## Why the ids are kept forever
 *
 * `issuedIds` is the only thing that can settle "whose reply is this", and it is deliberately
 * never cleared: a late answer to a request from ten minutes ago is still **ours**, and forgetting
 * that is how a stale reply gets mistaken for another application's traffic. A capture of 6,404 of
 * our own reads was once labelled `Not ours: 8192, 8193, …` for exactly that reason.
 */

import { requestPatternKit } from "./dumpio.js";
import { PortPicker } from "./ports.js";
import { linkIsAlive as checkLink } from "./storageio.js";
import { $ } from "../dom.js";
import { type ApiTransport } from "@noiseandmatter/dnx-core/device/storagesession.js";
import { DeviceLink } from "../devicelink.js";

export let access: MIDIAccess | undefined;

/** Record the access this page was granted. Set once, by `connect`. */
export function setAccess(granted: MIDIAccess | undefined): void {
  access = granted;
}

/**
 * The **dump-protocol** product id for the device last probed.
 *
 * Converted from the API id the `Device` response gives, because they are different numbering
 * spaces: the API says 20 and 43, the dump framing wants 0x0D and 0x15. The first request went
 * out addressed to 43 and was rightly ignored.
 */
export let lastProductId: number | undefined;

/** Record what the last probe found, or clear it. Set by `probe`. */
export function setLastProductId(productId: number | undefined): void {
  lastProductId = productId;
}

/**
 * Which two ports are the instrument.
 *
 * The guessing and remembering live in `ports.ts`; this page keeps only what it does with the
 * answer — which buttons that enables and what the status line says about it.
 */
export const ports = new PortPicker($<HTMLSelectElement>("input"), $<HTMLSelectElement>("output"));

/**
 * Every message id this page has put on the wire.
 *
 * Cheap to keep and the only thing that can settle "whose reply is this". Deliberately never
 * cleared — a late answer to a request from ten minutes ago is still *ours*, and forgetting that is
 * how a stale reply gets mistaken for someone else's traffic.
 */
export const issuedIds = new Set<number>();

/** Record an id as ours, and hand it straight back so a call site reads as one expression. */
export function issue(id: number): number {
  issuedIds.add(id);
  return id;
}

/**
 * Every request path on this page waits through `DeviceLink`, which attaches its own listener per
 * request. There is deliberately no shared slot here any more: one used to serve seven paths, and
 * two overlapping reads stole each other's answers.
 */
export function linkTo(output: MIDIOutput): DeviceLink {
  const input = access && ports.input(access);
  if (!input) throw new Error("that input port is no longer there — press Rescan");
  return new DeviceLink(input, output);
}

/** Ask for one patternKit and wait for it, tolerating a late reply. */
export function awaitPatternKit(
  output: MIDIOutput, productId: number, objNr: number,
): Promise<Uint8Array | undefined> {
  return requestPatternKit(linkTo(output), productId, objNr);
}

/** Is anything we send reaching the device? See `storageio.ts` for why this exists. */
export async function linkIsAlive(output: MIDIOutput): Promise<boolean> {
  return checkLink(linkTo(output), issue);
}

/**
 * Web MIDI as an `ApiTransport`.
 *
 * The correlation lives in `devicelink.ts` and is shared with the manager's device source. This
 * page's own contribution is `issue`: the id is recorded as ours **before** the send, so a reply
 * cannot arrive before its id is known. Omitting that is why a capture of 6,404 of our own reads
 * was once labelled `Not ours: 8192, 8193, …` — the verdict was confidently wrong about traffic we
 * had just generated.
 */
export function apiTransport(output: MIDIOutput): ApiTransport {
  return linkTo(output).transport({ onSend: issue });
}
