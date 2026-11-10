/**
 * A directory listing asked for in pages.
 *
 * **One job: list a directory without one large reply.** A listing without a page asks the
 * instrument for the whole directory in one reply. On 2026-11-09 the table store did not survive
 * that. With 97 tables named like `ESW Real - Big Brass 02_wt4096`, the reply stopped at 3,997
 * bytes, and its last entries were corrupt: slot 126 came back as index 114, then bytes that are not
 * an entry. The same directory asked for in four pages of 64 came back clean, every index correct.
 *
 * The store's own handler gives the router all 256 entries. The router builds the reply, so the
 * fault is in the instrument's reply path, which was not sized for 256 long names. Pages keep each
 * reply under about 2 KB.
 *
 * A page past the end comes back empty, with a declared count of 0. A page that crosses the end is
 * clipped, so `{ first: 250, end: 300 }` gives the 6 entries 250 to 255.
 */

import { type Entry, ListingError, listRequest, wholeListing } from "./storage.js";
import { type ApiTransport } from "./storagesession.js";

/** Entries per page. 64 long names make about 2 KB. */
export const LISTING_PAGE = 64;

/** Every entry of `path`, one page at a time. `nextId` gives a fresh message id for each request. */
export async function listInPages(
  transport: ApiTransport,
  path: string,
  nextId: () => number,
  timeoutMs: number,
): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (let first = 0; ; first += LISTING_PAGE) {
    const id = nextId();
    const reply = await transport.request(listRequest(id, path, { first, end: first + LISTING_PAGE }), id, timeoutMs);
    const page = wholeListing(reply, path).entries;
    // A reply that is not the page asked for would repeat forever. Refuse it.
    if (page.length > LISTING_PAGE || page.some((entry) => entry.index < first || entry.index >= first + LISTING_PAGE)) {
      throw new ListingError(
        `${path}: asked for entries ${first} to ${first + LISTING_PAGE - 1} and got ` +
          `${page.length} starting at ${page[0]?.index ?? "none"}`,
      );
    }
    entries.push(...page);
    if (page.length < LISTING_PAGE) return entries;
  }
}

/** The entry at `index` in `path`, asked for as a page of one. `undefined` when there is none. */
export async function listOne(
  transport: ApiTransport,
  path: string,
  index: number,
  msgId: number,
  timeoutMs: number,
): Promise<Entry | undefined> {
  const reply = await transport.request(listRequest(msgId, path, { first: index, end: index + 1 }), msgId, timeoutMs);
  return wholeListing(reply, path).entries.find((entry) => entry.index === index);
}
