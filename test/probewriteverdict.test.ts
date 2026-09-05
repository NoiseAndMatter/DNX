/**
 * What a write verdict says.
 *
 * These are the only sentences in DNX that are **instructions to somebody holding an instrument
 * with their work on it** — whether to write again, whether anything was lost, whether to stop.
 * Everything else the probe reports is an observation.
 *
 * Both halves of this were written out twice, once per write path, and the copies had drifted:
 * different wording for the same rule, and — the part that mattered — **two different ways of
 * detecting a hidden tab**, one of which string-matched a row produced by `timing.ts`. Renaming
 * that row would have silently stopped the warning appearing, with nothing failing and nobody
 * noticing until somebody drew the wrong conclusion from a throttled timer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeWrite,
  unverifiedMeans,
  writeOutcome,
} from "../web/src/probe/writeverdict.js";

/* ---- unverified is not failed ---------------------------------------------------------- */

test("an unverified write is never described as a failure", () => {
  /*
   * **The distinction the whole sentence exists for.** A write that landed and whose reply was slow
   * looks exactly like a write that did nothing. Reading the first as the second invites a second
   * write, and a second write is the one thing worth avoiding while the first is unaccounted for.
   */
  for (const listening of [true, false]) {
    const said = unverifiedMeans(0, listening);
    assert.match(said, /^unverified is not the same as failed/);
    assert.match(said, /may well have landed/);
    // Counted rather than pattern-matched: the point is that the word appears exactly once and
    // that the once is the denial. A lookahead here reads as if it says that and does not.
    assert.equal((said.match(/fail/gi) ?? []).length, 1,
      "'fail' must appear only in the clause denying it");
  }
});

test("only the path that keeps listening promises the card will update", () => {
  // A real difference between the two write paths, not drift: one keeps a late-reply handler and
  // the other does not, so only one of them can promise anything.
  assert.match(unverifiedMeans(0, true), /Still listening — if it arrives this card updates\./);
  assert.match(unverifiedMeans(0, false), /Read the project again and compare\./);
  assert.doesNotMatch(unverifiedMeans(0, false), /Still listening/);
});

test("a hidden tab names the browser as the likelier suspect", () => {
  /*
   * A browser throttles timers in a background tab, so the wait that gave up may have been far
   * longer than its timeout claims. Without this the reader has a timeout and a hidden-tab row
   * sitting side by side and no statement that one explains the other.
   */
  const said = unverifiedMeans(4200, true);
  assert.match(said, /tab was hidden during this wait/);
  assert.match(said, /very likely the browser rather than the instrument/);
  assert.match(said, /Repeat it with the tab in view\./);
});

test("a visible tab earns no clause at all", () => {
  // Said only when it happened. A note about background throttling on a write that was watched the
  // whole time is noise in the one place noise is most expensive.
  assert.doesNotMatch(unverifiedMeans(0, true), /hidden/);
});

test("any hidden time at all earns the clause, not just a long one", () => {
  /*
   * There is no threshold and there should not be one: the point is not how long the tab was away,
   * it is that the timer cannot be trusted. Picking a cutoff would mean silently trusting it below
   * that cutoff.
   */
  assert.match(unverifiedMeans(1, true), /tab was hidden/);
});

/* ---- three outcomes, not two ----------------------------------------------------------- */

test("matching what was sent is an overwrite", () => {
  assert.equal(writeOutcome(true, false), "overwritten");
  // Matching both is still an overwrite: writing back what was already there is not a refusal, and
  // there would be no way to tell if it were.
  assert.equal(writeOutcome(true, true), "overwritten");
});

test("matching what was there before is a refusal, not a failure", () => {
  /*
   * **The distinction this function exists for.** A device that overwrote and a device that refused
   * both answer the read and both stay silent about the write itself, so "did not match what we
   * sent" is two completely different situations wearing one label — and one of them is fine.
   */
  assert.equal(writeOutcome(false, true), "refused");
});

test("matching neither is unexpected, which is its own outcome", () => {
  // Something happened this page cannot account for. It must not be folded into "refused", which
  // says the original is intact — the one claim that would be actively dangerous if wrong.
  assert.equal(writeOutcome(false, false), "unexpected");
});

/* ---- what each outcome tells you to do ------------------------------------------------- */

test("a verified write says where it landed, because that is the surprise", () => {
  /*
   * **The line people most need and least expect.** A write lands in the *active project*, not the
   * +Drive: it survives a power cycle and is lost the moment another project is loaded. Somebody
   * who does not know that will power-cycle to be safe and keep the change, or load a project and
   * lose it without knowing why.
   */
  const said = describeWrite("overwritten", { from: "A1", to: "B4" });
  assert.equal(said.level, "ok");
  assert.equal(said.title, "Write VERIFIED — A1 is now in B4");
  assert.match(said.next, /SAVE PROJECT on the device/);
  assert.match(said.next, /active project, not the \+Drive/);
  assert.match(said.next, /to undo it, load another project without saving/);
});

test("a refusal says nothing was lost, and says there is nothing to undo", () => {
  /*
   * The thing the person actually needs to know, and the reason a refusal is a `warn` rather than an
   * `error`: the device protected an occupied slot and their work is untouched.
   */
  const said = describeWrite("refused", { from: "A1", to: "B4" });
  assert.equal(said.level, "warn");
  assert.match(said.title, /REFUSED the write — B4 is unchanged/);
  assert.match(said.result, /still holds exactly what it held before/);
  assert.match(said.result, /nothing was lost/);
  assert.match(said.next, /^Nothing to undo\./);
  assert.match(said.next, /before any bulk operation is built on writes/);
});

test("an unexpected result is an error and says to stop", () => {
  // The only verdict on this page that tells somebody to stop doing things. It must not soften.
  const said = describeWrite("unexpected", { from: "A1", to: "B4", reason: "byte 12 differs" });
  assert.equal(said.level, "error");
  assert.match(said.next, /^Write nothing else until this is understood\./);
  assert.match(said.result, /matches neither what was sent nor what was there: byte 12 differs/);
});

test("an unexpected result still reads when the comparison had no reason to give", () => {
  const said = describeWrite("unexpected", { from: "A1", to: "B4" });
  assert.match(said.result, /matches neither what was sent nor what was there: differs/);
});

test("every outcome carries a status line and a card, and they agree", () => {
  /*
   * Both halves come from one object so the card and the line under it cannot disagree — which they
   * could when each call site wrote them out separately, and twice did.
   */
  const cases = [
    ["overwritten", "ok", /written to B4 and verified/],
    ["refused", "warn", /was not overwritten — the device refused/],
    ["unexpected", "error", /holds something unexpected/],
  ] as const;
  for (const [outcome, level, message] of cases) {
    const said = describeWrite(outcome, { from: "A1", to: "B4" });
    assert.equal(said.level, level);
    assert.match(said.message, message);
    assert.ok(said.title && said.result && said.next, `${outcome} must fill every field`);
  }
});

test("the slot names are used, so a verdict says which slot it is about", () => {
  // A verdict that says "the write was refused" without naming the slot is unusable with sixteen
  // banks on screen.
  const said = describeWrite("refused", { from: "C2", to: "H16" });
  assert.match(said.title, /H16/);
  assert.match(said.message, /H16/);
  assert.doesNotMatch(said.title, /C2/, "a refusal is about the destination, not the source");
});
