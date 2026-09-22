import assert from "node:assert/strict";
import { test } from "node:test";
import { allocate } from "@noiseandmatter/dnx-core/expand/allocate.js";
import { PERCUSSION_LOW_RULES, matchRule } from "@noiseandmatter/dnx-core/expand/rules.js";
import { byTrigCount, rank } from "@noiseandmatter/dnx-core/expand/ranking.js";
import { encodeTags, type TagName } from "@noiseandmatter/dnx-core/project/tags.js";
import type { PlacementRule, SoundUsage } from "@noiseandmatter/dnx-core/expand/types.js";

let nextSlot = 0;
function sound(name: string, tags: TagName[], trigCount = 1): SoundUsage {
  const tagBits = encodeTags(tags);
  return {
    poolSlot: nextSlot++,
    variant: 0,
    name,
    trigCount,
    patterns: [0],
    sourceTracks: [0],
    tagBits,
    tags,
  };
}

const DESTS = [9, 10, 11, 12, 13, 14, 15, 16];

test("a rule places a sound on its preferred track", () => {
  const kick = sound("KICK A", ["KICK"]);
  const rules: PlacementRule[] = [{ name: "perc", tags: ["KICK"], tracks: [14, 15] }];
  const { assignments } = allocate({ ranked: [kick], destinations: DESTS, rules });

  assert.equal(assignments[0]!.dn2Track, 14);
  assert.equal(assignments[0]!.reason, "rule");
  assert.equal(assignments[0]!.rule?.name, "perc");
});

test("a preferred track that is taken falls through to the next preference, then the pool", () => {
  const a = sound("A", ["KICK"], 10);
  const b = sound("B", ["KICK"], 9);
  const c = sound("C", ["KICK"], 8);
  const rules: PlacementRule[] = [{ name: "perc", tags: ["KICK"], tracks: [14, 15] }];
  const { assignments } = allocate({ ranked: [a, b, c], destinations: DESTS, rules });

  const by = new Map(assignments.map((x) => [x.usage.name, x]));
  assert.equal(by.get("A")!.dn2Track, 14);
  assert.equal(by.get("B")!.dn2Track, 15);
  assert.equal(by.get("C")!.reason, "fallback", "third sound should spill to the free pool");
  assert.ok(DESTS.includes(by.get("C")!.dn2Track));
});

test("rules never cause a drop — a sound with no free preference still gets placed", () => {
  const rules: PlacementRule[] = [{ name: "narrow", tags: ["KICK"], tracks: [9] }];
  const sounds = [sound("K1", ["KICK"], 3), sound("K2", ["KICK"], 2), sound("K3", ["KICK"], 1)];
  const { assignments, overflow } = allocate({ ranked: sounds, destinations: DESTS, rules });

  assert.equal(overflow.length, 0, "nothing should overflow while destinations remain");
  assert.equal(assignments.length, 3);
});

test("a pin beats both rules and ranking", () => {
  const loud = sound("LOUD", ["KICK"], 100);
  const quiet = sound("QUIET", ["KICK"], 1);
  const rules: PlacementRule[] = [{ name: "perc", tags: ["KICK"], tracks: [9] }];
  const pins = new Map([[quiet.poolSlot, 9]]);

  const { assignments } = allocate({
    ranked: rank([loud, quiet], byTrigCount([0, 1, 2, 3])),
    destinations: DESTS,
    rules,
    pins,
  });

  const by = new Map(assignments.map((x) => [x.usage.name, x]));
  assert.equal(by.get("QUIET")!.dn2Track, 9, "the pinned sound must get its track");
  assert.equal(by.get("QUIET")!.reason, "pinned");
  assert.notEqual(by.get("LOUD")!.dn2Track, 9, "the higher-ranked sound must yield to the pin");
});

test("a pin onto an occupied track is ignored rather than displacing the occupant", () => {
  const a = sound("A", ["KICK"]);
  const b = sound("B", ["KICK"]);
  const pins = new Map([
    [a.poolSlot, 12],
    [b.poolSlot, 12],
  ]);
  const { assignments } = allocate({ ranked: [a, b], destinations: DESTS, pins });

  const tracks = assignments.map((x) => x.dn2Track);
  assert.equal(new Set(tracks).size, tracks.length, "no track may be assigned twice");
  assert.equal(assignments.filter((x) => x.reason === "pinned").length, 1);
});

test("mixed sounds resolve by policy, not by rule order", () => {
  // CLAP SM in the real corpus is tagged BRASS and PERCUSSION.
  const clap = sound("CLAP SM", ["BRASS", "PERCUSSION"]);

  const percFirst = matchRule(clap, PERCUSSION_LOW_RULES, "percussive-first");
  assert.equal(percFirst?.name, "percussion low");

  const melFirst = matchRule(clap, PERCUSSION_LOW_RULES, "melodic-first");
  assert.equal(melFirst?.name, "melodic high");

  const none = matchRule(clap, PERCUSSION_LOW_RULES, "none");
  assert.equal(none, undefined, "policy 'none' should leave mixed sounds to the fallback pool");
});

test("an unambiguous sound is unaffected by the mixed policy", () => {
  const kick = sound("BD ROMP", ["KICK", "PERCUSSION"]);
  for (const policy of ["percussive-first", "melodic-first", "none"] as const) {
    assert.equal(matchRule(kick, PERCUSSION_LOW_RULES, policy)?.name, "percussion low", policy);
  }
});

test("an untagged sound matches no rule and lands in the fallback pool", () => {
  const unknown = sound("SOUND 3", []);
  assert.equal(matchRule(unknown, PERCUSSION_LOW_RULES, "percussive-first"), undefined);

  const { assignments } = allocate({
    ranked: [unknown],
    destinations: DESTS,
    rules: PERCUSSION_LOW_RULES,
  });
  assert.equal(assignments[0]!.reason, "fallback");
});

test("candidates beyond capacity overflow rather than being silently dropped", () => {
  const sounds = Array.from({ length: 10 }, (_, i) => sound(`S${i}`, ["KICK"], 10 - i));
  const { assignments, overflow } = allocate({ ranked: sounds, destinations: DESTS });

  assert.equal(assignments.length, 8);
  assert.equal(overflow.length, 2);
  assert.deepEqual(
    overflow.map((o) => o.name),
    ["S8", "S9"],
    "the lowest-ranked candidates should be the ones left behind",
  );
});
