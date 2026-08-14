/**
 * A `WritePermit` for tests that exercise the primitives directly.
 *
 * The primitives are worth testing on their own — `writeChangedRecords`' diff and
 * `writeStoredFile`'s chunking are where the protocol lives, and going through the safe path to
 * reach them would mean every one of those tests also stubbing a backup hook and a confirmation it
 * is not testing.
 *
 * So there is one cast here, and `safewrite.test.ts` allows exactly this file and no other in the
 * test tree. That is the same shape as the exemption in `src/`: a single named place, so a second
 * one is a diff somebody has to look at rather than a line nobody notices.
 */

import { type WritePermit } from "../src/device/writepermit.js";

export const TEST_PERMIT = Object.freeze({}) as unknown as WritePermit;
