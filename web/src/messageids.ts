/**
 * The one numbering space this page uses, and the names its callers already import.
 *
 * The allocator itself is `src/device/messageids.ts`, where it is a `MessageIds` instance rather
 * than a module-level counter: core may hold no mutable state, and an Android host will keep its
 * own instance. **A page, though, must have exactly one**, because the whole point of the thing is
 * that no two conversations on one wire choose the same ids. So the single instance lives here,
 * beside the browser, and every page reaches it through the same two functions it always did.
 *
 * The file this replaces explains why that matters, with the two occasions it has cost this
 * project. That history is worth reading before adding a second allocator anywhere.
 */

import { MessageIds } from "../../src/device/messageids.js";

export {
  FIRST_MESSAGE_ID,
  IDS_FOR,
  MAX_MESSAGE_ID,
  MESSAGE_ID_SPAN,
  MessageIds,
} from "../../src/device/messageids.js";

/** Every conversation this page has, numbered from here. */
const ids = new MessageIds();

/** Reserve a run of ids no other conversation on this page will use. */
export function reserveMessageIds(count: number): number {
  return ids.reserve(count);
}

/** Reset the page's allocator. **Tests only** — a page never restarts its conversation space. */
export function resetMessageIdsForTest(): void {
  ids.reset();
}
