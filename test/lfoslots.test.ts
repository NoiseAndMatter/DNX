/**
 * The LFO slot table, checked against the sound objects rather than against memory.
 *
 * **Two modules described these eight controls and disagreed about three of them.** Neither could
 * have been right: each carried one word for two independent facts, so `SPD` and `DEP`, which are
 * bipolar *and* fine, had nowhere to say so, and `plockparams.ts` classified `FADE` and `MULT` by
 * falling through a ternary's default branch.
 *
 * A table of what has been observed cannot be maintained by hand. This recounts it.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LFO_SLOTS, lfoSlot } from "../src/project/lfoslots.js";
import { PLOCK_PARAMETERS } from "../src/project/plockparams.js";
import { SOUND_PARAMETERS } from "../src/project/soundparams.js";
import { DN2_KIT, DN2_LAYOUT, kitRecord } from "../src/project/dn2image.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { CORPUS, DN2_PROJECTS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

interface Observed { min: number; max: number; mode: number; fineUsed: number; n: number }

/** Every reading of every LFO slot in every full-length sound record in the corpus. */
function survey(): Map<string, Observed> {
  const hist = LFO_SLOTS.map(() => new Map<number, number>());
  const fine = LFO_SLOTS.map(() => 0);
  let n = 0;

  const dir = join(CORPUS!, DN2_PROJECTS);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".dn2prj"))) {
    let image: Uint8Array;
    try {
      image = decodeProjectImage(parseProject(new Uint8Array(readFileSync(join(dir, f)))).payload.raw).image;
    } catch {
      continue;
    }
    for (let p = 0; p < DN2_LAYOUT.patternCount; p++) {
      let kit: Uint8Array;
      try { kit = kitRecord(image, p, DN2_LAYOUT); } catch { continue; }
      for (let t = 0; t < DN2_KIT.soundCount; t++) {
        const b = DN2_KIT.soundOffset + t * DN2_KIT.soundSize;
        // A short object has no arp region and no full LFO grid either.
        if (!(kit[b + 355] === 0xba && kit[b + 356] === 0xce)) continue;
        n++;
        for (let s = 0; s < LFO_SLOTS.length; s++) {
          for (let lfo = 0; lfo < 3; lfo++) {
            const off = b + 30 + 8 * s + 2 * lfo;
            const c = kit[off]!;
            hist[s]!.set(c, (hist[s]!.get(c) ?? 0) + 1);
            if (kit[off + 1] !== 0) fine[s]!++;
          }
        }
      }
    }
  }

  const out = new Map<string, Observed>();
  LFO_SLOTS.forEach((slot, s) => {
    const h = hist[s]!;
    const keys = [...h.keys()].sort((a, z) => a - z);
    const mode = [...h].sort((a, z) => z[1] - a[1])[0]![0];
    out.set(slot.name, { min: keys[0]!, max: keys[keys.length - 1]!, mode, fineUsed: fine[s]!, n: n * 3 });
  });
  return out;
}

test("every slot's range and resting value are what the table claims",
  { skip: NO_CORPUS && SKIP_REASON }, () => {
  const seen = survey();
  for (const slot of LFO_SLOTS) {
    const o = seen.get(slot.name)!;
    assert.ok(o.n > 1000, `${slot.name}: only ${o.n} readings, too few to check`);
    assert.deepEqual([o.min, o.max], [...slot.range],
      `${slot.name} spans ${o.min}..${o.max}, table says ${slot.range.join("..")}`);
    assert.equal(o.mode, slot.restsAt,
      `${slot.name} rests at ${o.mode}, table says ${slot.restsAt}`);
  }
});

test("a slot carries a fine byte exactly when the table says it does",
  { skip: NO_CORPUS && SKIP_REASON }, () => {
  /*
   * **This is the fact the old single-word type could not hold.** `SPD` and `DEP` use their fine
   * byte in thousands of records; the rest are noise, and noise is what "fine: false" means here.
   */
  const seen = survey();
  for (const slot of LFO_SLOTS) {
    const used = seen.get(slot.name)!.fineUsed;
    if (slot.fine) assert.ok(used > 500, `${slot.name} is marked fine and only ${used} records use it`);
    else assert.ok(used < 100, `${slot.name} is not marked fine but ${used} records carry one`);
  }
});

test("polarity follows from where a slot rests", { skip: NO_CORPUS && SKIP_REASON }, () => {
  /*
   * A bipolar control stored as `value + 64` sits at 64 when it is doing nothing. `SPD` is the
   * exception the table already names: it rests at 112, which is +48 read as bipolar and is the
   * factory default speed, so its polarity is inherited rather than derived here.
   */
  for (const slot of LFO_SLOTS) {
    if (slot.name === "SPD") continue;
    if (slot.polarity === "bipolar") assert.equal(slot.restsAt, 64, `${slot.name} claims bipolar`);
    if (slot.polarity === "unipolar") assert.equal(slot.restsAt, 0, `${slot.name} claims unipolar`);
  }
});

test("both tables now say the same thing about every slot", () => {
  // The whole point of the shared file. No corpus needed: this compares the two derived tables.
  for (const slot of LFO_SLOTS) {
    const locks = PLOCK_PARAMETERS.filter((p) => p.name === slot.name && p.page.startsWith("MOD "));
    const sounds = SOUND_PARAMETERS.filter((p) => p.name === slot.name && p.page.startsWith("MOD "));
    assert.equal(locks.length, 3, `${slot.name}: expected three lock ids`);
    assert.equal(sounds.length, 3, `${slot.name}: expected three sound offsets`);

    for (const l of locks) {
      assert.equal(l.kind, slot.polarity, `${slot.name} lock kind`);
      assert.equal(l.fine ?? false, slot.fine, `${slot.name} lock fine flag`);
    }
    for (const s of sounds) {
      assert.equal(s.encoding, slot.fine ? "fine" : slot.polarity, `${slot.name} sound encoding`);
    }
  }
});

test("FADE is the only bipolar slot without a fine byte", () => {
  /*
   * Pinned because something outside this repository is reasoning from it: the firmware session is
   * asking why `FADE` draws a widget the other controls do not, and no predicate naming its ids
   * has been found in four scans. If this uniqueness ever stops holding, that lead dies with it.
   */
  const unique = LFO_SLOTS.filter((s) => s.polarity === "bipolar" && !s.fine);
  assert.deepEqual(unique.map((s) => s.name), ["FADE"]);
  assert.equal(lfoSlot("DEP")!.fine, true, "DEP is bipolar too, and is fine — which is the contrast");
});
