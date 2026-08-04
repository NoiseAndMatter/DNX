import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import { readPattern } from "../src/project/dn1.js";
import { groupByName, groupCandidate, nameKey } from "../src/expand/aggregate.js";
import { byTrigCount, rank } from "../src/expand/ranking.js";
import { corpusPath, requireCorpusFile, DN1_PROJECTS } from "./corpus.js";
import { planExpansion } from "../src/expand/plan.js";
import { destinationsBySound, priorityBySound, routePattern } from "../src/expand/route.js";
import type { SoundUsage } from "../src/expand/types.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

const skip = NO_CORPUS && SKIP_REASON;

function usage(name: string, trigCount: number, poolSlot = 0): SoundUsage {
  return {
    poolSlot,
    variant: 0,
    name,
    trigCount,
    patterns: [0],
    sourceTracks: [0],
    tagBits: 0,
    tags: [],
  };
}

// --- the key ------------------------------------------------------------------------------

test("the key is the first word, uppercased", () => {
  assert.equal(nameKey("HH CLOSED"), "HH");
  assert.equal(nameKey("hh open"), "HH");
  assert.equal(nameKey("  CP  RESO "), "CP");
});

test("the separators Elektron names actually use all split", () => {
  for (const name of ["HH-CLOSED", "HH_OPEN", "HH.DL", "HH/ALT", "HH:X"]) {
    assert.equal(nameKey(name), "HH", `${name} should key on HH`);
  }
});

test("a name with no separator is its own key rather than a prefix", () => {
  // Guessing by prefix length would group CP with CPU, and KICK with KICKDRUM. Those are not
  // obviously the same instrument, and a wrong merge is worse than no merge.
  assert.equal(nameKey("KICKDRUM"), "KICKDRUM");
  assert.notEqual(nameKey("CPU"), nameKey("CP"));
});

test("a name that cannot group returns undefined", () => {
  assert.equal(nameKey(""), undefined);
  assert.equal(nameKey("   "), undefined);
});

// --- grouping -----------------------------------------------------------------------------

test("sounds sharing a first word become one group", () => {
  const groups = groupByName([
    usage("HH CLOSED", 40, 1),
    usage("CP RESO", 30, 2),
    usage("HH OPEN", 20, 3),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.key), ["HH", "CP"]);
  assert.equal(groups[0]!.members.length, 2);
});

test("group order follows the ranking it was given", () => {
  // Input arrives ranked, so allocation order is unchanged by aggregation — the family with
  // the strongest member still gets first pick of the tracks.
  const groups = groupByName([usage("CP A", 90, 1), usage("HH A", 50, 2), usage("CP B", 10, 3)]);
  assert.deepEqual(groups.map((g) => g.key), ["CP", "HH"]);
  assert.equal(groups[0]!.members[0]!.name, "CP A", "the leader must be the highest-ranked");
});

test("unnameable sounds never merge, least of all with each other", () => {
  const groups = groupByName([usage("", 10, 1), usage("   ", 5, 2)]);
  assert.equal(groups.length, 2, "two nameless sounds are not one family");
});

test("a group candidate sums trigs and unions its members' reach", () => {
  const a = { ...usage("HH A", 40, 1), patterns: [0, 1], sourceTracks: [0] };
  const b = { ...usage("HH B", 25, 2), patterns: [1, 5], sourceTracks: [2] };
  const candidate = groupCandidate({ key: "HH", members: [a, b] });

  assert.equal(candidate.trigCount, 65);
  assert.deepEqual(candidate.patterns, [0, 1, 5]);
  assert.deepEqual(candidate.sourceTracks, [0, 2]);
  assert.equal(candidate.name, "HH");
  assert.equal(candidate.poolSlot, a.poolSlot, "identity stays the leader's, not a synthetic one");
});

test("a group of one is returned untouched", () => {
  const only = usage("HH A", 40, 1);
  assert.equal(groupCandidate({ key: "HH", members: [only] }), only);
});

test("tags come from the leader, not the union", () => {
  // Unioning would make a group match placement rules that none of its members match.
  const leader = { ...usage("HH A", 40, 1), tagBits: 0b001, tags: ["PERCUSSION" as never] };
  const other = { ...usage("HH B", 5, 2), tagBits: 0b110, tags: ["BASS" as never] };
  const candidate = groupCandidate({ key: "HH", members: [leader, other] });
  assert.equal(candidate.tagBits, leader.tagBits);
  assert.deepEqual(candidate.tags, leader.tags);
});

// --- planning -----------------------------------------------------------------------------

function dn1(name: string): Uint8Array {
  const path = `${CORPUS}01_DN1/01_Projects/${name}.dnprj`;
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

test("aggregation is off by default, so nothing changes unasked", { skip }, () => {
  const plan = planExpansion(dn1("050 JAGGED"));
  assert.ok(plan.assignments.every((a) => a.groupMembers === undefined));
  assert.equal(priorityBySound(plan).size, 0, "no priority map means routing is untouched");
});

test("aggregation promotes more of a heavily-locked project", { skip }, () => {
  // 050 JAGGED locks 31 sounds into 8 tracks. Grouping HH, SD, BD, CP and RS turns
  // 23 overflowing sounds into 7.
  const image = dn1("050 JAGGED");
  const plain = planExpansion(image);
  const grouped = planExpansion(image, { aggregateByName: true });

  assert.ok(
    grouped.promotedTrigs > plain.promotedTrigs,
    `expected more trigs promoted, got ${grouped.promotedTrigs} vs ${plain.promotedTrigs}`,
  );
  assert.ok(grouped.overflow.length < plain.overflow.length);
  assert.ok(
    grouped.assignments.some((a) => (a.groupMembers?.length ?? 0) > 1),
    "at least one track should carry a family",
  );
});

test("every member of a group routes to the group's track", { skip }, () => {
  const plan = planExpansion(dn1("050 JAGGED"), { aggregateByName: true });
  const destinations = destinationsBySound(plan);

  for (const assignment of plan.assignments) {
    for (const member of assignment.groupMembers ?? []) {
      for (const source of member.sourceTracks) {
        assert.equal(
          destinations.get(`${member.poolSlot}@${source}`),
          assignment.dn2Track - 1,
          `${member.name} should route to its group's track`,
        );
      }
    }
  }
});

test("a group that misses out sends every member to overflow", { skip }, () => {
  // Reporting only the leader would understate what stayed behind.
  const plan = planExpansion(dn1("050 JAGGED"), { aggregateByName: true });
  const promoted = new Set(
    plan.assignments.flatMap((a) => (a.groupMembers ?? [a.usage]).map((u) => u.poolSlot)),
  );
  for (const over of plan.overflow) {
    assert.ok(!promoted.has(over.poolSlot), `${over.name} is both promoted and overflowing`);
  }
});

// --- clashes ------------------------------------------------------------------------------

test("a clashing trig stays put with its lock intact, and is reported", { skip }, () => {
  // 001 PRESETS is the corpus project where families genuinely contend for steps.
  const image = dn1("001 PRESETS");
  const plan = planExpansion(image, { aggregateByName: true });
  const destinations = destinationsBySound(plan);
  const priority = priorityBySound(plan);

  let blocked = 0;
  let moved = 0;
  for (const p of plan.livePatterns) {
    const routing = routePattern(readPattern(image, p), destinations, priority);
    blocked += routing.blocked.length;
    moved += routing.moved;

    for (const held of routing.blocked) {
      // The whole point: held back means unchanged, not dropped.
      const entry = routing.routed.find((r) => r.trig === held.trig)!;
      assert.equal(entry.destinationTrack, held.sourceTrack, "a blocked trig must not move");
      assert.equal(entry.clearSoundLock, false, "a blocked trig must keep its sound lock");
      assert.notEqual(held.heldByPoolSlot, held.trig.soundLock, "a sound cannot block itself");
    }
  }

  assert.ok(blocked > 0, "this project should produce clashes worth testing");
  assert.ok(moved > blocked * 5, "clashes should be the rare case, not the common one");
});

test("no two sounds share a step on a destination once routed", { skip }, () => {
  const image = dn1("050 JAGGED");
  const plan = planExpansion(image, { aggregateByName: true });
  const destinations = destinationsBySound(plan);
  const priority = priorityBySound(plan);

  for (const p of plan.livePatterns) {
    const routing = routePattern(readPattern(image, p), destinations, priority);
    for (const [track, bucket] of routing.byDestination) {
      const owner = new Map<number, number>();
      for (const entry of bucket) {
        if (!entry.clearSoundLock) continue;
        const existing = owner.get(entry.trig.step);
        const slot = entry.trig.soundLock!;
        if (existing !== undefined) {
          assert.equal(existing, slot, `two sounds on track ${track} step ${entry.trig.step}`);
        }
        owner.set(entry.trig.step, slot);
      }
    }
  }
});

test("the same sound merged from several source tracks still coincides", { skip }, () => {
  // Clash resolution must not break the existing legitimate case: one sound locked on two
  // source tracks and merged onto one destination is meant to land on the same step, and
  // findCollisions decides whether it can be expressed as one trig.
  const image = dn1("050 JAGGED");
  const plan = planExpansion(image, { aggregateByName: true });
  const routing = routePattern(
    readPattern(image, plan.livePatterns[0]!),
    destinationsBySound(plan),
    priorityBySound(plan),
  );
  for (const held of routing.blocked) {
    assert.notEqual(held.heldByPoolSlot, held.trig.soundLock);
  }
});

// --- ranking a group by what it is worth ---------------------------------------------------

test("a group outranks a single sound its members would each lose to", () => {
  // Reported from the instrument: two two-trig hi-hats stayed sound-locked while a single two-trig
  // sound took the last track. `groupCandidate` had always summed the counts — but the candidates
  // reached the allocator in the order their *leaders* had been ranked individually, so a group
  // worth four sat behind four singles worth two.
  const order: number[] = [];
  const ranked = rank(
    [usage("PUSH WEIGHT", 2, 1), usage("HH TINNY", 2, 2), usage("HH NOISY", 2, 3)],
    byTrigCount(order),
  );
  const candidates = groupByName(ranked).map(groupCandidate);

  const hh = candidates.find((c) => c.name === "HH")!;
  assert.equal(hh.trigCount, 4, "the group is worth both its members");

  // The fix: rank again once the counts have changed. Ranking asks which promotion frees the most
  // trigs, and after grouping the answer is the total.
  const reranked = rank(candidates, byTrigCount(order));
  assert.equal(reranked[0]!.name, "HH", "the group must be offered a track before the single");
});

test("the reported case: HH beats PUSH WEIGHT for the last track", { skip }, () => {
  // The whole path, on the project it was found in: eight patterns of `005 SEA_GROOVE`, aggregate
  // by name, eight destination tracks and fourteen candidates for them.
  const image = decodeProjectImage(
    parseProject(new Uint8Array(readFileSync(requireCorpusFile(DN1_PROJECTS, "005 SEA_GROOVE.dnprj")))).payload.raw,
  ).image;
  const patterns = [0, 2, 3, 4, 8, 10, 14, 15];

  const plan = planExpansion(image, { aggregateByName: true, useFreedMidiTracks: false, patterns });
  const promoted = plan.assignments.map((a) => a.usage.name);

  assert.ok(promoted.includes("HH"), `HH should have a track, got ${promoted.join(", ")}`);
  assert.ok(
    plan.overflow.some((u) => u.name === "PUSH WEIGHT"),
    "PUSH WEIGHT is worth two trigs against the group's four, so it is the one that waits",
  );
  // The point of the exercise, in one number: two more trigs reach a track of their own.
  assert.equal(plan.promotedTrigs, 92);
  assert.equal(plan.overflowTrigs, 9);
});