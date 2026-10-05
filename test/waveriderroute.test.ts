/**
 * The `/waverider` route, read by DNX's own parser, on firmware in an emulator.
 *
 * ## What is new here, and it is the whole point
 *
 * Everything before this checked that **two readings of a document agreed**: DNX's TypeScript and
 * the firmware session's Python both produced the same bytes from `waverider-store.md`, which is a
 * real result and still only a result about the document.
 *
 * These tests go a step further. The store on the emulator's card is **DNX's own planner output**,
 * placed at the sectors the plan names, and the reader is the firmware's. So what is checked is
 * whether the bytes DNX would send mean to the instrument what they mean here.
 *
 * ## Still not the instrument
 *
 * The emulator's card is blank apart from what is placed on it, nothing is flashed, and format 1's
 * byte order remains a hypothesis until a loaded table **sounds** right. A green run here is what
 * makes flashing reasonable, not a substitute for it.
 *
 * Needs `DNX_WAVERIDER_FIRMWARE` as well as the bridge variables, since this is a modded image.
 * It boots from reset, so these are slower than the stock ones and there is no saved state yet.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { EmulatorBridge, bridgePaths } from "../src/node/emulatorbridge.js";
import { listRequest, parseListing } from "@noiseandmatter/dnx-core/device/storage.js";
import { REGION_START } from "@noiseandmatter/dnx-core/waverider/layout.js";
import { planWrite } from "@noiseandmatter/dnx-core/waverider/plan.js";

const MODDED = process.env["DNX_WAVERIDER_FIRMWARE"];
const skip = !MODDED || bridgePaths({ firmware: MODDED }) === undefined
  ? "no /waverider firmware: set DNX_WAVERIDER_FIRMWARE alongside the bridge variables"
  : false;

const TIMEOUT = 180_000;
const scratch = skip ? "" : mkdtempSync(join(tmpdir(), "dnx-waverider-"));

/** The plan whose bytes a second implementation already replayed, byte for byte. */
function oneTablePlan() {
  const payload = new Uint8Array(16 * 512 * 2);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
  return planWrite({
    tables: [{
      slot: 0, name: "RAMP7_wt512", waves: 16, points: 512, interpolate: true,
      payload, sourceHash: 0x831953bc, sourceSize: 16_384, gain: 1,
    }],
  });
}

/**
 * Put a plan on the card as files, at the sectors the plan names.
 *
 * The superblock is region sector 0 and the index is 1..64, so they are contiguous and go as one
 * file at the region's start. **Nothing here re-derives a position**: every sector comes from the
 * plan, which is the property that makes this a test of the plan rather than of this function.
 */
function cardFor(plan: ReturnType<typeof planWrite>, corrupt?: (meta: Uint8Array) => void) {
  const sb = plan.writes.find((w) => w.what === "superblock")!;
  const ix = plan.writes.find((w) => w.what === "index")!;
  assert.equal(ix.sector, sb.sector + sb.length / 512, "superblock and index must be contiguous");

  const meta = new Uint8Array(sb.length + ix.length);
  meta.set(sb.bytes, 0);
  meta.set(ix.bytes, sb.length);
  corrupt?.(meta);

  const name = `${Math.random().toString(36).slice(2)}`;
  const metaFile = join(scratch, `meta-${name}.bin`);
  writeFileSync(metaFile, meta);

  const extents = [{ sector: REGION_START + sb.sector, file: metaFile }];
  for (const [i, write] of plan.writes.filter((w) => w.what === "data").entries()) {
    const file = join(scratch, `data-${name}-${i}.bin`);
    writeFileSync(file, write.bytes);
    extents.push({ sector: write.absoluteSector, file });
  }
  return extents;
}

const open = new Set<EmulatorBridge>();
async function withCard<T>(
  extents: readonly { sector: number; file: string }[],
  body: (io: EmulatorBridge) => Promise<T>,
): Promise<T> {
  const io = await EmulatorBridge.start({ firmware: MODDED!, cardExtents: extents, startupMs: TIMEOUT });
  open.add(io);
  try {
    return await body(io);
  } finally {
    open.delete(io);
    await io.close();
  }
}
after(async () => { for (const io of open) await io.close(); });

test("the root lists four directories, and the fourth looks like the other three", { skip }, async () => {
  await withCard([], async (io) => {
    const listing = parseListing((await io.request(listRequest(1, "/"), 1, TIMEOUT)).body);

    assert.equal(listing.declared, 4, "declared must match carried or requireWholeListing refuses");
    assert.equal(listing.entries.length, 4);
    assert.ok(listing.complete);
    assert.deepEqual(listing.entries.map((e) => e.name), ["projects", "soundbanks", "kits", "waverider"]);

    const waverider = listing.entries[3]!;
    assert.equal(waverider.kind, "directory");
    assert.equal(waverider.children, 256);
    // Short form carries a child count and nothing else. A long-form root entry would parse and
    // then mean something different, so this is worth asserting rather than assuming.
    assert.equal(waverider.size, undefined);
    assert.equal(waverider.permissions, undefined);
  });
});

test("an empty store lists 256 free slots, numbered from zero", { skip }, async () => {
  await withCard([], async (io) => {
    const listing = parseListing((await io.request(listRequest(2, "/waverider"), 2, TIMEOUT)).body);

    assert.equal(listing.declared, 256);
    assert.equal(listing.entries.length, 256);
    assert.ok(listing.complete);

    // **Zero-based, deliberately unlike /projects' 1..128.** Chosen so `/waverider/<n>` is index
    // entry n with no arithmetic, and written down on both sides because it is the kind of
    // difference that is obvious to whoever chose it and to nobody else.
    const indices = listing.entries.map((e) => e.index);
    assert.equal(indices[0], 0);
    assert.equal(indices.at(-1), 255);
    assert.deepEqual(indices, indices.map((_, i) => i));

    for (const entry of listing.entries) {
      assert.equal(entry.kind, "file");
      assert.equal(entry.size, 16_384, "the slot's allocation, not a file length");
      // The two fields that would stop a write locally if they were wrong.
      assert.equal(entry.permissions, 0x007e);
      assert.equal(entry.writable, true);
      assert.equal(entry.occupied, false);
      assert.equal(entry.name, "");
    }
  });
});

test("the firmware reads a store DNX planned, and names the table", { skip }, async () => {
  // **The first time either side has read the other's bytes.** The card holds the planner's own
  // output at the planner's own sectors; the reader is the firmware's.
  await withCard(cardFor(oneTablePlan()), async (io) => {
    const listing = parseListing((await io.request(listRequest(3, "/waverider"), 3, TIMEOUT)).body);
    assert.equal(listing.entries.length, 256);

    const used = listing.entries.filter((e) => e.occupied);
    assert.equal(used.length, 1, "one table in, one table out");
    assert.equal(used[0]!.index, 0, "slot 0, where the plan put it");
    assert.equal(used[0]!.name, "RAMP7_wt512");

    for (const entry of listing.entries.slice(1)) {
      assert.equal(entry.occupied, false, `slot ${entry.index} must still be free`);
      assert.equal(entry.name, "");
    }
  });
});

test("one flipped byte in the superblock makes the whole store read as empty", { skip }, async () => {
  /*
   * The control, and the reason the two-group scheme is worth its complexity. The card holds a
   * perfectly good index and a perfectly good table; only the superblock's own hash is wrong.
   *
   * **The firmware must not read the index anyway.** If it did, a half-written superblock would
   * let a half-written store be played, which is precisely the failure the generation-and-hash
   * rule exists to prevent — and it would pass every test that only ever writes good stores.
   */
  const plan = oneTablePlan();
  await withCard(cardFor(plan, (meta) => { meta[63] = meta[63]! ^ 1; }), async (io) => {
    const listing = parseListing((await io.request(listRequest(4, "/waverider"), 4, TIMEOUT)).body);
    assert.equal(listing.entries.length, 256, "the directory is still there");
    assert.equal(listing.entries.filter((e) => e.occupied).length, 0, "and nothing in it is claimed");
  });
});

test("the route changes nothing about the stock directories", { skip }, async () => {
  // A new route that quietly altered /projects would be the worst outcome here, and it is exactly
  // the kind of thing a test for the new thing does not look at.
  await withCard(cardFor(oneTablePlan()), async (io) => {
    const projects = parseListing((await io.request(listRequest(5, "/projects"), 5, TIMEOUT)).body);
    assert.equal(projects.declared, 128);
    assert.equal(projects.entries.length, 128);
    assert.equal(projects.entries[0]!.index, 1, "still one-based, unlike /waverider");
    assert.equal(projects.entries[0]!.size, 16 * 1024 * 1024);

    for (const [path, children] of [["/kits", 8], ["/soundbanks", 8]] as const) {
      const listing = parseListing((await io.request(listRequest(6, path), 6, TIMEOUT)).body);
      assert.equal(listing.entries.length, children);
      assert.deepEqual(listing.entries.map((e) => e.name), ["A", "B", "C", "D", "E", "F", "G", "H"]);
    }
  });
});
