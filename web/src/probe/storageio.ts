/**
 * Talking to the +Drive, and proving the link before believing a silence.
 *
 * ## What belongs here and what does not
 *
 * **What we say to the device.** Not what we tell the user about it — the cards, the status line and
 * the narration stay on the page, because they are what that page is for. The split matters: a
 * conversation returns what came back or `undefined`, and the page decides what that means.
 *
 * That is also what makes these testable. A card needs a browser; a conversation needs a link, and
 * a link can be faked (`test/devicelink.test.ts` does).
 *
 * ## Every request here is a read
 *
 * Listing, asking and reading a file cannot change an instrument. That is the property that made
 * guessing the request shape reasonable in the first place: the responses were decoded from
 * Elektron Transfer's own traffic, the requests are reconstructions, and being wrong costs a round
 * trip and an `Invalid path` — see `docs/device-storage.md`.
 */

import { Code, deviceRequest } from "../../../src/device/api.js";
import { StorageCode, listRequest } from "../../../src/device/storage.js";
import { DeviceLink, matchApiFrame } from "../devicelink.js";

/** Fixed and high, so a reply can be matched to it and it cannot collide with Transfer's low ids. */
export const LINK_ID = 40_000;
export const LINK_TIMEOUT_MS = 1500;
export const LIST_TIMEOUT_MS = 4000;

/**
 * Ask the device something it must answer, and report whether it did.
 *
 * **`output.send()` does not throw when another application holds the port.** It returns normally
 * and the bytes go nowhere — so a silence means either *the device did not answer* or *we never
 * spoke*, and those are different findings. This page spent three days resolving that ambiguity by
 * assumption.
 *
 * The cost is on the record. `DirList` timing out was one of two pillars holding up the conclusion
 * *"the +Drive file API does not exist on a Digitone"*; if Transfer was running at the time, that
 * request may never have left the machine. The API turned out to exist.
 *
 * `Device` is the control because every Elektron answers it, it takes no arguments, and it is
 * already the first thing the probe sends.
 */
export async function linkIsAlive(link: DeviceLink, issue: (id: number) => number): Promise<boolean> {
  const frame = await link.awaitReply({
    send: () => link.output.send([...deviceRequest(issue(LINK_ID))]),
    // Transfer polls `Device` too, so a bare code match would pass on its traffic. Ours is the one
    // answering the id we just sent.
    match: (data) => matchApiFrame(data, (f) => f.code === Code.Device + 0x80 && f.respId === LINK_ID),
    timeoutMs: LINK_TIMEOUT_MS,
  });
  return frame !== undefined;
}

/** A page of a directory listing. Omitted entirely to ask for the whole thing. */
export interface ListingPage {
  start: number;
  count: number;
}

/**
 * Ask what is on the +Drive at `path`.
 *
 * Returns the **reply body**, or `undefined` for silence — which a caller must not read as "empty".
 * Those are different answers and only one of them is about the directory.
 *
 * Undecoded on purpose. A listing that arrives and fails to parse is a finding worth reporting in
 * detail — the first bytes, and whether the device said `Invalid path` — and that reporting belongs
 * to whoever is drawing the card, not here. Handing back a parsed array would throw that away.
 *
 * A listing states each entry's **position** in a 32-bit field, which is the thing the dump
 * protocol's 7-bit object number cannot do, and the reason a project browser is possible at all.
 */
export async function requestListing(
  link: DeviceLink,
  msgId: number,
  path: string,
  page: ListingPage | undefined,
  onSendError?: (error: unknown) => void,
): Promise<Uint8Array | undefined> {
  const frame = await link.awaitReply({
    send: () => link.output.send([...listRequest(msgId, path, page)]),
    // Only an API frame answering **this request** counts, and the message id is what decides that.
    // Matching the response code alone is not enough: Elektron Transfer polls the same port
    // constantly and lists directories of its own, so a `0xd3` arriving while we wait is as likely
    // to be its answer as ours. Accepting "the next message" is exactly how its traffic got
    // reported as our result once already.
    match: (data) =>
      matchApiFrame(data, (f) => f.respId === msgId && f.code === StorageCode.List + 0x80),
    timeoutMs: LIST_TIMEOUT_MS,
    ...(onSendError ? { onSendError } : {}),
  });

  return frame?.body;
}

// `LINK_DEAD` moved to `silence.ts`, which is where the verdict it belongs to is now decided.
// Two copies of one sentence in two files is the shape of the problem that module exists to end.
