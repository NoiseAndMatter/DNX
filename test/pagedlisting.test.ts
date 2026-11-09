/**
 * Listing the table store in pages, against a scripted store that breaks the way the instrument did.
 *
 * On 2026-11-09 the instrument answered a listing of `/waverider` without a page with a reply that
 * stopped near 4 KB and ended in bytes that are not an entry. This fake does the same for any
 * request without a page, so a caller that goes back to one large request fails here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApiFrame, RESPONSE_BIT, decodeMessage } from "@noiseandmatter/dnx-core/device/api.js";
import { StorageCode } from "@noiseandmatter/dnx-core/device/storage.js";
import { type ApiTransport } from "@noiseandmatter/dnx-core/device/storagesession.js";
import { LISTING_PAGE, listInPages, listOne } from "@noiseandmatter/dnx-core/device/pagedlisting.js";

const SLOTS = 256;
const NAMED = 97;

function push32(out: number[], v: number): void {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}
const u32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/** Slots 0 to 96 hold long names. The rest are empty. */
const nameOf = (slot: number): string => (slot < NAMED ? `ESW Real - Big Brass ${slot}_wt4096` : "");

/** A listing reply for slots `first` to `end - 1`, clipped to the store. */
function page(first: number, end: number): Uint8Array {
  const last = Math.min(end, SLOTS);
  const count = Math.max(0, last - first);
  const parts: number[] = [1];
  push32(parts, first);
  push32(parts, first + count);
  push32(parts, count);
  for (let slot = first; slot < last; slot++) {
    for (const ch of nameOf(slot)) parts.push(ch.charCodeAt(0));
    parts.push(0, 0x00, 0x02);
    push32(parts, slot);
    push32(parts, 524_288);
    const used = slot < NAMED ? 1 : 0;
    parts.push(0x00, 0x7e, used, used);
  }
  return Uint8Array.from(parts);
}

/** The store, answering pages correctly and an unpaged request with a corrupt tail. */
function store(): ApiTransport & { pages: { first: number; end: number }[]; unpaged: number } {
  const pages: { first: number; end: number }[] = [];
  const io = {
    pages,
    unpaged: 0,
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const { code, body } = decodeMessage(request);
      if (code !== StorageCode.List) return Promise.reject(new Error(`the fake store does not answer 0x${code.toString(16)}`));
      const nul = body.indexOf(0);
      let reply: Uint8Array;
      if (body.length >= nul + 9) {
        const first = u32(body, nul + 1);
        const end = u32(body, nul + 5);
        pages.push({ first, end });
        reply = page(first, end);
      } else {
        io.unpaged += 1;
        // What the instrument sent: the start of the whole listing, then bytes that are not an entry.
        const whole = page(0, SLOTS);
        reply = Uint8Array.from([...whole.subarray(0, 3_800), 0x80, 0x80, 0x2c, 0x80, 0x00, 0x00, 0x00]);
      }
      return Promise.resolve({ msgId, respId: msgId, code: code | RESPONSE_BIT, body: reply, isResponse: true, terminated: true });
    },
  };
  return io;
}

test("the fake store fails an unpaged listing the way the instrument did", () => {
  // Proves the fixture: a whole listing of this store is longer than the cut, so one large reply is broken.
  assert.ok(page(0, SLOTS).length > 3_800);
});

test("a whole store comes back in pages of 64, every slot with its own index", async () => {
  const io = store();
  let id = 0;
  const entries = await listInPages(io, "/waverider", () => ++id, 1_000);

  assert.equal(io.unpaged, 0);
  assert.equal(entries.length, SLOTS);
  assert.deepEqual(entries.map((e) => e.index), Array.from({ length: SLOTS }, (_, i) => i));
  assert.equal(entries.filter((e) => e.occupied).length, NAMED);
  assert.equal(entries[96]!.name, "ESW Real - Big Brass 96_wt4096");
  assert.ok(io.pages.every((p) => p.end - p.first === LISTING_PAGE));
  // Four full pages, then one past the end that comes back empty.
  assert.deepEqual(io.pages.map((p) => p.first), [0, 64, 128, 192, 256]);
  // Each request has its own message id.
  assert.equal(id, 5);
});

test("one slot is asked for as a page of one", async () => {
  const io = store();
  const entry = await listOne(io, "/waverider", 96, 7, 1_000);

  assert.equal(io.unpaged, 0);
  assert.deepEqual(io.pages, [{ first: 96, end: 97 }]);
  assert.equal(entry?.index, 96);
  assert.equal(entry?.name, "ESW Real - Big Brass 96_wt4096");
  assert.equal(entry?.occupied, true);
});

test("a slot past the end of the store is not there", async () => {
  const entry = await listOne(store(), "/waverider", 300, 7, 1_000);
  assert.equal(entry, undefined);
});

test("a store that ignores the page is refused, not asked again forever", async () => {
  // Answers every request with the whole listing, as a store without paging would.
  const ignoring: ApiTransport = {
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const { code } = decodeMessage(request);
      return Promise.resolve({ msgId, respId: msgId, code: code | RESPONSE_BIT, body: page(0, SLOTS), isResponse: true, terminated: true });
    },
  };
  let id = 0;
  await assert.rejects(listInPages(ignoring, "/waverider", () => ++id, 1_000), /asked for entries 0 to 63 and got 256/);
  assert.equal(id, 1);
});
