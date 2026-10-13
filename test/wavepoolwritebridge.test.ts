/**
 * Writing a project's wavetable pool, against the firmware's own handlers.
 *
 * **This path shipped untested against anything but our model of the device.** `writePool` had no
 * emulator test at all: its only mention anywhere in `test/` was as a forbidden name in the
 * Library's read-only check. The firmware session's own note of 2026-10-13 says the same from the
 * other side, that it had not tried a non-zero project slot. So the compare-and-swap that is
 * supposed to stop two writers losing each other's work was, on both sides, a thing the
 * specification said rather than a thing anybody had seen.
 *
 * Two properties, and the second is the one that matters:
 *
 * - A record written at a **non-zero** project slot lands, and the entries read back are the
 *   entries sent. The addressing is per project and the docs say `/wavepool/<project slot>`, but
 *   every run until now had been against slot 0.
 * - **A stale generation is refused, and the record is left alone.** The firmware cannot say it
 *   refused: like every refusal on this route it answers `commit ok` and writes nothing. So the
 *   only way to see it is to read the entries back, which is exactly what a caller would get wrong
 *   by trusting the commit.
 *
 * `/wavepool` needs the modded firmware, so these skip with the rest when it is not configured.
 * `docs/emulator-tests.md` says how to configure it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EmulatorBridge, bridgePaths } from "../src/node/emulatorbridge.js";
import { writePool } from "@noiseandmatter/dnx-core/device/wavepoolwrite.js";
import { readPoolRecord } from "@noiseandmatter/dnx-core/device/wavepoolread.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import { listRequest, wholeListing } from "@noiseandmatter/dnx-core/device/storage.js";
import { buildPoolFile } from "@noiseandmatter/dnx-core/waverider/poolfile.js";
import { writeStoredFile } from "@noiseandmatter/dnx-core/device/storagewrite.js";

const MODDED = process.env["DNX_WAVERIDER_FIRMWARE"];
const skip = !MODDED || bridgePaths({ firmware: MODDED }) === undefined
  ? "no /waverider firmware: set DNX_WAVERIDER_FIRMWARE alongside the bridge variables"
  : false;

const TIMEOUT = 240_000;

/** Armed and asked, explicitly, because the test is the person here. */
const host = {
  ids: new MessageIds(),
  gate: (): void => {},
  confirm: async (): Promise<boolean> => true,
};

async function withBridge<T>(run: (bridge: EmulatorBridge) => Promise<T>): Promise<T> {
  const bridge = await EmulatorBridge.start({ firmware: MODDED!, startupMs: TIMEOUT });
  try {
    return await run(bridge);
  } finally {
    bridge.close();
  }
}

test("a pool record lands at a non-zero project slot, and backs up only an overwrite", { skip }, async () => {
  await withBridge(async (bridge) => {
    const projectSlot = 7;
    // Store slots at pool indexes 0, 1 and 4. The gap is deliberate: a pool with a hole in it is
    // the shape a cleared entry leaves, and padding it wrong would show here.
    const entries = [3, 9, undefined, undefined, 21];

    let backedUp = 0;
    const first = await writePool({
      transport: bridge, host, projectSlot, entries,
      onBackup: () => { backedUp += 1; },
      timeoutMs: TIMEOUT,
    });

    assert.equal(first.cancelled, false);
    assert.equal(first.problem, undefined, "the pool write reported a problem");
    assert.equal(first.projectSlot, projectSlot);
    // **The entries are the proof, not the commit.** A refusal answers ok and writes nothing.
    assert.equal(first.landed, true, "the record did not land at a non-zero project slot");

    /*
     * **No backup, and that is the empty-slot rule rather than a miss.** A blank card has no
     * record at slot 7, so there is nothing to copy and `refuseUnlessEmpty` has already proved it.
     * Asserting a backup here is a mistake I have made before about this exact rule, so the
     * assertion is written as the rule rather than as the expectation.
     */
    assert.equal(backedUp, 0, "a write into a slot with no record has nothing to back up");

    const after = await readPoolRecord(bridge, new MessageIds(), projectSlot, TIMEOUT);
    assert.deepEqual(after.entries.slice(0, entries.length), entries,
      "the entries read back are not the entries sent");
    assert.equal(after.automatic, false, "writing a list must turn automatic off");

    // Now the overwrite, which is the case the hook exists for.
    const second = await writePool({
      transport: bridge, host, projectSlot, entries: [5],
      onBackup: () => { backedUp += 1; },
      timeoutMs: TIMEOUT,
    });
    assert.equal(second.landed, true, "the overwrite did not land");
    assert.equal(backedUp, 1, "an overwrite must hand the caller what it is about to replace");
  });
});

test("a stale generation is refused and the record is left alone", { skip }, async () => {
  /*
   * The case the compare-and-swap exists for: two writers, and the second must not silently
   * discard the first. The firmware cannot report the refusal — like every refusal on this route
   * it answers `commit ok` and writes nothing — so the only way to see it is to read the entries.
   *
   * The stale token has to go on the wire directly. `writePool` re-reads and sends the current
   * generation, which is the right behaviour and precisely what makes it the wrong tool for
   * producing a stale write.
   */
  await withBridge(async (bridge) => {
    const projectSlot = 9;

    const first = await writePool({
      transport: bridge, host, projectSlot, entries: [1, 2, 3],
      onBackup: () => {}, timeoutMs: TIMEOUT,
    });
    assert.equal(first.landed, true, "the setup write did not land");

    const mine = await readPoolRecord(bridge, new MessageIds(), projectSlot, TIMEOUT);

    // Somebody else moves the record while we are still holding `mine`.
    const theirs = await writePool({
      transport: bridge, host, projectSlot, entries: [40, 41],
      onBackup: () => {}, timeoutMs: TIMEOUT,
    });
    assert.equal(theirs.landed, true, "the second writer did not land");

    const moved = await readPoolRecord(bridge, new MessageIds(), projectSlot, TIMEOUT);
    assert.notEqual(moved.generation, mine.generation,
      "the generation did not move, so this test cannot say anything about staleness");

    const ids = new MessageIds();
    const listId = ids.reserve(1);
    const listing = wholeListing(
      await bridge.request(listRequest(listId, "/wavepool"), listId, TIMEOUT),
      "/wavepool",
    );
    const target = listing.entries.find((e) => e.index === projectSlot);
    assert.ok(target, "the /wavepool listing does not carry this project slot");

    await writeStoredFile(
      `/wavepool/${projectSlot}`,
      buildPoolFile({
        projectSlot,
        automatic: false,
        entries: [99, 98, 97],
        generation: mine.generation,
      }),
      undefined,
      { transport: bridge, target, overwrite: true, timeoutMs: TIMEOUT },
    );

    const afterStale = await readPoolRecord(bridge, new MessageIds(), projectSlot, TIMEOUT);
    assert.deepEqual(afterStale.entries.slice(0, 3), [40, 41, undefined],
      "a write carrying a stale generation overwrote the record it should have been refused over");
    assert.equal(afterStale.generation, moved.generation, "the refused write moved the generation");

    /*
     * **The control, and without it this test proves much less than it claims.**
     *
     * An unchanged record is equally consistent with "refused because the generation was stale"
     * and "refused because those bytes were malformed", and `wavepoolwrite.ts` says in as many
     * words that the two are indistinguishable from here. So send the *same* record again with
     * the current generation. If it lands, the bytes were fine and the generation was the only
     * difference between the two attempts, which is the claim being made.
     */
    const freshTarget = (() => {
      const control = new MessageIds();
      const id = control.reserve(1);
      return { control, id };
    })();
    const listing2 = wholeListing(
      await bridge.request(
        listRequest(freshTarget.id, "/wavepool"),
        freshTarget.id,
        TIMEOUT,
      ),
      "/wavepool",
    );
    const target2 = listing2.entries.find((e) => e.index === projectSlot);
    assert.ok(target2, "the /wavepool listing lost this project slot");

    await writeStoredFile(
      `/wavepool/${projectSlot}`,
      buildPoolFile({
        projectSlot,
        automatic: false,
        entries: [99, 98, 97],
        generation: moved.generation,
      }),
      undefined,
      { transport: bridge, target: target2, overwrite: true, timeoutMs: TIMEOUT },
    );

    const afterControl = await readPoolRecord(bridge, new MessageIds(), projectSlot, TIMEOUT);
    assert.deepEqual(afterControl.entries.slice(0, 3), [99, 98, 97],
      "the same record with the current generation did not land either, so the refusal above " +
        "says nothing about staleness and this whole test is measuring something else");
  });
});
