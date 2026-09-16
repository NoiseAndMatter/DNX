/**
 * The dump-type table, checked against the files rather than against memory.
 *
 * **This exists because the table was wrong and the error left the repository.** `CONFIRMED` held
 * two combinations while the corpus held eight, so `inspect` labelled an ordinary Digitone II
 * Sound dump an "unconfirmed product/type combination", `docs/sysex-format.md` said `0x53` was
 * confirmed on the Digitone only, and a reader who trusted that spent an evening looking for a
 * Digitone-format variant of a file that was already correct. 1,008 Digitone II Sound captures
 * were sitting in the corpus the whole time.
 *
 * A table of what has been observed cannot be maintained by hand. This walks the captures and
 * fails when one carries a combination nobody has written down.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseFile } from "../src/sysex/container.js";
import {
  ProductId, UNNAMED_DN1_TYPES, describeDumpType, describeProduct, isConfirmedCombination,
} from "../src/sysex/devices.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

/**
 * The Transfer protocol shares the Elektron manufacturer id, so its messages parse here with the
 * header byte `0x10` sitting where a product id would be. It is a different protocol with a
 * different ID space and none of its codes belong in this table.
 */
const TRANSFER_HEADER = 0x10;

interface Seen { product: number; dumpType: number; count: number; payload: Set<number> }

/** Every product/type combination in the capture corpus, with how often it appears. */
function survey(): Map<string, Seen> {
  const out = new Map<string, Seen>();
  const dir = join(CORPUS!, "..", "99_HardwareTest");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".syx"))) {
    let messages;
    try {
      messages = parseFile(new Uint8Array(readFileSync(join(dir, file))));
    } catch {
      continue; // A capture this parser cannot read is a different test's problem.
    }
    for (const m of messages) {
      if (m.productId === TRANSFER_HEADER) continue;
      const key = `${m.productId}:${m.dumpType}`;
      const row = out.get(key) ?? { product: m.productId, dumpType: m.dumpType, count: 0, payload: new Set() };
      row.count++;
      row.payload.add(m.payload.length);
      out.set(key, row);
    }
  }
  return out;
}

test("every combination in the corpus is one the table knows about", { skip: NO_CORPUS && SKIP_REASON }, () => {
  const unknown: string[] = [];
  for (const row of survey().values()) {
    if (isConfirmedCombination(row.product, row.dumpType)) continue;
    // Named products only: an unnamed Digitone type is recorded as observed, not understood.
    if (row.product === ProductId.DN1 && (UNNAMED_DN1_TYPES as readonly number[]).includes(row.dumpType)) {
      continue;
    }
    unknown.push(
      `${describeProduct(row.product)} / ${describeDumpType(row.dumpType)} ` +
        `(0x${row.product.toString(16)}:0x${row.dumpType.toString(16)}) x${row.count}`,
    );
  }
  assert.deepEqual(unknown, [],
    "add these to CONFIRMED in src/sysex/devices.ts, or to UNNAMED_DN1_TYPES if nothing names them");
});

test("the Digitone II speaks Sound dumps, which the table once denied", { skip: NO_CORPUS && SKIP_REASON }, () => {
  /*
   * Pinned on its own because this is the specific claim that was wrong, and because a regression
   * here is not an abstract table error: it is `inspect` telling somebody their file is suspect.
   */
  const rows = survey();
  const dn2sound = rows.get(`${ProductId.DN2}:0x53`) ?? rows.get(`${ProductId.DN2}:${0x53}`);
  assert.ok(dn2sound, "no Digitone II Sound dumps in the corpus");
  assert.ok(dn2sound.count > 100, `only ${dn2sound.count} Digitone II Sound captures`);
  assert.deepEqual([...dn2sound.payload], [359], "a Digitone II sound object is 359 bytes");
  assert.ok(isConfirmedCombination(ProductId.DN2, 0x53));

  const dn1sound = rows.get(`${ProductId.DN1}:${0x53}`);
  assert.ok(dn1sound, "no Digitone Sound dumps in the corpus");
  assert.deepEqual([...dn1sound.payload], [302], "a Digitone sound object is 302 bytes");
  assert.ok(isConfirmedCombination(ProductId.DN1, 0x53),
    "0x53 means Sound on both instruments; only the object size differs");
});
