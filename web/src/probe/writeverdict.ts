/**
 * What a write verdict says — the highest-stakes prose on this page.
 *
 * Everything else the probe reports is an observation. These are **instructions to somebody holding
 * an instrument with their work on it**: whether to write again, whether anything was lost, whether
 * to stop. Getting the wording wrong here costs more than getting a chart wrong.
 *
 * ## The drift this exists to end
 *
 * The rule *"unverified is not failed"* was written out twice, once per write path, and the two
 * copies had already diverged:
 *
 * | | same-slot write-back | write to a different slot |
 * |---|---|---|
 * | wording | "unverified is not the same as failed…" | "unverified is not failed. Read the project again and compare." |
 * | hidden-tab test | `log.some(([what]) => what === "Tab was hidden")` | `hidden.hiddenMs > 0` |
 * | wording of the clause | "hidden during this **wait**" | "hidden during this **write**" |
 *
 * The second row is the one that mattered. **One path detected a hidden tab by string-matching a
 * row another module had produced**, so renaming that row in `timing.ts` would have silently
 * stopped the warning appearing — with nothing failing and nobody noticing until somebody drew the
 * wrong conclusion from a throttled timer. It is a measurement, so it is taken from the
 * measurement.
 *
 * This is `silence.ts`'s story again: a rule applied at several call sites is a rule that will be
 * applied at all but one of them.
 *
 * ## What is *not* unified, and why
 *
 * The same-slot path writes bytes back to the slot it read them from, so a device that overwrote
 * and a device that refused leave **identical** content behind. It genuinely cannot tell those
 * apart, and pretending otherwise would be worse than the two-outcome verdict it gives. Only the
 * different-slot path has a `before` to hold the answer against, which is why only it gets
 * `writeOutcome`.
 */

/**
 * Why a write has not been verified, said so nobody concludes it failed.
 *
 * **"Unverified" and "failed" are different claims and the difference is expensive.** A write that
 * landed and whose reply was slow looks exactly like a write that did nothing; treating the first as
 * the second invites somebody to write again, and a second write is the thing worth avoiding while
 * the first is unaccounted for.
 *
 * `hiddenMs` comes from the visibility watcher rather than from the log, so this cannot be silently
 * disabled by renaming a row. Any non-zero value earns the clause: a browser throttles timers in a
 * background tab, so the wait that gave up may have been far longer than its timeout claims, and
 * that makes the browser the likelier suspect than the instrument.
 *
 * `stillListening` is a real difference between the two paths, not drift: one keeps a late-reply
 * handler that will update the card if the answer arrives, and the other does not, so only one of
 * them can promise anything.
 */
export function unverifiedMeans(hiddenMs: number, stillListening: boolean): string {
  return (
    "unverified is not the same as failed. The write may well have landed; the reply may simply be " +
    "slower than the wait. " +
    (stillListening
      ? "Still listening — if it arrives this card updates."
      : "Read the project again and compare.") +
    (hiddenMs > 0
      ? " The tab was hidden during this wait, which throttles the timer that gave up — so this is " +
        "very likely the browser rather than the instrument. Repeat it with the tab in view."
      : "")
  );
}

/**
 * What happened to a slot that was written to and then read back.
 *
 * **Three outcomes, not two.** A device that overwrote the slot and a device that refused the write
 * both answer the read and both stay silent about the write itself, so *"did not match what we
 * sent"* is not a diagnosis — it is two completely different situations wearing one label. Held
 * against what the slot contained **before**, the answer is unambiguous, and on a refusal it also
 * says the original is intact, which is the thing the person actually needs to know.
 *
 * `unexpected` is the case worth having a name for: the slot matches neither what was sent nor what
 * was there. Something happened that this page cannot account for, and that is a stop.
 */
export type WriteOutcome = "overwritten" | "refused" | "unexpected";

export function writeOutcome(matchesSent: boolean, matchesBefore: boolean): WriteOutcome {
  if (matchesSent) return "overwritten";
  return matchesBefore ? "refused" : "unexpected";
}

/** The card and status line for one outcome. Both from one object, so they cannot disagree. */
export interface WriteVerdict {
  title: string;
  /** What the read-back showed. */
  result: string;
  /** What to do now — including, for a refusal, that there is nothing to undo. */
  next: string;
  /** One line for the status bar. */
  message: string;
  level: "ok" | "warn" | "error";
}

/**
 * Describe an outcome, given the slots involved.
 *
 * `from` and `to` are how the page names the source and destination; `reason` is the comparison's
 * own explanation, used only when nothing matches and there is nothing better to say.
 *
 * The `Next` line for a successful write is the one people most need and least expect: **a write
 * lands in the active project, not the +Drive.** It survives a power cycle and is lost the moment
 * another project is loaded — which is also how it is undone.
 */
export function describeWrite(
  outcome: WriteOutcome,
  { from, to, reason }: { from: string; to: string; reason?: string },
): WriteVerdict {
  if (outcome === "overwritten") {
    return {
      title: `Write VERIFIED — ${from} is now in ${to}`,
      result: "the device returned exactly what was sent",
      next:
        "SAVE PROJECT on the device to keep this. A write lands in the active project, not the " +
        "+Drive — it survives a power cycle but is lost the moment another project is loaded. " +
        "Which also means: to undo it, load another project without saving.",
      message: `${from} written to ${to} and verified.`,
      level: "ok",
    };
  }
  if (outcome === "refused") {
    return {
      title: `Device REFUSED the write — ${to} is unchanged`,
      result:
        `${to} still holds exactly what it held before — the device declined the write, ` +
        `silently, and nothing was lost`,
      next:
        "Nothing to undo. The device protects occupied slots, which is worth knowing before any " +
        "bulk operation is built on writes.",
      message: `${to} was not overwritten — the device refused.`,
      level: "warn",
    };
  }
  return {
    title: "Write did NOT match, and neither does the original",
    result: `matches neither what was sent nor what was there: ${reason ?? "differs"}`,
    next:
      "Write nothing else until this is understood. Load another project without saving to " +
      "discard whatever happened.",
    message: `${to} holds something unexpected.`,
    level: "error",
  };
}
